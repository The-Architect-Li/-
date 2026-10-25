/**
 * The workshop panel's host side.
 *
 * Every route lives under one prefix:
 *
 * - `GET /api/inkwell` — the book this session is looking at, projected for the
 *   panel. `?root=<abs>` pins a specific book (the one the create flow just
 *   made, which may sit outside the session's workspace).
 * - `GET /api/inkwell/dirs?path=<abs>` — one directory level, for the create
 *   flow's picker.
 * - `POST /api/inkwell/init` — create a book in a chosen directory.
 * - `GET /api/inkwell/entry?kind=&key=` — the page behind one row.
 * - `POST /api/inkwell/entry` — save an edit to a character, world entry, or
 *   chapter body.
 * - `GET|POST /api/inkwell/roles` — the agent team, and each role's model.
 * - `POST /api/inkwell/pin` — bind one session to one book, so the chat session
 *   the create flow just opened starts on the book it was opened for.
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
 * What this panel may write: three doors — a new project directory, a role's
 * model route, and the body of one character/setting/chapter. None of them is a
 * way around a rule: creation is `ProjectStore.init` (the gate allows `init`
 * unconditionally), the chapter body runs the same `gateToolCall` and
 * `saveChapterBody` the conversation does, and canon edits are what `novel_canon`
 * writes. What the panel still cannot do is anything the tools can only do with
 * judgement: advance a phase, approve an outline, commit a draft, or record a
 * ledger fact. Those stay conversation-only on purpose — each one is a decision
 * someone should have to argue for in words.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, resolve } from 'node:path'
import { applyImport } from '../domain/import-apply.ts'
import { planImport } from '../domain/import-scan.ts'
import { describeScan, isDirectory, readSources, summarize } from '../domain/manuscript.ts'
import { ChapterBlockedError, saveChapterBody } from '../domain/save.ts'
import { ChapterConflictError } from '../domain/store.ts'
import { resolveRoot } from '../domain/scope.ts'
import { ProjectStore } from '../domain/store.ts'
import type { CharacterCard, Finding, InkwellConfig } from '../domain/types.ts'
import { gateToolCall } from '../gate.ts'
import { listDirectories, PanelInputError, requireDirectory } from './dirs.ts'
import { createCatalogCache, type CatalogCache, type CatalogProvider, modelsOf } from './catalog.ts'
import { readChapterPatch, readCharacterPatch, readWorldPatch } from './edit.ts'
import { bookKey, describeBook, libraryFile, readShelf, rememberBook, type LibraryBook } from '../domain/shelf.ts'
import { pinBook, pinnedRoot, sessionsFile } from '../domain/session-books.ts'
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

/**
 * Largest body the edit route will read.
 *
 * A chapter body is the biggest legitimate payload: {@link MAX_CHAPTER_CHARS}
 * characters of CJK is roughly 600 KB on the wire, so this leaves room and still
 * refuses an upload that is clearly not a chapter.
 */
const MAX_WRITE_BYTES = 1024 * 1024

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
 * Three layers, most specific first: an explicit `root` from the browser (the
 * create flow hands back the directory it just used), the session's own pin, and
 * finally the session's workspace. The pin sits above the workspace so the chat
 * session the create flow opened shows the book it was opened for even before any
 * workspace setting applies — and so this route and `storeFor` in the tool layer
 * answer with the same book, which they must: the panel and the conversation
 * edit the same files.
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
  if (sessionId !== undefined && sessionId !== '') {
    const pinned = pinnedRoot(sessionsFile(), sessionId)
    if (pinned !== undefined) return new ProjectStore(pinned)
  }
  if (!deps.config.perWorkspace) return deps.baseStore
  if (sessionId === undefined || deps.cwdOf === undefined) return deps.baseStore
  const cwd = deps.cwdOf(sessionId)
  if (cwd === undefined) return deps.baseStore
  return new ProjectStore(resolveRoot(deps.config.root, cwd))
}

/**
 * Answer the library page: which books exist, and which one is "here".
 *
 * Candidates come from three places, and all three matter: the root the browser
 * pinned, the book this session resolves to on its own, and the shelf of roots
 * seen before. Every candidate is verified against the disk, so a book that was
 * deleted or moved simply is not listed — the shelf is a hint, not a claim.
 *
 * The session's own book sorts first even when it was never on the shelf: it is
 * the one "continue writing" should mean in this workspace.
 *
 * @param deps - route dependencies.
 * @param sessionId - the calling session, when known.
 * @param root - an absolute project directory the browser asked about.
 * @returns status and body with the book rows.
 */
export async function readLibrary(
  deps: PanelDeps,
  sessionId: string | undefined,
  root?: string | undefined,
): Promise<PanelAnswer> {
  let currentRoot: string
  let sessionRoot: string
  try {
    currentRoot = storeFor(deps, sessionId, root).root
    sessionRoot = storeFor(deps, sessionId, undefined).root
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = error instanceof PanelInputError ? error.status : 400
    return { status, body: { ok: false, error: { message } } }
  }

  const candidates: string[] = []
  const seen = new Set<string>()
  const add = (candidate: string): void => {
    const key = bookKey(candidate)
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(candidate)
  }
  add(currentRoot)
  add(sessionRoot)
  add(deps.baseStore.root)
  for (const entry of await readShelf(libraryFile())) add(entry.root)

  const books: LibraryBook[] = []
  for (const candidate of candidates) {
    const store = new ProjectStore(resolve(candidate))
    const book = await describeBook(store)
    if (book === undefined) continue
    books.push({ ...book, current: bookKey(book.root) === bookKey(currentRoot) })
  }

  books.sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1
    return right.updatedAt.localeCompare(left.updatedAt)
  })

  return { status: 200, body: { ok: true, data: { books, current: currentRoot } } }
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
    // Opening a book by path is how it earns a place on the shelf: a writer who
    // browsed to D:\ novels\雾港 once should not have to browse again tomorrow.
    await rememberBook(libraryFile(), store.root)
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
 * @param limit - largest body to accept, in bytes.
 * @returns the parsed body; `{}` when it is empty.
 * @throws {PanelInputError} for an oversized or malformed body.
 */
async function readJson(req: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new PanelInputError('请求体太大。', 413)
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
      await rememberBook(libraryFile(), root)
      return { status: 200, body: { ok: true, data: created } }
    }
    const rawTitle = typeof body.title === 'string' ? body.title.trim() : ''
    const title = rawTitle === '' ? '未命名' : rawTitle.slice(0, 120)
    const rawTarget = body.targetWords
    const targetWords =
      typeof rawTarget === 'number' && Number.isFinite(rawTarget) && rawTarget > 0 ? Math.floor(rawTarget) : undefined
    await store.init(title, targetWords ?? 0)
    const created: CreatedBook = { root, title, existing: false }
    await rememberBook(libraryFile(), root)
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
 * Bind one session to one book.
 *
 * The create flow opens a fresh chat session in the new workspace, and that
 * session's `cwd` already points at the book — but only when `perWorkspace` is
 * on. A pin is the more specific answer, and it costs one line: the session the
 * writer just created shows the book they just made, even before any workspace
 * setting is touched.
 *
 * Why the panel may write this: it is the same binding `novel_project
 * action="open"` writes in the conversation, kept in the same file. It grants no
 * access — the pin is a pointer, and `/api/inkwell` still reads through
 * `ProjectStore`, which requires a real project on disk.
 *
 * @param body - `{ session, root }`; both absolute-path and session ids are
 *   validated before anything is written.
 * @returns the pin that was written.
 * @throws {PanelInputError} for a missing session id, a relative root, or a
 *   directory that holds no book.
 */
export async function pinSession(body: Record<string, unknown>): Promise<PanelAnswer> {
  try {
    const session = typeof body.session === 'string' ? body.session.trim() : ''
    if (session === '') throw new PanelInputError('pin 需要 session（会话 id）。', 400)
    const raw = typeof body.root === 'string' ? body.root.trim() : ''
    if (raw === '') throw new PanelInputError('pin 需要 root（书的绝对路径）。', 400)
    if (!isAbsolute(raw)) throw new PanelInputError(`root 必须是绝对路径：${raw}`, 400)
    const root = resolve(raw)
    const store = new ProjectStore(root)
    if (!(await store.exists())) {
      throw new PanelInputError(`这里没有书：${root}（里面没有 project.json）。`, 404)
    }
    pinBook(sessionsFile(), session, store.root)
    await rememberBook(libraryFile(), store.root)
    return { status: 200, body: { ok: true, data: { session, root: store.root } } }
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
 * Answer the create dialog: what is already in this folder?
 *
 * The question is asked before a book exists, so this route never requires one.
 * It reports what an import would write and, when the session already points at
 * a book, which chapters would be skipped — the two numbers the dialog needs to
 * put "86 章，12.5 万字" next to the checkbox instead of letting the writer find
 * out afterwards.
 *
 * @param deps - route dependencies.
 * @param dir - the folder to look at (absolute).
 * @param sessionId - the calling session, used only to find an existing book.
 * @param root - an explicit book directory, when the browser names one.
 * @returns the summary, with a human report for the tool-family readers.
 */
export async function scanFolder(
  deps: PanelDeps,
  dir: string | undefined,
  sessionId?: string | undefined,
  root?: string | undefined,
): Promise<PanelAnswer> {
  const requested = (dir ?? '').trim()
  if (requested === '') {
    return { status: 400, body: { ok: false, error: { message: '没有给目录：dir 不能为空。' } } }
  }
  if (!isAbsolute(requested)) {
    return { status: 400, body: { ok: false, error: { message: `dir 必须是绝对路径：${requested}` } } }
  }
  const folder = resolve(requested)
  if (!(await isDirectory(folder))) {
    return { status: 404, body: { ok: false, error: { message: `没有这个文件夹：${folder}` } } }
  }
  const sources = await readSources(folder)
  const plan = planImport(sources)
  let existing = new Set<number>()
  let bookRoot: string | undefined
  try {
    const store = storeFor(deps, sessionId, root)
    if (await store.exists()) {
      bookRoot = store.root
      existing = new Set((await store.chapters()).map((meta) => meta.number))
    }
  } catch {
    // A scan is read-only and useful with no book at all; a bad `root` only
    // means we cannot say which chapters would be skipped.
  }
  const summary = summarize(folder, plan, existing, sources.used, sources.capped)
  return {
    status: 200,
    body: { ok: true, data: { ...summary, bookRoot: bookRoot ?? null, report: describeScan(summary, bookRoot) } },
  }
}

/** What the create dialog did with the manuscript. */
export interface ImportedManuscript {
  root: string
  /** Chapters written into the book. */
  written: number
  /** Chapters already in the book, left alone. */
  skipped: number
  words: number
  cast: number
  volumes: number
  plans: number
}

/**
 * Write a manuscript into the book this request resolves to.
 *
 * Same rules as `novel_import action="apply"`, through the same writer: the
 * panel may not overwrite a chapter the writer edited, and it may not invent a
 * premise over one they typed.
 *
 * @param deps - route dependencies.
 * @param sessionId - the calling session.
 * @param body - `{ dir, overwrite? }`.
 * @param root - an explicit book directory, when the browser names one.
 * @returns how much was imported.
 */
export async function importFolder(
  deps: PanelDeps,
  sessionId: string | undefined,
  body: Record<string, unknown>,
  root?: string | undefined,
): Promise<PanelAnswer> {
  const requested = typeof body.dir === 'string' ? body.dir.trim() : ''
  if (requested === '') {
    return { status: 400, body: { ok: false, error: { message: '没有说导哪个文件夹：dir 不能为空。' } } }
  }
  if (!isAbsolute(requested)) {
    return { status: 400, body: { ok: false, error: { message: `dir 必须是绝对路径：${requested}` } } }
  }
  const folder = resolve(requested)
  if (!(await isDirectory(folder))) {
    return { status: 404, body: { ok: false, error: { message: `没有这个文件夹：${folder}` } } }
  }
  let store: ProjectStore
  try {
    store = storeFor(deps, sessionId, root)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = error instanceof PanelInputError ? error.status : 400
    return { status, body: { ok: false, error: { message } } }
  }
  if (!(await store.exists())) {
    return {
      status: 409,
      body: { ok: false, error: { message: `这里还没有书：${store.root}。先建书，再导入。` } },
    }
  }
  const sources = await readSources(folder)
  const plan = planImport(sources)
  const applied = await applyImport(store, plan, { overwrite: body.overwrite === true })
  const data: ImportedManuscript = {
    root: store.root,
    written: applied.written,
    skipped: applied.skipped,
    words: applied.words,
    cast: plan.cast.length,
    volumes: plan.volumes.length,
    plans: plan.plans.length,
  }
  return { status: 200, body: { ok: true, data } }
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
    // The prose is the chapter page's main body, so it rides along with the page
    // rather than costing the browser a second request to show a preview.
    const prose =
      kind === 'chapter' && Number.isInteger(number) && number > 0
        ? (await store.chapter(number))?.text
        : undefined
    const reviewRounds =
      kind === 'chapter' && Number.isInteger(number) && number > 0
        ? await store.reviews(number)
        : []
    const entry = buildEntry(snapshot, kind as PanelEntryKind, key, drafts, store.root, prose, reviewRounds)
    if (entry === undefined) {
      return {
        status: 404,
        body: { ok: false, error: { message: `找不到 ${kind}「${key}」。它可能刚被改名或删掉，刷新一下。` } },
      }
    }
    if (kind === 'chapter') {
      // Ask the gate now, not after the writer typed: the page can then explain
      // why the body is not editable yet, using the same sentence the model gets.
      const reason = await gateToolCall('novel_chapter', { action: 'write', number }, store, deps.config)
      if (reason !== null) entry.blocked = reason
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
 * Render blocking findings the way the tools do, so the panel and the
 * conversation say the same sentence about the same refusal.
 *
 * @param findings - contract errors.
 * @returns one line per finding.
 */
function formatBlockers(findings: readonly Finding[]): string {
  return findings.map((finding) => `✗ [${finding.code}] ${finding.message}`).join('\n')
}

/**
 * Save an edit to one character, world entry, or chapter body.
 *
 * This is the panel's third and last write door, and it is a narrower handle on
 * doors that already exist: a canon edit is what `novel_canon` writes, a chapter
 * body goes through {@link saveChapterBody} — the exact code `novel_chapter
 * action="write"` runs — and the phase/outline/approval checks come from
 * {@link gateToolCall}, not from a second copy of the rules. So the answer to
 * "may the panel skip the gate?" is structurally no: it calls it.
 *
 * @param deps - route dependencies.
 * @param sessionId - the calling session, when known.
 * @param body - `{ kind, key, fields }`.
 * @param root - an absolute project directory, when the browser named one.
 * @returns the refreshed page for that entry, or the reason it was refused.
 */
export async function writeEntry(
  deps: PanelDeps,
  sessionId: string | undefined,
  body: Record<string, unknown>,
  root: string | undefined,
): Promise<PanelAnswer> {
  try {
    const kind = body.kind
    if (kind !== 'character' && kind !== 'world' && kind !== 'chapter') {
      throw new PanelInputError(`未知的条目类型 ${String(kind)}，只支持 character／world／chapter。`)
    }
    const key = typeof body.key === 'string' ? body.key.trim() : ''
    if (key === '') throw new PanelInputError('缺少 key：角色名、世界观名或章号。')
    const fields = body.fields
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
      throw new PanelInputError('fields 必须是一个对象。')
    }
    const patch = fields as Record<string, unknown>
    const store = storeFor(deps, sessionId, root)
    if (!(await store.exists())) {
      throw new PanelInputError('这本书还没有项目文件，先在面板里新建一本。', 409)
    }

    if (kind === 'character') {
      const edit = readCharacterPatch(key, patch)
      const existing = (await store.characters()).find((card) => card.name === key)
      if (existing === undefined) {
        throw new PanelInputError(`找不到角色「${key}」。它可能刚被改名或删掉，刷新一下。`, 404)
      }
      const card: CharacterCard = {
        name: key,
        role: edit.role ?? existing.role,
        voice: edit.voice ?? existing.voice,
        appearance: edit.appearance ?? existing.appearance,
        goal: edit.goal ?? existing.goal,
        secret: edit.secret ?? existing.secret,
        updatedAt: new Date().toISOString(),
      }
      await store.upsertCharacter(card)
    } else if (kind === 'world') {
      const edit = readWorldPatch(key, patch)
      const existing = (await store.world()).find((entry) => entry.name === key)
      if (existing === undefined) {
        throw new PanelInputError(`找不到设定「${key}」。它可能刚被改名或删掉，刷新一下。`, 404)
      }
      const detail = edit.detail ?? existing.detail
      if (detail === '') throw new PanelInputError('设定内容不能为空。')
      await store.upsertWorld({
        name: key,
        kind: edit.kind || existing.kind,
        detail,
        updatedAt: new Date().toISOString(),
      })
    } else {
      const edit = readChapterPatch(key, patch)
      // Same refusal the model gets in the conversation, before anything is written.
      const reason = await gateToolCall(
        'novel_chapter',
        { action: 'write', number: edit.number },
        store,
        deps.config,
      )
      if (reason !== null) throw new PanelInputError(reason, 409)
      try {
        await saveChapterBody(store, deps.config, {
          number: edit.number,
          text: edit.text,
          title: edit.title,
          summary: edit.summary,
          // The page sends the revision it opened. A mismatch means someone
          // else saved in between — refuse rather than overwrite their work.
          baseRevision: edit.revision,
        })
      } catch (error) {
        if (error instanceof ChapterBlockedError) {
          throw new PanelInputError(
            `第${edit.number}章未通过章纲合同，没有保存：\n${formatBlockers(error.blockers)}\n\n改正文让这些角色出场，或者去改章纲（改完章纲要重新批准）。`,
            409,
          )
        }
        if (error instanceof ChapterConflictError) {
          throw new PanelInputError(
            [
              `第${edit.number}章已经被别处改过了（磁盘上是第 ${error.current} 版，你编辑的是第 ${edit.revision ?? 0} 版）。`,
              '没有保存，以免覆盖那边的内容。刷新页面拿到最新版，把你的改动重贴一次。',
            ].join('\n'),
            409,
          )
        }
        throw error
      }
    }

    const snapshot = await store.snapshot()
    const number = Number(key)
    const drafts: ChapterDrafts[] =
      kind === 'chapter' && Number.isInteger(number) && number > 0
        ? [{ number, rounds: await store.draftsOf(number) }]
        : []
    const prose =
      kind === 'chapter' && Number.isInteger(number) && number > 0
        ? (await store.chapter(number))?.text
        : undefined
    const reviewRounds =
      kind === 'chapter' && Number.isInteger(number) && number > 0
        ? await store.reviews(number)
        : []
    const entry = buildEntry(snapshot, kind as PanelEntryKind, key, drafts, store.root, prose, reviewRounds)
    return { status: 200, body: { ok: true, data: entry ?? null } }
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

      if (path === '/books') {
        if (!isRead) {
          send(res, { status: 405, body: { ok: false, error: { message: '/books 只读，新建用 /init' } } })
          return
        }
        const sessionId = url.searchParams.get('session') ?? undefined
        const root = url.searchParams.get('root') ?? undefined
        send(res, await readLibrary(deps, sessionId, root))
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

      if (path === '/pin') {
        if (isRead) {
          send(res, { status: 405, body: { ok: false, error: { message: '/pin 需要 POST' } } })
          return
        }
        send(res, await pinSession(await readJson(req)))
        return
      }

      if (path === '/scan') {
        if (!isRead) {
          send(res, { status: 405, body: { ok: false, error: { message: '/scan 只读，导入用 /import' } } })
          return
        }
        send(
          res,
          await scanFolder(
            deps,
            url.searchParams.get('dir') ?? undefined,
            url.searchParams.get('session') ?? undefined,
            url.searchParams.get('root') ?? undefined,
          ),
        )
        return
      }

      if (path === '/import') {
        if (isRead) {
          send(res, { status: 405, body: { ok: false, error: { message: '/import 需要 POST' } } })
          return
        }
        send(
          res,
          await importFolder(
            deps,
            url.searchParams.get('session') ?? undefined,
            await readJson(req),
            url.searchParams.get('root') ?? undefined,
          ),
        )
        return
      }

      if (path === '/entry') {
        const sessionId = url.searchParams.get('session') ?? undefined
        const root = url.searchParams.get('root') ?? undefined
        if (isRead) {
          send(
            res,
            await readEntry(
              deps,
              sessionId,
              url.searchParams.get('kind') ?? undefined,
              url.searchParams.get('key') ?? undefined,
              root,
            ),
          )
          return
        }
        // A chapter body is the largest thing this route accepts, so the cap is
        // the chapter cap rather than the create-flow's small one.
        send(res, await writeEntry(deps, sessionId, await readJson(req, MAX_WRITE_BYTES), root))
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
