/**
 * The shelf: which books this dsh has opened, so the panel can offer them.
 *
 * A book is a directory with `project.json` in it. Nothing indexes them: a
 * writer may keep one under `D:\ novels\雾港` and another in a workspace, and
 * the panel cannot guess which. So the panel keeps a small list of the roots it
 * has seen — created here, opened here, or resolved for a session — and shows
 * the ones that still exist.
 *
 * The file lives next to dsh's own state (`$DSH_HOME`, else `~/.dsh`) rather
 * than inside any one workspace: the shelf is a property of this machine, the
 * way a recent-files list is. It holds absolute paths and nothing else — no
 * titles, no text — so a stale entry costs one `exists()` and no privacy.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { bookKey, dshHome } from '../domain/home.ts'
import type { ProjectStore } from '../domain/store.ts'
import type { Phase } from '../domain/types.ts'

/** How many roots the shelf remembers before the oldest is dropped. */
export const MAX_SHELF = 40

/** One remembered book. `at` is an ISO timestamp, used only for ordering. */
export interface ShelfEntry {
  root: string
  at: string
}

/** One book as the library page shows it. */
export interface LibraryBook {
  /** Absolute project root (the directory that holds `project.json`). */
  root: string
  title: string
  phase: Phase
  /** Chapters that have a body on disk. */
  chapters: number
  /** Their summed character count, as the index recorded it. */
  words: number
  /** When the book last changed, from `project.json`. */
  updatedAt: string
  /** True for the book this session would open without being asked. */
  current: boolean
}

/**
 * dsh's state directory, shared with the rest of the plugin.
 *
 * @returns `$DSH_HOME` when set (dsh itself honours it), else `~/.dsh`.
 */
export { bookKey, dshHome }

/**
 * Where the shelf lives.
 *
 * @returns an absolute path; the directory may not exist yet.
 */
export function libraryFile(): string {
  return join(dshHome(), 'inkwell', 'books.json')
}

/**
 * Read the shelf, tolerating anything.
 *
 * A missing file is an empty shelf. A file someone edited by hand is filtered
 * down to the entries that still look like `{ root, at }` rather than throwing:
 * a broken recent-list must never break the panel.
 *
 * @param file - the shelf path.
 * @returns the entries, most recent first, deduplicated.
 */
export async function readShelf(file: string): Promise<ShelfEntry[]> {
  const raw = await readFile(file, 'utf8').catch(() => '')
  if (raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { books?: unknown }).books)
      ? (parsed as { books: unknown[] }).books
      : []
  const seen = new Set<string>()
  const entries: ShelfEntry[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const root = (item as { root?: unknown }).root
    if (typeof root !== 'string' || root.trim() === '') continue
    const key = bookKey(root)
    if (seen.has(key)) continue
    seen.add(key)
    const at = (item as { at?: unknown }).at
    entries.push({ root: resolve(root), at: typeof at === 'string' ? at : '' })
  }
  return entries
}

/**
 * Write the shelf.
 *
 * @param file - the shelf path; its directory is created.
 * @param entries - the entries, most recent first.
 */
export async function writeShelf(file: string, entries: readonly ShelfEntry[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const trimmed = entries.slice(0, MAX_SHELF)
  await writeFile(file, `${JSON.stringify({ version: 1, books: trimmed }, null, 2)}\n`, 'utf8')
}

/**
 * Put a root at the top of the shelf.
 *
 * Called when a book is created, opened by path, or resolved for a session. A
 * root already at the top is left alone: the snapshot route runs on a poll, and
 * a file rewritten every fifteen seconds is churn, not truth. Anything else is
 * promoted, so "recently opened" stays true across a long session.
 *
 * @param file - the shelf path.
 * @param root - the book's project root.
 */
export async function rememberBook(file: string, root: string): Promise<void> {
  const entries = await readShelf(file)
  const wanted = resolve(root)
  const first = entries[0]
  if (first !== undefined && bookKey(first.root) === bookKey(wanted)) return
  const next: ShelfEntry[] = [
    { root: wanted, at: new Date().toISOString() },
    ...entries.filter((entry) => bookKey(entry.root) !== bookKey(wanted)),
  ]
  try {
    await writeShelf(file, next)
  } catch {
    // A read-only state directory costs the shelf, not the panel.
  }
}

/**
 * Describe one book, or `undefined` when there is nothing there.
 *
 * @param store - a store rooted at the book.
 * @returns the row the library page renders.
 */
export async function describeBook(store: ProjectStore): Promise<Omit<LibraryBook, 'current'> | undefined> {
  if (!(await store.exists())) return undefined
  const project = await store.readProject().catch(() => undefined)
  if (project === undefined) return undefined
  const chapters = await store.chapters().catch(() => [])
  return {
    root: store.root,
    title: project.title,
    phase: project.phase,
    chapters: chapters.length,
    words: chapters.reduce((sum, chapter) => sum + (Number.isFinite(chapter.words) ? chapter.words : 0), 0),
    updatedAt: project.updatedAt,
  }
}
