/**
 * The pending queue: what a subagent proposed, waiting for a person to say yes.
 *
 * The keeper used to propose in the chat and then stop. Every proposal it made
 * had to be retyped into a tool call by hand — five tools across four files,
 * one line at a time — and the honest outcome of that design is that people
 * stop filing. The book then grows without its records, which is the exact
 * failure the records exist to prevent.
 *
 * The other extreme is worse. A keeper that writes by itself would edit the
 * character cards after every chapter, and a card is not a summary of the prose
 * — it is the author's judgement about a person. Overwriting that judgement
 * with a reading is how a good card becomes a machine's guess.
 *
 * So: propose into a queue, approve in bulk, write once. Nothing in this module
 * touches the canon; it only remembers what was suggested.
 */
import { mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { KeeperProposal } from '../roles.ts'

/** Folder inside a project that holds the queue. */
export const PENDING_DIR = 'pending'

/** One proposal, as it waits. */
export interface PendingItem extends KeeperProposal {
  /** Stable handle, e.g. `p-0007`. */
  id: string
  /** When it was proposed. */
  at: string
  /** Which chapter it was read out of. */
  sourceChapter: number
  /** Where it came from, so a wrong batch can be traced to one dispatch. */
  role: string
}

/** The whole queue. */
export interface PendingFile {
  items: PendingItem[]
}

/** How many stay in the queue before the oldest are dropped. */
export const PENDING_KEEP = 500

/**
 * Read the queue. A missing file means "nothing waiting", not an error.
 *
 * @param root - project directory.
 * @returns the items, oldest first.
 */
export async function readPending(root: string): Promise<PendingItem[]> {
  const raw = await readFile(join(root, PENDING_DIR, 'queue.json'), 'utf8').catch(() => '')
  if (raw.trim() === '') return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return []
    const items = (parsed as PendingFile).items
    return Array.isArray(items) ? items.filter(isItem) : []
  } catch {
    return []
  }
}

/** Whether one entry from disk has the shape this module writes. */
function isItem(value: unknown): value is PendingItem {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.kind === 'string' &&
    typeof record.subject === 'string' &&
    typeof record.value === 'string' &&
    typeof record.chapter === 'number' &&
    typeof record.at === 'string'
  )
}

/** Write the queue back, atomically. */
async function writePending(root: string, items: readonly PendingItem[]): Promise<void> {
  const dir = join(root, PENDING_DIR)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'queue.json')
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify({ items }, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

/**
 * Add proposals to the queue, skipping ones already waiting.
 *
 * "Already waiting" is decided on the whole content, not just the subject: a
 * character's goal changing twice in one book is two proposals, while the same
 * dispatch read twice is not. Without this, re-running a chapter's keeper piles
 * up duplicates and the queue becomes unreadable, which is how a review queue
 * dies.
 *
 * @param root - project directory.
 * @param proposals - what the keeper said.
 * @param sourceChapter - the chapter it read.
 * @param role - the role that proposed them.
 * @param now - timestamp.
 * @returns the items added, and how many were duplicates.
 */
export async function pushPending(
  root: string,
  proposals: readonly KeeperProposal[],
  sourceChapter: number,
  role: string,
  now: Date = new Date(),
): Promise<{ added: PendingItem[]; duplicates: number }> {
  const items = await readPending(root)
  const seen = new Set(items.map(fingerprint))
  const added: PendingItem[] = []
  let duplicates = 0
  let next = items.length === 0 ? 0 : Math.max(...items.map((item) => Number(item.id.slice(2)) || 0))
  for (const proposal of proposals) {
    const print = fingerprint(proposal)
    if (seen.has(print)) {
      duplicates += 1
      continue
    }
    seen.add(print)
    next += 1
    added.push({
      ...proposal,
      id: `p-${String(next).padStart(4, '0')}`,
      at: now.toISOString(),
      sourceChapter,
      role,
    })
  }
  if (added.length === 0) return { added: [], duplicates }
  const all = [...items, ...added]
  await writePending(root, all.slice(-PENDING_KEEP))
  return { added, duplicates }
}

/** What makes two proposals the same suggestion. */
function fingerprint(item: KeeperProposal): string {
  return [item.kind, item.subject, item.key, item.value, item.chapter].join('\u0001')
}

/**
 * Drop items from the queue by id.
 *
 * @param root - project directory.
 * @param ids - which ones to remove (approved or rejected, the caller decides).
 * @returns how many were actually there.
 */
export async function removePending(root: string, ids: readonly string[]): Promise<number> {
  const items = await readPending(root)
  const drop = new Set(ids)
  const kept = items.filter((item) => !drop.has(item.id))
  const removed = items.length - kept.length
  if (removed > 0) await writePending(root, kept)
  return removed
}

/**
 * Empty the queue.
 *
 * @param root - project directory.
 * @returns how many were discarded.
 */
export async function clearPending(root: string): Promise<number> {
  const items = await readPending(root)
  if (items.length > 0) await rm(join(root, PENDING_DIR, 'queue.json'), { force: true })
  return items.length
}

/**
 * One proposal as the report and the panel show it.
 *
 * The quote rides along because it is the only thing that lets a person decide
 * in one glance instead of opening the chapter.
 *
 * @param item - the proposal.
 * @returns one line.
 */
export function describePending(item: PendingItem): string {
  const kind = PENDING_LABEL[item.kind] ?? item.kind
  const quote = item.quote === '' ? '' : `｜「${item.quote.slice(0, 40)}」`
  return `[${kind}] ${item.subject}${item.key === '' ? '' : `·${item.key}`}：${item.value}${quote}`
}

/** What each kind means, in the author's words. */
export const PENDING_LABEL: Record<string, string> = {
  ledger: '事实',
  place: '地点',
  stage: '人物阶段',
  anchor: '日期',
  card: '章卡',
}
