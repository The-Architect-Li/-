/**
 * Per-file history: the last few versions of one chapter or one canon file.
 *
 * Backups (`domain/backup.ts`) answer "give me the whole book as of yesterday".
 * That is the right tool for "I broke something and I am not sure what", and the
 * wrong tool for "world.json was fine an hour ago, put that one file back" — it
 * restores ninety-nine files to undo one.
 *
 * Three decisions live here:
 *
 * **Copies live inside the book** (`<root>/.history/`), unlike backups which live
 * outside on purpose. A per-file copy is small and belongs to the file it
 * shadows; keeping it in the book means it travels when the book is moved or
 * committed. Backups stay outside because losing the folder is exactly when you
 * want them.
 *
 * **The newest copy of a changed file is the one that was there before the write.**
 * We record *before* overwriting, so `list()` reads as "the states this file has
 * been in", newest first, and the current content is not among them.
 *
 * **Empty files are not recorded.** A freshly initialised book has a dozen empty
 * JSON files; keeping a version of emptiness once per save would bury the one
 * version anybody wants.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** What kind of thing a revision belongs to. */
export type HistoryKind = 'chapter' | 'canon'

/** How many versions each kind keeps. Chapters are big; canon files are not. */
export const HISTORY_KEEP: Record<HistoryKind, number> = {
  chapter: 5,
  canon: 20,
}

/** Where a book keeps its per-file copies. */
export const HISTORY_DIR = '.history'

/** One stored revision, as the panel and the report list it. */
export interface HistoryEntry {
  /** File name without extension; the only handle a caller needs. */
  rev: string
  bytes: number
  /** ISO timestamp of when the copy was taken. */
  at: string
}


/** File-system-safe version of a name that may contain Chinese, spaces or slashes. */
function safeName(raw: string): string {
  const clean = String(raw ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^\.+/, '')
  return clean.slice(0, 60) || 'unknown'
}

/** Directory holding every revision of one named thing. */
export function historyDir(root: string, kind: HistoryKind, name: string): string {
  // Chapters are stored under `ch007`, not `7` — `writeChapter` decides that, and
  // a reader who asks for `chapter:7` must land in the same folder or it sees an
  // empty history for a chapter that has plenty of versions.
  const handle = kind === 'chapter' && /^\d+$/.test(name) ? chapterHistoryName(Number(name)) : name
  return join(root, HISTORY_DIR, kind, safeName(handle))
}

/**
 * Copy the previous content aside before it gets overwritten.
 *
 * @param root - project directory.
 * @param kind - chapter or canon file.
 * @param name - stable handle (`ch007`, `characters`).
 * @param text - content about to be replaced.
 * @param options - `keep` overrides the per-kind default.
 * @returns the entry written, or `undefined` when there was nothing worth keeping.
 */
export async function recordHistory(
  root: string,
  kind: HistoryKind,
  name: string,
  text: string,
  options: { keep?: number } = {},
): Promise<HistoryEntry | undefined> {
  if (String(text ?? '').trim() === '') return undefined
  const dir = historyDir(root, kind, name)
  await mkdir(dir, { recursive: true })

  let rev = new Date().toISOString().replace(/[:.]/g, '-')
  let file = join(dir, `${rev}.md`)
  for (let attempt = 1; attempt < 100; attempt += 1) {
    try {
      await stat(file)
      rev = `${new Date().toISOString().replace(/[:.]/g, '-')}-${attempt}`
      file = join(dir, `${rev}.md`)
    } catch {
      break
    }
  }

  await writeFile(file, text, 'utf8')
  const keep = Math.max(1, options.keep ?? HISTORY_KEEP[kind])
  await prune(dir, keep)
  return { rev, bytes: Buffer.byteLength(text, 'utf8'), at: new Date().toISOString() }
}

/** Keep the newest `keep` copies, drop the rest. Names sort chronologically. */
async function prune(dir: string, keep: number): Promise<void> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((file) => file.endsWith('.md')).sort()
  const extra = files.slice(0, Math.max(0, files.length - keep))
  for (const file of extra) await rm(join(dir, file), { force: true }).catch(() => {})
}

/** Every stored revision, newest first. Empty when the file never changed. */
export async function listHistory(root: string, kind: HistoryKind, name: string): Promise<HistoryEntry[]> {
  const dir = historyDir(root, kind, name)
  const files = (await readdir(dir).catch(() => [] as string[])).filter((file) => file.endsWith('.md'))
  const out: HistoryEntry[] = []
  for (const file of files) {
    const info = await stat(join(dir, file)).catch(() => undefined)
    if (info === undefined) continue
    out.push({ rev: file.replace(/\.md$/, ''), bytes: info.size, at: info.mtime.toISOString() })
  }
  return out.sort((a, b) => b.rev.localeCompare(a.rev))
}

const REV = /^[A-Za-z0-9_-]{1,80}$/

/** Read one revision back. Throws when the handle is malformed or gone. */
export async function readHistory(root: string, kind: HistoryKind, name: string, rev: string): Promise<string> {
  if (!REV.test(String(rev ?? ''))) throw new Error(`版本号不合法：${rev}`)
  const file = join(historyDir(root, kind, name), `${rev}.md`)
  try {
    return await readFile(file, 'utf8')
  } catch {
    throw new Error(`没有这个版本：${rev}。用 history 列一下现有的。`)
  }
}

/** Parse `"chapter:7"` / `"canon:characters"` into its parts. */
export function parseTarget(target: string): { kind: HistoryKind; name: string } {
  const raw = String(target ?? '').trim()
  const at = raw.indexOf(':')
  if (at <= 0) {
    throw new Error('target 要写成「类别:名字」——例如 chapter:7、canon:characters。')
  }
  const kind = raw.slice(0, at) as HistoryKind
  const name = raw.slice(at + 1).trim()
  if (kind !== 'chapter' && kind !== 'canon') {
    throw new Error(`不认识的类别：${kind}。只支持 chapter / canon。`)
  }
  if (name === '') throw new Error('target 缺少名字，例如 chapter:7。')
  if (kind === 'chapter' && !/^\d+$/.test(name)) throw new Error('chapter 的 target 要写章号，例如 chapter:7。')
  return { kind, name }
}

/** The handle a chapter's revisions are stored under. */
export function chapterHistoryName(number: number): string {
  return `ch${String(number).padStart(3, '0')}`
}
