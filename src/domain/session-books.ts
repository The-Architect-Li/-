/**
 * Which book each conversation is working on.
 *
 * Until v0.10 a session's book was decided entirely by its working directory:
 * one conversation, one book. That is fine until the writer finishes a draft and
 * wants to look at another book without opening another conversation or moving
 * directories. So a session may now *pin* a book: `novel_project action="open"`
 * writes the choice here, and every later `novel_*` call in that session reads
 * it — the tools and the panel resolve the same way, so switching books in the
 * chat switches the sidebar too.
 *
 * Nothing else lives here: no titles, no text, only session ids and absolute
 * paths. A pin whose book has been deleted or moved is ignored, not repaired:
 * the fallback is the session's own workspace, which is always answerable.
 *
 * Reads are synchronous on purpose. `storeFor` is called at the top of every
 * tool body and in the gate, and a tool body may not await before it knows which
 * book it is talking about. The file is a few hundred bytes.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { bookKey, inkwellStateDir } from './home.ts'
import { PROJECT_FILE } from './store.ts'

/** How many sessions the pin file remembers before the oldest is dropped. */
export const MAX_PINS = 50

/** One session's pinned book. `at` is an ISO timestamp, used only for ordering. */
export interface SessionPin {
  root: string
  at: string
}

/** On-disk shape, versioned so a future change can migrate instead of guess. */
interface PinFile {
  version: 1
  sessions: Record<string, SessionPin>
}

/**
 * Where the pins live.
 *
 * @returns an absolute path; the directory may not exist yet.
 */
export function sessionsFile(): string {
  return join(inkwellStateDir(), 'sessions.json')
}

/**
 * Read the pin map.
 *
 * A missing, empty, malformed or wrongly-shaped file all read as "no pins":
 * losing a convenience pointer must never make a tool call fail.
 *
 * @param file - the pin file.
 * @returns session id → absolute project root.
 */
export function readPins(file: string): Map<string, string> {
  const pins = new Map<string, string>()
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return pins
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return pins
  }
  const sessions = (parsed as PinFile | null)?.sessions
  if (typeof sessions !== 'object' || sessions === null) return pins
  for (const [id, entry] of Object.entries(sessions as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue
    const root = (entry as SessionPin).root
    if (typeof root === 'string' && root.trim() !== '') pins.set(id, resolve(root))
  }
  return pins
}

/**
 * Write the pin map, oldest entries dropped first.
 *
 * @param file - the pin file.
 * @param pins - session id → absolute project root.
 * @param order - the order to keep on overflow; newest first.
 */
function writePins(file: string, pins: Map<string, string>, order: readonly string[]): void {
  const sessions: Record<string, SessionPin> = {}
  const now = new Date().toISOString()
  for (const id of order.slice(0, MAX_PINS)) {
    const root = pins.get(id)
    if (root !== undefined) sessions[id] = { root, at: now }
  }
  const next: PinFile = { version: 1, sessions }
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}

/** Session ids in an existing file, newest first, for overflow order. */
function existingOrder(file: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as PinFile
    const sessions = parsed.sessions ?? {}
    return Object.entries(sessions)
      .sort((left, right) => String(right[1]?.at ?? '').localeCompare(String(left[1]?.at ?? '')))
      .map(([id]) => id)
  } catch {
    return []
  }
}

/**
 * Remember that one session is working on one book.
 *
 * Writing the file is best-effort: a read-only state directory must not stop the
 * conversation from switching books for this process. The failure is silent by
 * design, the way the shelf's is.
 *
 * @param file - the pin file.
 * @param sessionId - the conversation.
 * @param root - the absolute project root it should use from now on.
 */
export function pinBook(file: string, sessionId: string, root: string): void {
  if (sessionId.trim() === '') return
  const pins = readPins(file)
  pins.set(sessionId, resolve(root))
  const order = [sessionId, ...existingOrder(file).filter((id) => id !== sessionId)]
  try {
    writePins(file, pins, order)
  } catch {
    // A pinned book is a convenience; the tools still work from the workspace.
  }
}

/**
 * Forget one session's pinned book, returning it to its workspace default.
 *
 * @param file - the pin file.
 * @param sessionId - the conversation.
 */
export function unpinBook(file: string, sessionId: string): void {
  if (sessionId.trim() === '') return
  const pins = readPins(file)
  pins.delete(sessionId)
  const order = existingOrder(file).filter((id) => id !== sessionId)
  try {
    writePins(file, pins, order)
  } catch {
    // Same reasoning as pinBook.
  }
}

/**
 * The book one session pinned, when it still exists on disk.
 *
 * @param file - the pin file.
 * @param sessionId - the conversation.
 * @returns the absolute project root, or `undefined` when there is no usable pin.
 */
export function pinnedRoot(file: string, sessionId: string): string | undefined {
  if (sessionId.trim() === '') return undefined
  const root = readPins(file).get(sessionId)
  if (root === undefined) return undefined
  return existsSync(join(root, PROJECT_FILE)) ? root : undefined
}

/**
 * Every pin, for the panel and for `novel_project action="books"`.
 *
 * @param file - the pin file.
 * @returns session id → root, with the ones whose book is gone filtered out.
 */
export function livePins(file: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const [id, root] of readPins(file)) {
    if (existsSync(join(root, PROJECT_FILE))) out.set(id, root)
  }
  return out
}

/**
 * Whether two roots name the same book.
 *
 * @param left - any absolute path.
 * @param right - any absolute path.
 * @returns true when both resolve to the same directory, case-insensitively on Windows.
 */
export function sameBook(left: string, right: string): boolean {
  return bookKey(left) === bookKey(right)
}
