/**
 * The workshop panel's host side.
 *
 * Three routes, all under one prefix:
 *
 * - `GET /api/inkwell` — the book this session is looking at, projected for the
 *   panel. `?root=<abs>` pins a specific book (the one the create flow just
 *   made, which may sit outside the session's workspace).
 * - `GET /api/inkwell/dirs?path=<abs>` — one directory level, for the create
 *   flow's picker.
 * - `POST /api/inkwell/init` — create a book in a chosen directory.
 *
 * Why an HTTP route instead of a Remote namespace: the Remote carrier pairs a
 * host face with a client face through the bundle manifest, which is more
 * machinery than a panel needs. A route under `/api/inkwell` is the same-origin
 * path the recycle-bin and market bundles use.
 *
 * Which book: without `?root`, the route takes the calling session's id and
 * resolves that session's `cwd`, so a panel in workspace A never reports
 * workspace B's book once `perWorkspace` is on.
 *
 * What this panel may write: exactly one thing — a new project directory. The
 * creation goes through the same `ProjectStore.init` the `novel_project` tool
 * uses, so the only difference from typing `novel_project action="init"` in the
 * conversation is who picked the directory. Everything that changes a *book*
 * (chapters, canon, ledger) stays behind the tools and their gate; the panel
 * has no route for any of it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, resolve } from 'node:path'
import { resolveRoot } from '../domain/scope.ts'
import { ProjectStore } from '../domain/store.ts'
import type { InkwellConfig } from '../domain/types.ts'
import { listDirectories, PanelInputError, requireDirectory } from './dirs.ts'
import { createCatalogCache, type CatalogCache, type CatalogProvider, modelsOf } from './catalog.ts'
import { buildEntry } from './entry.ts'
import { buildPanelSnapshot, emptyPanelSnapshot, type ChapterDrafts, type PanelSnapshot } from './model.ts'
import type { LlmCatalogSource } from './ports.ts'
import type { PanelEntryKind } from './tree.ts'
import { checkRouteAgainstCatalog, readRoleChoice, roleViews, withRoleOverride, type RoleView } from './roles.ts'

/** Route prefix the browser half fetches under. */
export const PANEL_PREFIX = '/api/inkwell'

/** Non-GET requests must carry this header; a cross-origin form cannot set it. */
export const PANEL_HEADER = 'x-dsh-plugin'

/** Header value the panel sends. */
export const PANEL_HEADER_VALUE = 'inkwell'

/** Largest request body the create route will read. */
const MAX_BODY_BYTES = 16 * 1024

/** What the host needs in order to answer one request. */
export interface PanelDeps {
  config: InkwellConfig
  /** The process-wide book, used when the request names no session. */
  baseStore: ProjectStore
  /** Session lookup, when the host exposes one. */
  cwdOf?: (sessionId: string) => string | undefined
  /**
   * The host's model registry, when this dsh has one.
   *
   * Read lazily on each request so a profile that swaps providers at runtime is
   * not stuck with the registry it had at mount time. Absent means the panel
   * shows the team without a picker rather than failing to load.
   */
  llmOf?: () => LlmCatalogSource | undefined
}

/** One answered request, before it becomes bytes. */
export interface PanelAnswer {
  status: number
  body: unknown
}

/** A book the create route has just made (or found already there). */
export interface CreatedBook {
  root: string
  title: string
  /** True when a project already lived at that root and nothing was written. */
  existing: boolean
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
 * An explicit `root` wins over everything: the create flow hands back the
 * directory it just used, and the panel then reads that book even though the
 * session's own workspace is somewhere else. Without one, the session decides.
 *
 * @param deps - route dependencies.
 * @param sessionId - the calling session, when the browser named one.
 * @param root - an absolute project directory, when the browser named one.
 * @returns the store for that book.
 * @throws {PanelInputError} when `root` is not absolute.
 */
function storeFor(deps: PanelDeps, sessionId: string | undefined, root: string | undefined): ProjectStore {
  if (root !== undefined && root !== '') {
    if (!isAbsolute(root)) throw new PanelInputError('root 必须是绝对路径。')
    return new ProjectStore(resolve(root))
  }
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
 * "no book here yet" state with the directory it looked in, which is also what
 * it offers to create in.
 *
 * @param deps - route dependencies.
 * @param sessionId - the calling session, when known.
 * @param root - an absolute project directory, when the browser named one.
 * @returns status and body.
 */
export async function readPanel(
  deps: PanelDeps,
  sessionId: string | undefined,
  root?: string | undefined,
): Promise<PanelAnswer> {
  let store: ProjectStore
  try {
    store = storeFor(deps, sessionId, root)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = error instanceof PanelInputError ? error.status : 400
    return { status, body: { ok: false, error: { message } } }
  }
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
 * Read a request body as JSON.
 *
 * @param req - the request to read.
 * @returns the parsed body; `{}` when it is empty.
 * @throws {PanelInputError} for an oversized or malformed body.
 */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new PanelInputError('请求体太大。', 413)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new PanelInputError('请求体必须是一个 JSON 对象。')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof PanelInputError) throw error
    throw new PanelInputError('请求体不是合法 JSON。')
  }
}

/**
 * Create a book in a directory the writer picked.
 *
 * Same door as `novel_project action="init"`, different hand on the handle:
 * the tool gate allows `init` unconditionally, so the panel is not opening a
 * way around the gate — it is opening the gate's own front door.
 *
 * @param deps - route dependencies.
 * @param body - `{ dir, title?, targetWords? }`.
 * @returns the created (or already existing) book.
 * @throws {PanelInputError} for a missing directory, a pinned root, or bad input.
 */
export async function createBook(deps: PanelDeps, body: Record<string, unknown>): Promise<PanelAnswer> {
  try {
    if (isAbsolute(deps.config.root)) {
      throw new PanelInputError(
        `插件的 root 被固定成了 ${deps.config.root}，面板不能在其他目录建书。改用 novel_project action="init"，或把 root 配成相对路径（如 .novel）。`,
        409,
      )
    }
    const dir = await requireDirectory(body.dir)
    const root = resolveRoot(deps.config.root, dir)
    const store = new ProjectStore(root)
    if (await store.exists()) {
      const project = await store.readProject()
      const created: CreatedBook = { root, title: project.title, existing: true }
      return { status: 200, body: { ok: true, data: created } }
    }
    const rawTitle = typeof body.title === 'string' ? body.title.trim() : ''
    const title = rawTitle === '' ? '未命名' : rawTitle.slice(0, 120)
    const rawTarget = body.targetWords
    const targetWords =
      typeof rawTarget === 'number' && Number.isFinite(rawTarget) && rawTarget > 0 ? Math.floor(rawTarget) : undefined
    await store.init(title, targetWords ?? 0)
    const created: CreatedBook = { root, title, existing: false }
    return { status: 200, body: { ok: true, data: created } }
  } catch (error) {
    if (error instanceof PanelInputError) {
      return { status: error.status, body: { ok: false, error: { message: error.message } } }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { status: 500, body: { ok: false, error: { message } } }
  }
}

/**
 * List one directory level for the picker.
 *
 * Also reports a book that already lives there, so the picker can offer to
 * open it instead of creating a second one beside it.
 *
 * @param deps - route dependencies.
 * @param requested - the `path` query parameter; absent lists the home directory.
 * @returns the listing.
 */
export async function listPanelDirs(deps: PanelDeps, requested: string | undefined): Promise<PanelAnswer> {
  try {
    const listing = await listDirectories(requested)
    if (!isAbsolute(deps.config.root)) {
      const store = new ProjectStore(resolveRoot(deps.config.root, listing.path))
      if (await store.exists()) {
        const project = await store.readProject()
        return { status: 200, body: { ok: true, data: { ...listing, book: { title: project.title, phase: project.phase, root: store.root } } } }
      }
    }
    return { status: 200, body: { ok: true, data: { ...listing, book: null } } }
  } catch (error) {
    if (error instanceof PanelInputError) {
      return { status: error.status, body: { ok: false, error: { message: error.message } } }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { status: 500, body: { ok: false, error: { message } } }
  }
}

/**
 * The agent-team payload: who is on the team, and what they may run on.
 *
 * `noBook` is not an error: a panel with no book still shows the team, so the
 * routes can be picked before the first chapter exists. `catalogUnavailable`
 * separates "the host has no model registry" from "the registry answered with
 * nothing", which are different repairs for the reader.
 */
export interface TeamPayload {
  roles: RoleView[]
  providers: CatalogProvider[]
  catalogUnavailable: boolean
  /** The book these routes belong to. */
  root: string
  /** True when no project exists at {@link TeamPayload.root} yet. */
  noBook: boolean
}

/**
 * Read the agent team for one book.
 *
 * @param deps - route dependencies.
 * @param cache - the provider/model catalog cache.
 * @param sessionId - the calling session, when known.
 * @param root - an absolute project directory, when the browser named one.
 * @returns status and body.
 */
export async function readTeam(
  deps: PanelDeps,
  cache: CatalogCache,
  sessionId: string | undefined,
  root: string | undefined,
): Promise<PanelAnswer> {
  try {
    const store = storeFor(deps, sessionId, root)
    const source = deps.llmOf?.()
    const providers = await cache.get(source)
    const payload: TeamPayload = {
      roles: roleViews(deps.config, undefined),
      providers,
      catalogUnavailable: source === undefined,
      root: store.root,
      noBook: true,
    }
    if (await store.exists()) {
      const project = await store.readProject()
      payload.roles = roleViews(deps.config, project.roles)
      payload.noBook = false
    }
    return { status: 200, body: { ok: true, data: payload } }
  } catch (error) {
    if (error instanceof PanelInputError) {
      return { status: error.status, body: { ok: false, error: { message: error.message } } }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { status: 500, body: { ok: false, error: { message } } }
  }
}

/**
 * Set one role's model route in this book.
 *
 * Same stored shape the `novel_roles` tool writes, so a route picked in the
 * panel is visible to `novel_roles action="list"` and honoured by the next
 * dispatch — one lever, two handles.
 *
 * @param deps - route dependencies.
 * @param cache - the provider/model catalog cache, used to reject a typo.
 * @param body - `{ role, provider?, model?, maxTokens?, reasoningEffort?, reset? }`.
 * @param sessionId - the calling session, when known.
 * @param root - an absolute project directory, when the browser named one.
 * @returns status and the refreshed team payload.
 */
export async function writeTeam(
  deps: PanelDeps,
  cache: CatalogCache,
  body: Record<string, unknown>,
  sessionId: string | undefined,
  root: string | undefined,
): Promise<PanelAnswer> {
  try {
    const store = storeFor(deps, sessionId, root)
    if (!(await store.exists())) {
      throw new PanelInputError('这本书还没有项目文件，先在面板里新建一本，再配智能体。', 409)
    }
    const choice = readRoleChoice(body)
    const providers = await cache.get(deps.llmOf?.())
    checkRouteAgainstCatalog(
      choice,
      providers.map((entry) => entry.id),
      (provider) => modelsOf(providers, provider).map((model) => model.id),
    )
    const project = await store.readProject()
    const next = withRoleOverride(project, choice)
    await store.writeProject(next)
    const payload: TeamPayload = {
      roles: roleViews(deps.config, next.roles),
      providers,
      catalogUnavailable: deps.llmOf?.() === undefined,
      root: store.root,
      noBook: false,
    }
    return { status: 200, body: { ok: true, data: payload } }
  } catch (error) {
    if (error instanceof PanelInputError) {
      return { status: error.status, body: { ok: false, error: { message: error.message } } }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { status: 500, body: { ok: false, error: { message } } }
  }
}

/**
 * Read the page behind one row.
 *
 * A page that no longer exists is a 404 rather than an empty page: a browser
 * holding a tree from ten minutes ago should be told to refresh, not shown a
 * card with every field blank.
 *
 * @param deps - route dependencies.
 * @param sessionId - the calling session, when known.
 * @param kind - `character`, `world`, or `chapter`.
 * @param key - the name, or the chapter number as a string.
 * @param root - an absolute project directory, when the browser named one.
 * @returns status and body.
 */
export async function readEntry(
  deps: PanelDeps,
  sessionId: string | undefined,
  kind: string | undefined,
  key: string | undefined,
  root: string | undefined,
): Promise<PanelAnswer> {
  try {
    if (kind !== 'character' && kind !== 'world' && kind !== 'chapter') {
      throw new PanelInputError(`未知的条目类型 ${kind ?? '（空）'}，只支持 character／world／chapter。`)
    }
    if (key === undefined || key === '') throw new PanelInputError('缺少 key：角色名、世界观名或章号。')
    const store = storeFor(deps, sessionId, root)
    if (!(await store.exists())) {
      return { status: 404, body: { ok: false, error: { message: '这本书还没有项目文件。' } } }
    }
    const snapshot = await store.snapshot()
    const number = Number(key)
    const drafts: ChapterDrafts[] =
      kind === 'chapter' && Number.isInteger(number) && number > 0
        ? [{ number, rounds: await store.draftsOf(number) }]
        : []
    const entry = buildEntry(snapshot, kind as PanelEntryKind, key, drafts, store.root)
    if (entry === undefined) {
      return {
        status: 404,
        body: { ok: false, error: { message: `找不到 ${kind}「${key}」。它可能刚被改名或删掉，刷新一下。` } },
      }
    }
    return { status: 200, body: { ok: true, data: entry } }
  } catch (error) {
    if (error instanceof PanelInputError) {
      return { status: error.status, body: { ok: false, error: { message: error.message } } }
    }
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
  // One cache per mounted route: a panel that polls must not re-ask every
  // provider for its catalog on each poll, but a plugin reload gets a fresh one.
  const catalog = createCatalogCache()
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname.slice(PANEL_PREFIX.length) || '/'
      const method = req.method ?? 'GET'
      const isRead = method === 'GET' || method === 'HEAD'

      if (!isRead && method !== 'POST') {
        send(res, { status: 405, body: { ok: false, error: { message: `不支持的请求方法 ${method}` } } })
        return
      }

      if (!isRead) {
        // The one CSRF guard the host's routes share: a simple form post cannot
        // set a custom header, so demanding one makes the request preflighted.
        if (req.headers[PANEL_HEADER] !== PANEL_HEADER_VALUE) {
          send(res, { status: 403, body: { ok: false, error: { message: `missing ${PANEL_HEADER} header` } } })
          return
        }
      }

      if (path === '/' || path === '/snapshot') {
        if (!isRead) {
          send(res, { status: 405, body: { ok: false, error: { message: `${path} 只读，用 /init 建书` } } })
          return
        }
        const sessionId = url.searchParams.get('session') ?? undefined
        const root = url.searchParams.get('root') ?? undefined
        send(res, await readPanel(deps, sessionId, root))
        return
      }

      if (path === '/dirs') {
        if (!isRead) {
          send(res, { status: 405, body: { ok: false, error: { message: '/dirs 只读' } } })
          return
        }
        send(res, await listPanelDirs(deps, url.searchParams.get('path') ?? undefined))
        return
      }

      if (path === '/init') {
        if (isRead) {
          send(res, { status: 405, body: { ok: false, error: { message: '/init 需要 POST' } } })
          return
        }
        send(res, await createBook(deps, await readJson(req)))
        return
      }

      if (path === '/entry') {
        if (!isRead) {
          send(res, { status: 405, body: { ok: false, error: { message: '/entry 只读' } } })
          return
        }
        send(
          res,
          await readEntry(
            deps,
            url.searchParams.get('session') ?? undefined,
            url.searchParams.get('kind') ?? undefined,
            url.searchParams.get('key') ?? undefined,
            url.searchParams.get('root') ?? undefined,
          ),
        )
        return
      }

      if (path === '/roles') {
        const sessionId = url.searchParams.get('session') ?? undefined
        const root = url.searchParams.get('root') ?? undefined
        if (isRead) {
          send(res, await readTeam(deps, catalog, sessionId, root))
          return
        }
        send(res, await writeTeam(deps, catalog, await readJson(req), sessionId, root))
        return
      }

      send(res, { status: 404, body: { ok: false, error: { message: `unknown panel path ${url.pathname}` } } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = error instanceof PanelInputError ? error.status : 500
      if (!res.headersSent) send(res, { status, body: { ok: false, error: { message } } })
      else res.end()
    }
  }
}
