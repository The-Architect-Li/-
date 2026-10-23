/**
 * The workshop panel's host side.
 *
 * One prefix route, two verbs, no state: the browser asks "what is this
 * session's book?" and gets the projection from {@link buildPanelSnapshot}.
 *
 * Why an HTTP route instead of a Remote namespace: the Remote carrier pairs a
 * host face with a client face through the bundle manifest, which is more
 * machinery than a read-only panel needs. A route under `/api/inkwell` is the
 * same-origin path the recycle-bin and market bundles use, and it needs no
 * client-side contract package.
 *
 * Which book: the route takes the calling session's id and resolves that
 * session's `cwd`, so a panel in workspace A never reports workspace B's book
 * once `perWorkspace` is on. Without the query parameter it falls back to the
 * process-wide store — the v0.2 behaviour.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolveRoot } from '../domain/scope.ts'
import { ProjectStore } from '../domain/store.ts'
import type { InkwellConfig } from '../domain/types.ts'
import { buildPanelSnapshot, emptyPanelSnapshot, type ChapterDrafts, type PanelSnapshot } from './model.ts'

/** Route prefix the browser half fetches under. */
export const PANEL_PREFIX = '/api/inkwell'

/** Non-GET requests must carry this header; a cross-origin form cannot set it. */
export const PANEL_HEADER = 'x-dsh-plugin'

/** Header value the panel sends. */
export const PANEL_HEADER_VALUE = 'inkwell'

/** What the host needs in order to answer one request. */
export interface PanelDeps {
  config: InkwellConfig
  /** The process-wide book, used when the request names no session. */
  baseStore: ProjectStore
  /** Session lookup, when the host exposes one. */
  cwdOf?: (sessionId: string) => string | undefined
}

/** One answered request, before it becomes bytes. */
export interface PanelAnswer {
  status: number
  body: unknown
}

/**
 * Read every chapter's draft rounds.
 *
 * Reading the whole draft directory per chapter would be wasteful on a long
 * book, so this is bounded: the panel only needs round counts and the newest
 * round's findings, and a chapter with more than {@link MAX_DRAFT_READS}
 * rounds is represented by its newest that many.
 *
 * @param store - the book.
 * @param numbers - chapter numbers to read.
 * @returns one entry per chapter that has at least one round.
 */
async function readDrafts(store: ProjectStore, numbers: readonly number[]): Promise<ChapterDrafts[]> {
  const out: ChapterDrafts[] = []
  for (const number of numbers) {
    const rounds = await store.draftsOf(number)
    if (rounds.length > 0) out.push({ number, rounds })
  }
  return out
}

/**
 * Resolve the book a request is about.
 *
 * @param deps - route dependencies.
 * @param sessionId - the calling session, when the browser named one.
 * @returns the store for that book.
 */
function storeFor(deps: PanelDeps, sessionId: string | undefined): ProjectStore {
  if (!deps.config.perWorkspace) return deps.baseStore
  if (sessionId === undefined || deps.cwdOf === undefined) return deps.baseStore
  const cwd = deps.cwdOf(sessionId)
  if (cwd === undefined) return deps.baseStore
  return new ProjectStore(resolveRoot(deps.config.root, cwd))
}

/**
 * Build the payload for one GET.
 *
 * Absence of a project is a normal answer, not an error: the panel shows its
 * "no book here yet" state with the directory it looked in.
 *
 * @param deps - route dependencies.
 * @param sessionId - the calling session, when known.
 * @returns status and body.
 */
export async function readPanel(deps: PanelDeps, sessionId: string | undefined): Promise<PanelAnswer> {
  const store = storeFor(deps, sessionId)
  try {
    if (!(await store.exists())) {
      const empty: PanelSnapshot = emptyPanelSnapshot(store.root)
      return { status: 200, body: { ok: true, data: empty } }
    }
    const snapshot = await store.snapshot()
    const numbers = new Set<number>()
    for (const chapter of snapshot.chapters) numbers.add(chapter.number)
    for (const plan of snapshot.plans) numbers.add(plan.number)
    const drafts = await readDrafts(store, [...numbers].sort((a, b) => a - b))
    const data = buildPanelSnapshot(snapshot, deps.config, drafts, store.root)
    return { status: 200, body: { ok: true, data } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 500, body: { ok: false, error: { message } } }
  }
}

/**
 * Write a JSON answer with no-store caching.
 *
 * @param res - the response to own.
 * @param answer - status and body.
 */
function send(res: ServerResponse, answer: PanelAnswer): void {
  const payload = JSON.stringify(answer.body)
  res.writeHead(answer.status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Build the route handler.
 *
 * @param deps - route dependencies.
 * @returns a handler owning the full response for every request under the prefix.
 */
export function createPanelHandler(deps: PanelDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname.slice(PANEL_PREFIX.length) || '/'
      if (path !== '/' && path !== '/snapshot') {
        send(res, { status: 404, body: { ok: false, error: { message: `unknown panel path ${url.pathname}` } } })
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // The one CSRF guard the host's routes share: a simple form post cannot
        // set a custom header, so demanding one makes the request preflighted.
        if (req.headers[PANEL_HEADER] !== PANEL_HEADER_VALUE) {
          send(res, { status: 403, body: { ok: false, error: { message: `missing ${PANEL_HEADER} header` } } })
          return
        }
        send(res, { status: 405, body: { ok: false, error: { message: 'the panel is read-only' } } })
        return
      }
      const sessionId = url.searchParams.get('session') ?? undefined
      send(res, await readPanel(deps, sessionId))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) send(res, { status: 500, body: { ok: false, error: { message } } })
      else res.end()
    }
  }
}
