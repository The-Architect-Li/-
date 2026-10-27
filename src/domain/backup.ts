/**
 * Backups: a copy of the whole book, so a bad edit has somewhere to go back to.
 *
 * Two decisions live here and both come from what a writer actually loses.
 *
 * **The copy is a plain zip, next to the other books' copies, not inside the
 * book.** Inside `.novel` it would be backed up by the next backup (recursive,
 * growing fast) and it would show up in the folder the writer browses. It lives
 * under `$DSH_HOME/inkwell/backups/<book>/`, which also means deleting the book
 * folder by accident still leaves the copies.
 *
 * **Restoring does not delete.** A zip that only knows the old files would leave
 * a chapter that was added after the backup in place, so the book would be a mix
 * of two moments — worse than either. This module writes what the zip has, keeps
 * what it does not, and *reports* the leftovers so the author decides. It also
 * takes a copy of the current state first, so a restore can itself be undone.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { bookKey, inkwellStateDir } from './home.ts'

/** How many copies of one book are kept; the newest survive. */
export const MAX_BACKUPS = 20

/** Directories inside a book that are output, not the book itself. */
const SKIP = new Set(['exports', 'node_modules', '.git'])

/** One file as it travels in and out of a zip. */
export interface BackupFile {
  path: string
  text: string
}

/** A copy on disk, as the panel and the report describe it. */
export interface BackupEntry {
  name: string
  path: string
  bytes: number
  at: string
  files: number
}

/** What one `make` produced, and what it removed to stay inside the limit. */
export interface BackupResult {
  entry: BackupEntry
  pruned: string[]
}

/** What one restore wrote, skipped, and left behind. */
export interface RestoreResult {
  name: string
  written: string[]
  unchanged: string[]
  extra: string[]
  safety: BackupEntry | undefined
}

/**
 * Where this book's copies live.
 *
 * @param root - the book directory (`.novel`).
 * @returns an absolute directory; it may not exist yet.
 */
export function backupDirFor(root: string): string {
  // The name a writer recognises is the folder they write in, not the `.novel`
  // inside it: `待定v2` rather than `c--users-china-documents-.-v2-.novel`. A
  // short hash of the full path keeps two books with one name apart, and keeps
  // the name stable when the drive letter's case changes.
  const folder = basename(dirname(resolve(root)))
  const safe = folder.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  const hash = createHash('sha1').update(bookKey(root)).digest('hex').slice(0, 8)
  return join(inkwellStateDir(), 'backups', `${safe === '' ? 'book' : safe}-${hash}`)
}

/**
 * A file-name-safe timestamp that sorts like the clock.
 *
 * @param when - the moment to stamp.
 * @returns `2026-10-27T19-31-05` (colons are illegal on Windows).
 */
export function stampOf(when: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return [
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`,
    `T${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`,
  ].join('')
}

/** Whether a name is a copy this module wrote (and never a path). */
export function isBackupName(name: string): boolean {
  return /^[A-Za-z0-9._-]+\.zip$/.test(name) && !name.includes('..')
}

// --- zip ------------------------------------------------------------------

/** The CRC table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/**
 * CRC-32 of a byte range, as zip requires it.
 *
 * @param bytes - the data.
 * @returns the checksum.
 */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * MS-DOS time and date, which is what a zip header carries.
 *
 * @param when - the moment.
 * @returns the two 16-bit halves.
 */
function dosStamp(when: Date): { time: number; date: number } {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2)
  const date = ((Math.max(when.getFullYear(), 1980) - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()
  return { time, date }
}

/**
 * Pack files into a zip, stored rather than deflated.
 *
 * Stored because a book is text and a few hundred kilobytes: the CPU saved on
 * compression is worth nothing, and a format this code writes byte by byte is a
 * format this code can be sure about. Every archiver reads stored entries.
 *
 * @param files - path/text pairs, paths relative to the book.
 * @param when - the timestamp to record.
 * @returns the zip bytes.
 */
export function writeZip(files: readonly BackupFile[], when: Date): Buffer {
  const { time, date } = dosStamp(when)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(file.path.split(sep).join('/'), 'utf8')
    const data = Buffer.from(file.text, 'utf8')
    const checksum = crc32(data)

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // names are UTF-8
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)

    locals.push(local, data)
    centrals.push(central)
    offset += local.length + data.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, directory, end])
}

/**
 * Unpack a zip this module wrote.
 *
 * @param buffer - the zip bytes.
 * @returns the files, paths with `/` as the separator.
 */
export function readZip(buffer: Buffer): BackupFile[] {
  const endAt = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (endAt < 0) throw new Error('这不是一个 zip 文件（找不到中央目录）。')
  const count = buffer.readUInt16LE(endAt + 10)
  let cursor = buffer.readUInt32LE(endAt + 16)
  const files: BackupFile[] = []

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('zip 的中央目录读不下去了。')
    const size = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localAt = buffer.readUInt32LE(cursor + 42)
    const path = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')

    // The local header repeats the name and its own extra field; the data starts
    // after *those*, not after the central directory's copy.
    const localNameLength = buffer.readUInt16LE(localAt + 26)
    const localExtraLength = buffer.readUInt16LE(localAt + 28)
    const dataAt = localAt + 30 + localNameLength + localExtraLength
    files.push({ path, text: buffer.subarray(dataAt, dataAt + size).toString('utf8') })

    cursor += 46 + nameLength + extraLength + commentLength
  }
  return files
}

// --- reading the book ------------------------------------------------------

/**
 * Every file of a book, as text, with `/`-separated relative paths.
 *
 * @param root - the book directory.
 * @returns the files, sorted by path so two backups of one book difft cleanly.
 */
export async function collectBook(root: string): Promise<BackupFile[]> {
  const files: BackupFile[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      files.push({ path: relative(root, full).split(sep).join('/'), text: await readFile(full, 'utf8') })
    }
  }
  await walk(root)
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

/**
 * The copies of one book, newest first.
 *
 * @param root - the book directory.
 * @returns what is on disk; a book with no copies returns `[]`.
 */
export async function listBackups(root: string): Promise<BackupEntry[]> {
  const dir = backupDirFor(root)
  const names = (await readdir(dir).catch(() => [] as string[])).filter(isBackupName)
  const entries: BackupEntry[] = []
  for (const name of names) {
    const path = join(dir, name)
    const info = await stat(path).catch(() => undefined)
    if (info === undefined) continue
    const files = readZip(await readFile(path)).length
    entries.push({ name, path, bytes: info.size, at: stampFromName(name) ?? info.mtime.toISOString(), files })
  }
  return entries.sort((left, right) => (left.name < right.name ? 1 : left.name > right.name ? -1 : 0))
}

/**
 * Read a timestamp back out of a copy's name.
 *
 * @param name - the file name.
 * @returns `2026-10-27T19:31:05.000Z`-ish text, or `undefined` when the name
 *   was not one of ours (a `pre-restore-` copy still carries its stamp).
 */
export function stampFromName(name: string): string | undefined {
  const match = /(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(name)
  if (match === null) return undefined
  const [, year, month, day, hour, minute, second] = match
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`
}

/**
 * Write one copy of the book and keep only the newest few.
 *
 * @param root - the book directory.
 * @param options - `label` prefixes the name (`pre-restore`), `when` stamps it.
 * @returns the copy, and the names dropped to stay inside the limit.
 */
export async function packageBook(
  root: string,
  options: { label?: string; when?: Date } = {},
): Promise<BackupResult> {
  const when = options.when ?? new Date()
  const stamp = stampOf(when)
  const name = `${options.label === undefined ? '' : `${options.label}-`}${stamp}.zip`
  const dir = backupDirFor(root)
  await mkdir(dir, { recursive: true })

  const files = await collectBook(root)
  const buffer = writeZip(files, when)
  const path = join(dir, name)
  await writeFile(path, buffer)

  const kept = await listBackups(root)
  const pruned: string[] = []
  // The label copies are the undo log of restores, not the history the limit is
  // about; only plain copies are pruned.
  const plain = kept.filter((entry) => !entry.name.startsWith('pre-restore-'))
  for (const entry of plain.slice(MAX_BACKUPS)) {
    await rm(entry.path, { force: true })
    pruned.push(entry.name)
  }

  return {
    entry: { name, path, bytes: buffer.length, at: stamp, files: files.length },
    pruned,
  }
}

/**
 * Put the book back to a copy, and keep an undo copy of what it was.
 *
 * Files in the copy are written; files the copy does not know about are left
 * alone and reported, because silently deleting a chapter the author wrote after
 * the backup is the one thing a restore must never do.
 *
 * @param root - the book directory.
 * @param name - the copy's file name.
 * @param options - `when` stamps the undo copy.
 * @returns what was written, what was already identical, what was left over.
 */
export async function restoreBook(
  root: string,
  name: string,
  options: { when?: Date } = {},
): Promise<RestoreResult> {
  if (!isBackupName(name)) throw new Error(`不是一份备份的文件名：${name}`)
  const dir = backupDirFor(root)
  const path = join(dir, name)
  const exists = await stat(path).catch(() => undefined)
  if (exists === undefined) throw new Error(`没有这份备份：${name}。用 novel_backup action="list" 看看有哪些。`)

  const when = options.when ?? new Date()
  const safety = await packageBook(root, { label: 'pre-restore', when })
  const files = readZip(await readFile(path))

  const written: string[] = []
  const unchanged: string[] = []
  for (const file of files) {
    const target = join(root, file.path)
    const current = await readFile(target, 'utf8').catch(() => undefined)
    if (current === file.text) {
      unchanged.push(file.path)
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.text, 'utf8')
    written.push(file.path)
  }

  const known = new Set(files.map((file) => file.path))
  const extra = (await collectBook(root)).map((file) => file.path).filter((file) => !known.has(file))

  return { name, written, unchanged, extra, safety: safety.entry }
}

/**
 * One line about a copy, for a report or a panel row.
 *
 * @param entry - the copy.
 * @returns e.g. `2026-10-27T19:31:05 · 96 个文件 · 412 KB`.
 */
export function describeBackup(entry: BackupEntry): string {
  const kilobytes = Math.max(1, Math.round(entry.bytes / 1024))
  return `${entry.at} · ${entry.files} 个文件 · ${kilobytes} KB`
}

/**
 * The directory this module keeps copies in, for a report that has to say where.
 *
 * @param root - the book directory.
 * @returns the absolute path.
 */
export function backupHome(root: string): string {
  return resolve(backupDirFor(root))
}
