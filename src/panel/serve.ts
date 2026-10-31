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
 * - `GET /api/inkwell/scan?dir=<abs>` — what a manuscript folder holds, read-only.
 * - `POST /api/inkwell/import` — put that manuscript into the current book.
 * - `POST /api/inkwell/import-book` — create a book *from* a manuscript folder
 *   in one step: 新建 and 导入 are the same door, different cargo.
 * - `POST /api/inkwell/export` — write the book out as txt or per-volume
 *   markdown, into a folder the writer picked.
 * - `POST /api/inkwell/delete-book` — delete a book directory. The only
 *   destructive route here, and the only one that refuses paths that do not
 *   end in `.novel`.
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
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { bookText, safeFileName, volumeFiles } from '../domain/export.ts'
import { backupHome, describeBackup, listBackups, packageBook, restoreBook } from '../domain/backup.ts'
import { setBookStart } from '../domain/book-start.ts'
import { addAnchor, addAnchors } from '../domain/timeline-edit.ts'
import { applyImport } from '../domain/import-apply.ts'
import { planImport } from '../domain/import-scan.ts'
import { describeScan, isDirectory, readSources, summarize } from '../domain/manuscript.ts'
import { chapterRanges } from '../domain/records.ts'
import { MissingPlanError, updateCard } from '../domain/cards.ts'
import { updateCharacter } from '../domain/characters.ts'
import { assignVolume, readVolumes, shellPlan, splitVolumes, UNASSIGNED, type VolumeReport } from '../domain/volumes.ts'
import { ChapterBlockedError, saveChapterBody } from '../domain/save.ts'
import { ChapterConflictError } from '../domain/store.ts'
import { resolveRoot } from '../domain/scope.ts'
import { ProjectStore } from '../domain/store.ts'
import { CHARACTER_ROLES, type CharacterCard, type CharacterRole, type Finding, type InkwellConfig, type Phase } from '../domain/types.ts'
import { gateToolCall } from '../gate.ts'
import { atLeast, blockersFor } from '../domain/phase.ts'
import { listDirectories, PanelInputError, requireDirectory } from './dirs.ts'
import { PENDING_LABEL, describePending, readPending, removePending } from '../domain/pending.ts'
import { renameWorldKind } from '../domain/kinds.ts'
import { parseTerms, searchChapters } from '../domain/search.ts'
import { applyPendingBatch } from '../domain/approve.ts'
import { createCatalogCache, type CatalogCache, type CatalogProvider, modelsOf } from './catalog.ts'
import { readCardPatch, readChapterPatch, readCharacterPatch, readPlacePatch, readStoryPatch, readWorldPatch } from './edit.ts'
import {
  bookKey,
  describeBook,
  forgetBook,
  libraryFile,
  readShelf,
  rememberBook,
  type LibraryBook,
} from '../domain/shelf.ts'
import { pinBook, pinnedRoot, sessionsFile } from '../domain/session-books.ts'
import { buildEntry } from './entry.ts'
import { buildPanelSnapshot, emptyPanelSnapshot, type ChapterDrafts, type PanelSnapshot } from './model.ts'
import type { LlmCatalogSource } from './ports.ts'
import type { PanelEntryKind } from './tree.ts'
import { checkRouteAgainstCatalog, readRoleChoice, roleViews, withRoleOverride, type RoleView } from './roles.ts'
import { listHistory, parseTarget, readHistory } from '../domain/history.ts'
import { buildWriterBrief } from '../roles.ts'

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
    const data = buildPanelSnapshot(snapshot, deps.config, drafts, store.root, (await readPending(store.root)).length)
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

/**
 * Create a book **from** a manuscript folder, in one request.
 *
 * 新建 and 导入 differ only in what the writer already has: an empty folder or
 * a folder with eighty-five chapters in it. Doing that as two round-trips from
 * the dialog means a second chance to create the book twice (or to create it
 * and then fail to import), so the whole thing is one route with one commit
 * point: the book is created, then the manuscript goes into it, then the shelf
 * remembers it.
 *
 * The title comes from the dialog, falling back to the outline's premise title
 * and then to the folder name — the same order a person would guess in.
 *
 * @param deps - route dependencies.
 * @param body - `{ dir, title?, targetWords?, overwrite? }`.
 * @returns the created book, plus what the import wrote.
 */
export async function importBook(deps: PanelDeps, body: Record<string, unknown>): Promise<PanelAnswer> {
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
  const sources = await readSources(folder)
  const plan = planImport(sources)
  if (plan.chapters.length === 0) {
    return {
      status: 422,
      body: {
        ok: false,
        error: {
          message: `这个文件夹里没认出章节：${folder}。一个 txt 或 md 整个放进来也行，章与章之间只要有标题行——「第一章」「Chapter 1」「1.标题」三种写法都认。`,
        },
      },
    }
  }
  const rawTitle = typeof body.title === 'string' ? body.title.trim() : ''
  const title = rawTitle === '' ? basename(folder).slice(0, 120) : rawTitle.slice(0, 120)
  const claimed = await createBook(deps, {
    dir: folder,
    title,
    ...(body.targetWords === undefined ? {} : { targetWords: body.targetWords }),
  })
  if (claimed.body === null || typeof claimed.body !== 'object') return claimed
  const answer = claimed.body as { ok?: boolean; data?: CreatedBook; error?: { message?: string } }
  if (answer.ok === false || answer.data === undefined) return claimed
  const created = answer.data
  const store = new ProjectStore(created.root)
  const applied = await applyImport(store, plan, { overwrite: body.overwrite === true })
  await rememberBook(libraryFile(), created.root)
  const summary = summarize(folder, plan, new Set<number>(), sources.used, sources.capped)
  const data: ImportedManuscript & { title: string; existing: boolean; phase?: Phase } = {
    root: created.root,
    title: created.title,
    existing: created.existing,
    written: applied.written,
    skipped: applied.skipped,
    words: applied.words,
    cast: plan.cast.length,
    volumes: plan.volumes.length,
    plans: plan.plans.length,
    voiceless: summary.voiceless,
    report: describeScan(summary, created.root),
    ...(applied.phase === undefined ? {} : { phase: applied.phase }),
  }
  return { status: 200, body: { ok: true, data } }
}

/**
 * Write a book out into a folder the writer picked.
 *
 * The panel and `novel_export` share `bookText`/`volumeFiles`, so the two
 * doors produce the same bytes: a book exported from the panel is the book the
 * conversation would have exported. The difference is only who chose the
 * folder — the writer, through a real directory picker, rather than a path
 * typed into a tool call.
 *
 * @param deps - route dependencies.
 * @param body - `{ dir, format?: 'txt'|'markdown', root? }`.
 * @param pinned - the book named in the query string, when the browser did.
 * @returns where the files went, and their names.
 */
export async function exportBook(deps: PanelDeps, body: Record<string, unknown>, pinned?: string): Promise<PanelAnswer> {
  const requested = typeof body.dir === 'string' ? body.dir.trim() : ''
  if (requested === '') {
    return { status: 400, body: { ok: false, error: { message: '没有说导到哪个文件夹：dir 不能为空。' } } }
  }
  if (!isAbsolute(requested)) {
    return { status: 400, body: { ok: false, error: { message: `dir 必须是绝对路径：${requested}` } } }
  }
  const format = body.format === 'markdown' ? 'markdown' : 'txt'
  const dir = resolve(requested)
  // The shelf exports a book that may not be the one on screen, so the body
  // names it. `pinned` is the query-string spelling of the same thing, kept
  // because every other route takes `?root=`.
  const named = typeof body.root === 'string' ? body.root.trim() : ''
  const store = storeFor(deps, undefined, named === '' ? pinned : named)
  if (!(await store.exists())) {
    return { status: 404, body: { ok: false, error: { message: `这里不是一本书：${store.root}（没有 project.json）` } } }
  }
  const snapshot = await store.snapshot()
  const chapters = await store.allChapters()
  if (chapters.length === 0) {
    return {
      status: 409,
      body: {
        ok: false,
        error: {
          message: '这本书还没有落盘的正文，导出来会是空的。先 novel_chapter action="write" 写一章，或用 novel_export action="canon" 只导设定集。',
        },
      },
    }
  }
  const files =
    format === 'markdown' ? volumeFiles(snapshot, chapters) : [{ name: `${safeFileName(snapshot.project.title)}.txt`, body: bookText(snapshot, chapters) }]
  await mkdir(dir, { recursive: true })
  const written: string[] = []
  for (const file of files) {
    const target = join(dir, file.name)
    await writeFile(target, file.body, 'utf8')
    written.push(target)
  }
  return {
    status: 200,
    body: {
      ok: true,
      data: {
        dir,
        format,
        files: written,
        chapters: chapters.length,
        words: chapters.reduce((sum, draft) => sum + draft.words, 0),
      },
    },
  }
}

/**
 * Delete a book from disk, and from the shelf.
 *
 * This is the one destructive route in the plugin, so it refuses anything that
 * does not look like a book it could have made: the path must be absolute, must
 * end in `.novel`, and must hold a `project.json`. A writer's folder of
 * manuscripts is never a book root — `init` puts the book in `.novel` beside
 * them — so the suffix test is what keeps "delete my book" from becoming
 * "delete my manuscript folder". The shelf entry goes first: a book deleted but
 * still listed is a row that opens nothing, which is the worse leftover.
 *
 * @param deps - route dependencies.
 * @param body - `{ root }`, the absolute project root.
 * @returns what was removed.
 */
export async function removeBook(deps: PanelDeps, body: Record<string, unknown>): Promise<PanelAnswer> {
  const requested = typeof body.root === 'string' ? body.root.trim() : ''
  if (requested === '') {
    return { status: 400, body: { ok: false, error: { message: '没有说要删哪本书：root 不能为空。' } } }
  }
  if (!isAbsolute(requested)) {
    return { status: 400, body: { ok: false, error: { message: `root 必须是绝对路径：${requested}` } } }
  }
  const root = resolve(requested)
  if (basename(root) !== '.novel') {
    return {
      status: 400,
      body: {
        ok: false,
        error: { message: `只删 inkwell 自己的书目录（必须以 .novel 结尾）：${root}。原稿文件夹不会被删。` },
      },
    }
  }
  const store = new ProjectStore(root)
  if (!(await store.exists())) {
    await forgetBook(libraryFile(), root)
    return { status: 404, body: { ok: false, error: { message: `这里没有书：${root}` } } }
  }
  const title = await store.readProject().then((project) => project.title).catch(() => basename(root))
  await forgetBook(libraryFile(), root)
  await rm(root, { recursive: true, force: true })
  return { status: 200, body: { ok: true, data: { root, title } } }
}

/**
 * List, make, or restore a copy of one book.
 *
 * Restore goes through `restoreBook`, which takes a copy of the present state
 * before writing anything — so the button that looks like a one-way door is not
 * one. The panel is allowed to reach this because the domain module holds the
 * whole rule: what goes into a copy, how many are kept, and that extras survive.
 *
 * @param deps - route dependencies.
 * @param body - `{ root?, action: 'list'|'make'|'restore', name? }`.
 * @param pinned - the book named in the query string, when the browser did.
 * @returns the copies, and what a make or restore did.
 */
export async function backupBook(
  deps: PanelDeps,
  body: Record<string, unknown>,
  pinned?: string,
): Promise<PanelAnswer> {
  const action = typeof body.action === 'string' ? body.action.trim() : 'list'
  const named = typeof body.root === 'string' ? body.root.trim() : ''
  const store = storeFor(deps, undefined, named === '' ? pinned : named)
  if (!(await store.exists())) {
    return { status: 404, body: { ok: false, error: { message: `这里不是一本书：${store.root}（没有 project.json）` } } }
  }

  if (action === 'list') {
    const backups = (await listBackups(store.root)).map((entry) => ({
      name: entry.name,
      at: entry.at,
      files: entry.files,
      bytes: entry.bytes,
      line: describeBackup(entry),
    }))
    return { status: 200, body: { ok: true, data: { root: store.root, backups, dir: backupHome(store.root) } } }
  }

  if (action === 'make') {
    const made = await packageBook(store.root)
    return {
      status: 200,
      body: {
        ok: true,
        data: {
          root: store.root,
          made: { name: made.entry.name, at: made.entry.at, files: made.entry.files },
          pruned: made.pruned,
        },
      },
    }
  }

  if (action !== 'restore') {
    return { status: 400, body: { ok: false, error: { message: `不知道要做哪件事：${action}（list／make／restore）` } } }
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name === '') {
    return { status: 400, body: { ok: false, error: { message: '没有说回到哪一份：name 不能为空。' } } }
  }
  try {
    const result = await restoreBook(store.root, name)
    return {
      status: 200,
      body: {
        ok: true,
        data: {
          root: store.root,
          name: result.name,
          written: result.written,
          unchanged: result.unchanged.length,
          extra: result.extra,
          safety: result.safety?.name,
        },
      },
    }
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure)
    return { status: 400, body: { ok: false, error: { message } } }
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
  /** Cards whose `voice` is still empty, named so the writer can fill them. */
  voiceless?: string[]
  /** The scan, in prose, for the dialog's receipt. */
  report?: string
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
 * One line per volume, plus the chapters in none: what the panel says after a
 * split, in the shape a writer checks ("did my 84 and 85 land somewhere?").
 *
 * @param report - the volume report.
 * @returns the human-readable summary.
 */
function describeVolumes(report: VolumeReport): string {
  if (report.volumes.length === 0 && report.unassigned.length === 0) return '这本书还没有任何章节。'
  const lines = report.volumes.map((volume) => {
    const label = `第${volume.number}卷${volume.title === '' ? '' : ` ${volume.title}`}`
    if (volume.chapters.length === 0) return `${label}：空的`
    return `${label}：${chapterRanges(volume.chapters)}（${volume.chapters.length} 章）`
  })
  if (report.unassigned.length > 0) {
    lines.push(`未分卷：${chapterRanges(report.unassigned)}（${report.unassigned.length} 章）`)
  }
  return lines.join('\n')
}

/**
 * Read the volume map of one book.
 *
 * @param deps - route dependencies.
 * @param sessionId - the calling session, when known.
 * @param root - an absolute project directory, when the browser named one.
 * @returns status and body with the volumes and the chapters in none.
 */
export async function readVolumeMap(
  deps: PanelDeps,
  sessionId: string | undefined,
  root: string | undefined,
): Promise<PanelAnswer> {
  try {
    const store = storeFor(deps, sessionId, root)
    if (!(await store.exists())) {
      const empty: VolumeReport = { volumes: [], unassigned: [], created: [], changed: 0 }
      return {
        status: 200,
        body: { ok: true, data: { ...empty, root: store.root, noBook: true, report: '这本书还没有项目文件。' } },
      }
    }
    const report = await readVolumes(store)
    return {
      status: 200,
      body: { ok: true, data: { ...report, root: store.root, noBook: false, report: describeVolumes(report) } },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = error instanceof PanelInputError ? error.status : 500
    return { status, body: { ok: false, error: { message } } }
  }
}

/**
 * Change which chapters sit in which volume.
 *
 * Two actions, one route: `assign` moves the chapters the writer ticked,
 * `split` cuts the whole book into fixed-size volumes. Both only ever assign —
 * no chapter is deleted and no volume outline is thrown away, because a volume
 * can carry a summary nobody else has.
 *
 * @param deps - route dependencies.
 * @param body - `{ action: 'assign', chapters, volume }` or `{ action: 'split', perVolume }`.
 * @param sessionId - the calling session, when known.
 * @param root - an absolute project directory, when the browser named one.
 * @returns status and the refreshed map.
 */
export async function writeVolumeMap(
  deps: PanelDeps,
  body: Record<string, unknown>,
  sessionId: string | undefined,
  root: string | undefined,
): Promise<PanelAnswer> {
  try {
    // The body may name the book. The sheet can show a book this session is not
    // pinned to, and "move these chapters" must land in the book being looked at.
    const named = typeof body.root === 'string' ? body.root.trim() : ''
    const store = storeFor(deps, sessionId, named === '' ? root : named)
    if (!(await store.exists())) {
      throw new PanelInputError(`这里还没有书：${store.root}。先建书，再分卷。`, 409)
    }
    const action = typeof body.action === 'string' ? body.action : 'assign'
    let report: VolumeReport
    let said: string
    if (action === 'split') {
      const perVolume = Number(body.perVolume)
      if (!Number.isInteger(perVolume) || perVolume < 1) {
        throw new PanelInputError(`每卷几章要是正整数，收到 ${String(body.perVolume)}。`)
      }
      report = await splitVolumes(store, perVolume)
      said = `按每 ${perVolume} 章一卷切成了 ${report.volumes.length} 卷，动了 ${report.changed} 章。`
    } else if (action === 'assign') {
      const chapters = Array.isArray(body.chapters) ? body.chapters.map((value) => Number(value)) : []
      if (chapters.length === 0) throw new PanelInputError('没有选中任何章节。')
      const raw = body.volume
      const volume = raw === null || raw === undefined ? null : Number(raw)
      if (volume !== null && (!Number.isInteger(volume) || volume < 1)) {
        throw new PanelInputError(`卷号要是正整数，或者 null 表示未分卷，收到 ${String(raw)}。`)
      }
      report = await assignVolume(store, chapters, volume)
      const moved = chapterRanges([...new Set(chapters.map(Number))].filter((n) => Number.isInteger(n)).sort((a, b) => a - b))
      said =
        volume === null
          ? `把 ${moved} 从卷里拿出来了（现在算未分卷），动了 ${report.changed} 章。`
          : `把 ${moved} 归入第${volume}卷，动了 ${report.changed} 章。`
      if (report.created.length > 0) said += `新建了第${report.created.join('、')}卷。`
    } else {
      throw new PanelInputError(`不认识的 action：${action}。要么 assign，要么 split。`)
    }
    return {
      status: 200,
      body: { ok: true, data: { ...report, root: store.root, noBook: false, report: `${said}\n${describeVolumes(report)}` } },
    }
  } catch (error) {
    if (error instanceof PanelInputError) {
      return { status: error.status, body: { ok: false, error: { message: error.message } } }
    }
    if (error instanceof RangeError) {
      return { status: 400, body: { ok: false, error: { message: error.message } } }
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
 * @param kind - `character`, `world`, `chapter`, `card`, `place`, `story`, or `timeline`.
 * @param key - the name, or the chapter number as a string.
 * @param root - an absolute project directory, when the browser named one.
 * @returns status and body.
 */
/**
 * Parse a history target, reporting a bad one as a 400 rather than a 500.
 *
 * `parseTarget` throws a plain Error because the tool surfaces it verbatim; the
 * route has to translate it into the panel's status codes.
 */
function readTarget(target: string): { kind: 'chapter' | 'canon'; name: string } {
  try {
    return parseTarget(target)
  } catch (error) {
    throw new PanelInputError((error as Error).message, 400)
  }
}

/** Turn a thrown error into the panel's answer shape. */
function failure(error: unknown): PanelAnswer {
  if (error instanceof PanelInputError) {
    return { status: error.status, body: { ok: false, error: { message: error.message } } }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 500, body: { ok: false, error: { message } } }
}

/**
 * The last few versions of one file.
 *
 * Targets are the same coordinates the tool uses — `chapter:7`,
 * `canon:characters`, `canon:world` — so a version seen in the panel and a
 * version named in the conversation are the same version.
 *
 * @param deps - route dependencies.
 * @param sessionId - the calling session.
 * @param target - `kind:name`.
 * @param root - an absolute project directory, when the browser named one.
 * @returns the entries, newest first.
 */
export async function readHistoryRoute(
  deps: PanelDeps,
  sessionId: string | undefined,
  target: string,
  root: string | undefined,
): Promise<PanelAnswer> {
  try {
    const store = storeFor(deps, sessionId, root)
    if (!(await store.exists())) throw new PanelInputError('这本书还没有项目文件，先在面板里新建一本。', 409)
    const parsed = readTarget(target)
    return {
      status: 200,
      body: { ok: true, data: { target, entries: await listHistory(store.root, parsed.kind, parsed.name) } },
    }
  } catch (error) {
    return failure(error)
  }
}

/**
 * Put one file back to a stored version, leaving the rest of the book alone.
 *
 * The write goes through the same store methods the tool uses, so the restored
 * content is validated (canon must still parse) and the chapter's revision goes
 * up — an editor holding the old number finds out on its next save.
 *
 * @param deps - route dependencies.
 * @param sessionId - the calling session.
 * @param body - `{ target, rev }`.
 * @param root - an absolute project directory, when the browser named one.
 * @returns the remaining entries.
 */
export async function revertRoute(
  deps: PanelDeps,
  sessionId: string | undefined,
  body: Record<string, unknown>,
  root: string | undefined,
): Promise<PanelAnswer> {
  try {
    const store = storeFor(deps, sessionId, root)
    if (!(await store.exists())) throw new PanelInputError('这本书还没有项目文件，先在面板里新建一本。', 409)
    const target = typeof body.target === 'string' ? body.target : ''
    const rev = typeof body.rev === 'string' ? body.rev.trim() : ''
    if (rev === '') throw new PanelInputError('要说回到哪一版。')
    const parsed = readTarget(target)
    const text = await readHistory(store.root, parsed.kind, parsed.name, rev)
    if (parsed.kind === 'chapter') {
      await store.restoreChapterText(Number(parsed.name), text)
    } else {
      if (!['characters', 'world', 'places', 'relations'].includes(parsed.name)) {
        throw new PanelInputError(`canon 只认 characters / world / places / relations，不认「${parsed.name}」。`)
      }
      await store.writeCanonRaw(parsed.name as 'characters' | 'world' | 'places' | 'relations', text)
    }
    return {
      status: 200,
      body: { ok: true, data: { target, entries: await listHistory(store.root, parsed.kind, parsed.name) } },
    }
  } catch (error) {
    return failure(error)
  }
}

/**
 * Create one empty chapter by hand.
 *
 * The panel could not make a chapter before this: an outline is the tool's job,
 * and a plan without beats has nothing to approve. That is right for a planned
 * book and wrong for an author who simply wants to start typing a scene — so
 * this creates the same shell the importer does (approved, no beats) and says
 * why when the book is not far enough along to hold a chapter at all.
 *
 * @param deps - route dependencies.
 * @param sessionId - the calling session.
 * @param body - `{ number?, title? }`; number defaults to the next free one.
 * @param root - an absolute project directory, when the browser named one.
 * @returns the number that was created.
 */
export async function addChapterRoute(
  deps: PanelDeps,
  sessionId: string | undefined,
  body: Record<string, unknown>,
  root: string | undefined,
): Promise<PanelAnswer> {
  try {
    const store = storeFor(deps, sessionId, root)
    if (!(await store.exists())) throw new PanelInputError('这本书还没有项目文件，先在面板里新建一本。', 409)
    const snapshot = await store.snapshot()
    if (!atLeast(snapshot.project.phase, 'drafting')) {
      const blockers = blockersFor('drafting', snapshot, deps.config)
      throw new PanelInputError(
        [
          `当前还在「${snapshot.project.phase}」阶段，还不能建章节。`,
          '要进入 drafting，先补齐：',
          ...blockers.map((item) => `- ${item}`),
        ].join('\n'),
        409,
      )
    }

    const used = new Set<number>([
      ...snapshot.plans.map((plan) => plan.number),
      ...snapshot.chapters.map((chapter) => chapter.number),
    ])
    const asked = Number(body.number)
    const number = Number.isInteger(asked) && asked > 0 ? asked : (used.size === 0 ? 1 : Math.max(...used) + 1)
    if (used.has(number)) throw new PanelInputError(`第${number}章已经存在了。`, 409)

    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const plan = { ...shellPlan(number, UNASSIGNED, undefined), approved: true, title }
    await store.upsertPlan(plan)
    return { status: 200, body: { ok: true, data: { number, title } } }
  } catch (error) {
    return failure(error)
  }
}

/** Names one thing the panel can create, and the drawer it belongs to. */
export type CreateKind = 'character' | 'world' | 'volume' | 'story'

/**
 * Create one canon card, volume, story point or note by hand.
 *
 * The panel could only edit things that already existed. Every one of those
 * things had to be born in the conversation first, which is a strange place to
 * put "add a character" for an author who is looking at the character drawer.
 *
 * Only fields that make sense empty are defaulted: a name is required, a role
 * defaults to `supporting`, everything else starts blank and gets filled on the
 * page this creation opens.
 *
 * @param deps - route dependencies.
 * @param sessionId - the calling session.
 * @param body - `{ kind, fields }`.
 * @param root - an absolute project directory, when the browser named one.
 * @returns the new thing's key, for opening its page.
 */
export async function createRoute(
  deps: PanelDeps,
  sessionId: string | undefined,
  body: Record<string, unknown>,
  root: string | undefined,
): Promise<PanelAnswer> {
  try {
    const store = storeFor(deps, sessionId, root)
    if (!(await store.exists())) throw new PanelInputError('这本书还没有项目文件，先在面板里新建一本。', 409)
    const snapshot = await store.snapshot()
    const kind = String(body.kind ?? '')
    const raw = (body.fields ?? {}) as Record<string, unknown>
    const text = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string).trim() : '')

    if (kind === 'character') {
      const name = text('name')
      if (name === '') throw new PanelInputError('人物要有名字。')
      const role = text('role') || 'supporting'
      if (!(CHARACTER_ROLES as readonly string[]).includes(role)) {
        throw new PanelInputError(`身份只能是 ${CHARACTER_ROLES.join(' / ')}。`)
      }
      await store.upsertCharacter({
        name,
        role: role as CharacterRole,
        voice: text('voice'),
        appearance: '',
        goal: '',
        secret: '',
        updatedAt: new Date().toISOString(),
      })
      return { status: 200, body: { ok: true, data: { kind, key: name } } }
    }

    if (kind === 'world') {
      const name = text('name')
      if (name === '') throw new PanelInputError('设定要有名字。')
      await store.upsertWorld({
        name,
        kind: text('category') || '设定',
        detail: text('detail'),
        updatedAt: new Date().toISOString(),
      })
      return { status: 200, body: { ok: true, data: { kind, key: name } } }
    }

    if (kind === 'volume') {
      if (!atLeast(snapshot.project.phase, 'outline')) {
        throw new PanelInputError(['当前还在「' + snapshot.project.phase + '」阶段，还不能建分卷。', '要进入 outline，先补齐：', ...blockersFor('outline', snapshot, deps.config).map((item) => `- ${item}`)].join('\n'), 409)
      }
      const number = snapshot.volumes.length === 0 ? 1 : Math.max(...snapshot.volumes.map((volume) => volume.number)) + 1
      await store.upsertVolume({ number, title: text('title') || `第${number}卷`, summary: '', approved: false })
      return { status: 200, body: { ok: true, data: { kind, key: String(number) } } }
    }

    if (kind === 'story') {
      if (!atLeast(snapshot.project.phase, 'outline')) {
        throw new PanelInputError(['当前还在「' + snapshot.project.phase + '」阶段，还不能建故事点。', '要进入 outline，先补齐：', ...blockersFor('outline', snapshot, deps.config).map((item) => `- ${item}`)].join('\n'), 409)
      }
      const name = text('name')
      if (name === '') throw new PanelInputError('故事点要有名字。')
      const used = new Set(snapshot.storyPoints.map((point) => point.id))
      let index = snapshot.storyPoints.length + 1
      while (used.has(`sp-${String(index).padStart(3, '0')}`)) index += 1
      const id = `sp-${String(index).padStart(3, '0')}`
      const startChapter = Number(raw.startChapter)
      await store.upsertStoryPoint({
        id,
        name,
        startChapter: Number.isInteger(startChapter) && startChapter > 0 ? startChapter : 1,
        endChapter: null,
        premise: text('premise'),
        characters: [],
        closed: false,
        createdAt: new Date().toISOString(),
      })
      return { status: 200, body: { ok: true, data: { kind, key: id } } }
    }

    throw new PanelInputError(`不认识的类别：${kind}。支持 character / world / volume / story。`)
  } catch (error) {
    return failure(error)
  }
}

/**
 * The writer's brief for one chapter, as text the author can copy.
 *
 * Deliberately does not spawn: the panel's job is to show what the writer would
 * be told, so the author can hand it to another session or keep it.
 *
 * @param deps - route dependencies.
 * @param sessionId - the calling session.
 * @param body - `{ number }`.
 * @param root - an absolute project directory, when the browser named one.
 * @returns the brief.
 */
export async function cardRoute(
  deps: PanelDeps,
  sessionId: string | undefined,
  body: Record<string, unknown>,
  root: string | undefined,
): Promise<PanelAnswer> {
  try {
    const store = storeFor(deps, sessionId, root)
    if (!(await store.exists())) throw new PanelInputError('这本书还没有项目文件，先在面板里新建一本。', 409)
    const number = Number(body.number)
    if (!Number.isInteger(number) || number < 1) throw new PanelInputError('章号要是正整数。')
    const snapshot = await store.snapshot()
    if (!snapshot.plans.some((plan) => plan.number === number)) {
      throw new PanelInputError(`第${number}章还没有章纲，写不出派单书。先 novel_outline add_chapter。`, 409)
    }
    const brief = buildWriterBrief({
      snapshot,
      drafts: await store.allChapters(),
      chapter: number,
      config: deps.config,
      directive: '',
    })
    // The warnings ride on top of the card, not below it: this panel is read as
    // "what will the writer be told", and a rule that did not fit changes that
    // answer enough that it belongs before the text.
    const text =
      brief.warnings.length === 0
        ? brief.text
        : ['【注意：这几项没能进这一章的包】', ...brief.warnings.map((line) => `- ${line}`), '', '───', '', brief.text].join('\n')
    return { status: 200, body: { ok: true, data: { number, text, warnings: brief.warnings } } }
  } catch (error) {
    return failure(error)
  }
}

/**
 * What is waiting for a yes, as the album panel shows it.
 *
 * The queue is the one place where a subagent's reading can become a fact, so
 * the panel must be able to show it without a round trip through the chat.
 * Grouped by the chapter it was read out of, because that is the unit the author
 * just wrote.
 *
 * @param deps - route dependencies.
 * @param sessionId - the calling session.
 * @param root - an absolute project directory, when the browser named one.
 * @returns the items with the line that justifies each one.
 */
/**
 * Full-text search over every chapter, as the panel's search box uses it.
 *
 * The same walk the tool does, exposed over HTTP so the panel can answer
 * "where did I write that" without a round trip through the chat. Cheap enough
 * to run on every keystroke pause: a million characters take milliseconds.
 *
 * @param deps - route dependencies.
 * @param sessionId - the calling session.
 * @param query - what to look for.
 * @param root - an absolute project directory, when the browser named one.
 * @returns the hits, each with its chapter number so a click can open it.
 */
export async function searchRoute(
  deps: PanelDeps,
  sessionId: string | undefined,
  query: string,
  root: string | undefined,
): Promise<PanelAnswer> {
  try {
    const terms = parseTerms(query)
    if (terms.length === 0) return { status: 400, body: { ok: false, error: { message: '要搜什么？' } } }
    const store = storeFor(deps, sessionId, root)
    if (!(await store.exists())) return { status: 200, body: { ok: true, data: { terms, hits: [], matched: 0, scanned: 0 } } }
    const result = searchChapters(await store.allChapters(), terms, { limit: 60 })
    return {
      status: 200,
      body: {
        ok: true,
        data: {
          terms: result.terms,
          matched: result.matched,
          scanned: result.scanned,
          truncated: result.truncated,
          hits: result.hits.map((hit) => ({
            number: hit.number,
            title: hit.title,
            count: hit.count,
            samples: hit.samples,
          })),
        },
      },
    }
  } catch (error) {
    return failure(error)
  }
}

export async function pendingRoute(
  deps: PanelDeps,
  sessionId: string | undefined,
  root: string | undefined,
): Promise<PanelAnswer> {
  try {
    const store = storeFor(deps, sessionId, root)
    if (!(await store.exists())) return { status: 200, body: { ok: true, data: { items: [] } } }
    const items = await readPending(store.root)
    return {
      status: 200,
      body: {
        ok: true,
        data: {
          items: items.map((item) => ({
            id: item.id,
            kind: item.kind,
            kindLabel: PENDING_LABEL[item.kind] ?? item.kind,
            subject: item.subject,
            key: item.key,
            value: item.value,
            chapter: item.chapter,
            quote: item.quote,
            line: describePending(item),
          })),
        },
      },
    }
  } catch (error) {
    return failure(error)
  }
}

/**
 * Approve or reject what is waiting.
 *
 * `all` is the common path on purpose: reviewing ten proposals one at a time is
 * the same friction that made the old copy-them-by-hand flow useless.
 *
 * @param deps - route dependencies.
 * @param sessionId - the calling session.
 * @param body - `{ action: 'approve' | 'reject', all?: boolean, ids?: string[] }`.
 * @param root - an absolute project directory, when the browser named one.
 * @returns what landed.
 */
export async function settlePendingRoute(
  deps: PanelDeps,
  sessionId: string | undefined,
  body: Record<string, unknown>,
  root: string | undefined,
): Promise<PanelAnswer> {
  try {
    const store = storeFor(deps, sessionId, root)
    if (!(await store.exists())) throw new PanelInputError('这本书还没有项目文件，先在面板里新建一本。', 409)
    const action = String(body.action ?? '')
    if (action !== 'approve' && action !== 'reject') {
      throw new PanelInputError('action 只能是 approve 或 reject。')
    }
    const all = await readPending(store.root)
    const wanted = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : []
    const picked = body.all === true ? all : all.filter((item) => wanted.includes(item.id))
    if (picked.length === 0) {
      return { status: 200, body: { ok: true, data: { applied: 0, skipped: 0, waiting: all.length } } }
    }
    if (action === 'reject') {
      await removePending(store.root, picked.map((item) => item.id))
      return { status: 200, body: { ok: true, data: { applied: 0, skipped: picked.length, waiting: all.length - picked.length } } }
    }
    const result = await applyPendingBatch(store, picked)
    const done = result.applied.map((item) => item.id)
    if (done.length > 0) await removePending(store.root, done)
    return {
      status: 200,
      body: {
        ok: true,
        data: {
          applied: result.applied.length,
          skipped: result.skipped.length,
          waiting: all.length - done.length,
          lines: result.applied.map((item) => item.line),
          failures: result.skipped.map((item) => item.line),
        },
      },
    }
  } catch (error) {
    return failure(error)
  }
}

export async function readEntry(
  deps: PanelDeps,
  sessionId: string | undefined,
  kind: string | undefined,
  key: string | undefined,
  root: string | undefined,
): Promise<PanelAnswer> {
  try {
    if (
      kind !== 'character'
      && kind !== 'world'
      && kind !== 'chapter'
      && kind !== 'card'
      && kind !== 'place'
      && kind !== 'story'
      && kind !== 'timeline'
      && kind !== 'kind'
      && kind !== 'threads'
    ) {
      throw new PanelInputError(
        `未知的条目类型 ${kind ?? '（空）'}，只支持 character／world／chapter／card／place／story／timeline／kind／threads。`,
      )
    }
    if ((key === undefined || key === '') && kind !== 'timeline' && kind !== 'threads') {
      throw new PanelInputError('缺少 key：角色名、世界观名、地点名、故事点 id 或章号。')
    }
    const store = storeFor(deps, sessionId, root)
    if (!(await store.exists())) {
      return { status: 404, body: { ok: false, error: { message: '这本书还没有项目文件。' } } }
    }
    const snapshot = await store.snapshot()
    const number = Number(key)
    // A card page needs the prose too: "正文里出现了" compares the outline's cast
    // against what the chapter actually says.
    const aboutChapter = (kind === 'chapter' || kind === 'card') && Number.isInteger(number) && number > 0
    const drafts: ChapterDrafts[] = aboutChapter ? [{ number, rounds: await store.draftsOf(number) }] : []
    // The prose is the chapter page's main body, so it rides along with the page
    // rather than costing the browser a second request to show a preview.
    const prose = aboutChapter ? (await store.chapter(number))?.text : undefined
    const reviewRounds = kind === 'chapter' && aboutChapter ? await store.reviews(number) : []
    const entry = buildEntry(snapshot, kind as PanelEntryKind, key ?? '', drafts, store.root, prose, reviewRounds)
    if (entry === undefined) {
      return {
        status: 404,
        body: { ok: false, error: { message: `找不到 ${kind}「${key ?? ''}」。它可能刚被改名或删掉，刷新一下。` } },
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
    if (
      kind !== 'character'
      && kind !== 'world'
      && kind !== 'chapter'
      && kind !== 'card'
      && kind !== 'place'
      && kind !== 'story'
      && kind !== 'timeline'
      && kind !== 'kind'
    ) {
      throw new PanelInputError(
        `未知的条目类型 ${String(kind)}，只支持 character／world／chapter／card／place／story／timeline／kind。`,
      )
    }
    if (kind === 'timeline') {
      // The start is a setting, not an assertion about a chapter: it says where
      // the rail begins. Anchors stay tool-only — those quote the prose sentence
      // they came from, and the panel has no such sentence to store.
      const fields = body.fields
      if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
        throw new PanelInputError('fields 必须是一个对象。')
      }
      const start = (fields as Record<string, unknown>).start
      const anchorChapter = Number((fields as Record<string, unknown>).anchorChapter ?? 0)
      const anchorWhen = (fields as Record<string, unknown>).anchorWhen
      const anchorLabel = (fields as Record<string, unknown>).anchorLabel
      const clockWhen = (fields as Record<string, unknown>).clockWhen
      const clockChapters = (fields as Record<string, unknown>).clockChapters
      const picked = typeof clockChapters === 'string'
        ? clockChapters.split(/[,\s，、]+/).map((part) => Number(part)).filter((n) => Number.isInteger(n) && n > 0)
        : Array.isArray(clockChapters)
          ? clockChapters.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
          : []
      const dating = typeof clockWhen === 'string' && clockWhen.trim() !== ''
      if (
        typeof start !== 'string'
        && !(anchorChapter > 0 && typeof anchorWhen === 'string')
        && !dating
      ) {
        throw new PanelInputError(
          '时间线这里能写三样东西：全书起点（start）、某一章的日期（anchorChapter + anchorWhen），或者给选中的章节打一个日期（clockWhen + clockChapters）。',
          409,
        )
      }
      const store = storeFor(deps, sessionId, root)
      if (!(await store.exists())) {
        throw new PanelInputError('这本书还没有项目文件，先在面板里新建一本。', 409)
      }
      try {
        // One date over a picked set: chapters 1–10 are a month, chapter 7 is the
        // same month a year on. Dating eighty boxes one by one is why the clock
        // stayed empty in the author's own book.
        if (dating) {
          if (picked.length === 0) {
            throw new PanelInputError('要先选章节，再给它一个日期。', 409)
          }
          await addAnchors(store, { chapters: picked, when: String(clockWhen) })
        }
        // An anchor typed here is a person's statement, not the scanner's: the
        // label is what they meant by that date, and source stays 'manual' so a
        // later adopt pass does not think it came from prose.
        if (anchorChapter > 0 && typeof anchorWhen === 'string') {
          if (!Number.isInteger(anchorChapter) || anchorChapter < 1) {
            throw new PanelInputError(`章号要是正整数：${anchorChapter}`, 400)
          }
          await addAnchor(store, {
            chapter: anchorChapter,
            when: anchorWhen,
            label: typeof anchorLabel === 'string' ? anchorLabel : '',
            source: 'manual',
          })
        }
        if (typeof start === 'string') await setBookStart(store, start)
      } catch (error) {
        if (error instanceof PanelInputError) throw error
        throw new PanelInputError((error as Error).message, 400)
      }
      return await readEntry(deps, sessionId, 'timeline', 'clock', root)
    }
    if (kind === 'kind') {
      const store = storeFor(deps, sessionId, root)
      if (!(await store.exists())) {
        throw new PanelInputError('这本书还没有项目文件，先在面板里新建一本。', 409)
      }
      const from = typeof body.key === 'string' ? body.key.trim() : ''
      if (from === '') throw new PanelInputError('缺少 key：要改的那个类别名。')
      const fields = body.fields
      if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
        throw new PanelInputError('fields 必须是一个对象。')
      }
      const raw = (fields as Record<string, unknown>).to
      const to = typeof raw === 'string' ? raw.trim() : ''
      if (to === '') throw new PanelInputError('新类别名不能为空。想删掉这一类，改到「未分类」就好。')
      if (to === from) return await readEntry(deps, sessionId, 'kind', from, root)
      // One write, two words for it: rename when the target is new, merge when it
      // is not. Nothing else about the entries changes.
      await renameWorldKind(store, from, to)
      return await readEntry(deps, sessionId, 'kind', to, root)
    }
    const key = typeof body.key === 'string' ? body.key.trim() : ''
    if (key === '') throw new PanelInputError('缺少 key：角色名、世界观名、地点名、故事点 id 或章号。')
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
      // One merge function for every door (panel, tool, import), so a save that
      // mentions only the voice cannot quietly delete the relationship map.
      await updateCharacter(store, key, {
        role: edit.role,
        voice: edit.voice,
        appearance: edit.appearance,
        goal: edit.goal,
        secret: edit.secret,
        personality: edit.personality,
        status: edit.status,
        aliases: edit.aliases,
        stages: edit.stages,
        relations: edit.relations,
        notes: edit.notes,
      })
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
    } else if (kind === 'place') {
      const edit = readPlacePatch(key, patch)
      const existing = (await store.places()).find((item) => item.name === key)
      if (existing === undefined) {
        throw new PanelInputError(`找不到地点「${key}」。它可能刚被改名或删掉，刷新一下。`, 404)
      }
      const detail = edit.detail ?? existing.detail
      if (detail === '') throw new PanelInputError('地点的样子不能为空。')
      // The state history is replaced wholesale like every other card here, so
      // it has to be carried over: it is the record of what this place used to
      // look like, and dropping it is exactly the bug the page exists to stop.
      await store.upsertPlace({
        ...existing,
        detail,
        notes: edit.notes ?? existing.notes,
        updatedAt: new Date().toISOString(),
      })
    } else if (kind === 'story') {
      const edit = readStoryPatch(key, patch)
      const existing = (await store.storyPoints()).find((item) => item.id === key)
      if (existing === undefined) {
        throw new PanelInputError(`找不到故事点「${key}」。它可能刚被收尾或删掉，刷新一下。`, 404)
      }
      await store.upsertStoryPoint({
        ...existing,
        premise: edit.premise ?? existing.premise,
        notes: edit.notes ?? existing.notes,
      })
    } else if (kind === 'card') {
      // The card page owns the recap, the scene and the event list; the prose
      // has its own page now. `updateCard` is the only writer, so a card edited
      // here and one edited by `novel_outline action="card"` are the same merge
      // — including the revision stamp that keeps `stale` honest.
      const edit = readCardPatch(key, patch)
      const card = {
        ...(edit.title === undefined ? {} : { title: edit.title }),
        ...(edit.story === undefined ? {} : { summary: edit.story }),
        ...(edit.scene === undefined ? {} : { scene: edit.scene }),
        ...(edit.events === undefined ? {} : { events: edit.events }),
      }
      if (Object.keys(card).length === 0) {
        throw new PanelInputError('这张卡没有可保存的内容：故事梗概、场景、关键事件至少要填一项。')
      }
      try {
        await updateCard(store, edit.number, card)
      } catch (error) {
        if (!(error instanceof MissingPlanError)) throw error
        // An imported chapter can arrive without an outline. Give it the same
        // empty shell the volume picker would, then write the card onto it.
        const written = await store.chapter(edit.number)
        await store.upsertPlan(shellPlan(edit.number, UNASSIGNED, written))
        await updateCard(store, edit.number, card)
      }
    } else {
      const edit = readChapterPatch(key, patch)
      // An imported chapter can arrive with a body but no outline — the book's
      // outline stopped short of it, and every write door then refuses the
      // chapter, including the panel's own. Give it the empty shell the volume
      // picker would: no beats, no cast, nothing approved, nothing to violate.
      // This has to happen before the gate, which is what asks for the outline.
      const known = (await store.plans()).some((item) => item.number === edit.number)
      if (!known) {
        const written = await store.chapter(edit.number)
        const shell = shellPlan(edit.number, UNASSIGNED, written)
        // A chapter that already has prose was written before it had an
        // outline — an import, or a manuscript written elsewhere. The shell
        // carries no beats, so there is nothing left to approve; leaving it
        // unapproved would only lock the page that shows the chapter. A chapter
        // with no prose keeps the honest "not approved" and the gate applies.
        await store.upsertPlan(written === undefined ? shell : { ...shell, approved: true })
      }
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
      // The card travels with the prose: a chapter page edits both in one
      // submit, and a recap typed next to the text it describes is the whole
      // point of the card. Only fields the page actually sent are touched.
      if (edit.story !== undefined || edit.scene !== undefined || edit.events !== undefined) {
        const patch = {
          ...(edit.story === undefined ? {} : { summary: edit.story }),
          ...(edit.scene === undefined ? {} : { scene: edit.scene }),
          ...(edit.events === undefined ? {} : { events: edit.events }),
        }
        try {
          await updateCard(store, edit.number, patch)
        } catch (error) {
          if (!(error instanceof MissingPlanError)) throw error
          // An imported chapter can arrive without an outline. Give it the same
          // empty shell the volume picker would, then write the card.
          const written = await store.chapter(edit.number)
          await store.upsertPlan(shellPlan(edit.number, UNASSIGNED, written))
          await updateCard(store, edit.number, patch)
        }
      }
    }

    const snapshot = await store.snapshot()
    const number = Number(key)
    const aboutChapter = (kind === 'chapter' || kind === 'card') && Number.isInteger(number) && number > 0
    const drafts: ChapterDrafts[] = aboutChapter ? [{ number, rounds: await store.draftsOf(number) }] : []
    const prose = aboutChapter ? (await store.chapter(number))?.text : undefined
    const reviewRounds = kind === 'chapter' && aboutChapter ? await store.reviews(number) : []
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

      if (path === '/import-book') {
        if (isRead) {
          send(res, { status: 405, body: { ok: false, error: { message: '/import-book 需要 POST' } } })
          return
        }
        send(res, await importBook(deps, await readJson(req)))
        return
      }

      if (path === '/export') {
        const root = url.searchParams.get('root') ?? undefined
        if (isRead) {
          send(res, { status: 405, body: { ok: false, error: { message: '/export 需要 POST' } } })
          return
        }
        send(res, await exportBook(deps, await readJson(req), root))
        return
      }

      if (path === '/delete-book') {
        if (isRead) {
          send(res, { status: 405, body: { ok: false, error: { message: '/delete-book 需要 POST' } } })
          return
        }
        send(res, await removeBook(deps, await readJson(req)))
        return
      }

      if (path === '/backup') {
        const root = url.searchParams.get('root') ?? undefined
        if (isRead) {
          send(res, { status: 405, body: { ok: false, error: { message: '/backup 需要 POST' } } })
          return
        }
        send(res, await backupBook(deps, await readJson(req), root))
        return
      }

      if (path === '/volumes') {
        const sessionId = url.searchParams.get('session') ?? undefined
        const root = url.searchParams.get('root') ?? undefined
        if (isRead) {
          send(res, await readVolumeMap(deps, sessionId, root))
          return
        }
        send(res, await writeVolumeMap(deps, await readJson(req), sessionId, root))
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

      if (path === '/history') {
        send(
          res,
          await readHistoryRoute(
            deps,
            url.searchParams.get('session') ?? undefined,
            url.searchParams.get('target') ?? '',
            url.searchParams.get('root') ?? undefined,
          ),
        )
        return
      }

      if (path === '/revert') {
        if (isRead) {
          send(res, { status: 405, body: { ok: false, error: { message: '/revert 需要 POST' } } })
          return
        }
        send(
          res,
          await revertRoute(
            deps,
            url.searchParams.get('session') ?? undefined,
            await readJson(req),
            url.searchParams.get('root') ?? undefined,
          ),
        )
        return
      }

      if (path === '/new') {
        if (isRead) {
          send(res, { status: 405, body: { ok: false, error: { message: '/new 需要 POST' } } })
          return
        }
        send(
          res,
          await createRoute(
            deps,
            url.searchParams.get('session') ?? undefined,
            await readJson(req),
            url.searchParams.get('root') ?? undefined,
          ),
        )
        return
      }

      if (path === '/chapter-plan') {
        if (isRead) {
          send(res, { status: 405, body: { ok: false, error: { message: '/chapter-plan 需要 POST' } } })
          return
        }
        send(
          res,
          await addChapterRoute(
            deps,
            url.searchParams.get('session') ?? undefined,
            await readJson(req),
            url.searchParams.get('root') ?? undefined,
          ),
        )
        return
      }

      if (path === '/search') {
        if (!isRead) {
          send(res, { status: 405, body: { ok: false, error: { message: '/search 只读' } } })
          return
        }
        send(
          res,
          await searchRoute(
            deps,
            url.searchParams.get('session') ?? undefined,
            url.searchParams.get('q') ?? '',
            url.searchParams.get('root') ?? undefined,
          ),
        )
        return
      }

      if (path === '/pending') {
        if (isRead) {
          send(res, await pendingRoute(deps, url.searchParams.get('session') ?? undefined, url.searchParams.get('root') ?? undefined))
          return
        }
        send(
          res,
          await settlePendingRoute(
            deps,
            url.searchParams.get('session') ?? undefined,
            await readJson(req),
            url.searchParams.get('root') ?? undefined,
          ),
        )
        return
      }

      if (path === '/card') {
        if (isRead) {
          send(res, { status: 405, body: { ok: false, error: { message: '/card 需要 POST' } } })
          return
        }
        send(
          res,
          await cardRoute(
            deps,
            url.searchParams.get('session') ?? undefined,
            await readJson(req),
            url.searchParams.get('root') ?? undefined,
          ),
        )
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
