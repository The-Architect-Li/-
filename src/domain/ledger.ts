/**
 * The fact ledger.
 *
 * Every assertion about the world is written down with the chapter that made
 * it. A contradicting assertion is refused unless it explicitly names the entry
 * it replaces, so "her eyes were black in chapter 3 and blue in chapter 5" can
 * only happen on purpose.
 */
import type { LedgerEntry } from './types.ts'
import { foldKey } from './text.ts'

/** One assertion the writer wants to record. */
export interface LedgerDraft {
  subject: string
  predicate: string
  value: string
  chapter: number
  quote?: string | undefined
  supersedes?: string | null | undefined
}

/** Outcome of testing a draft against the existing ledger. */
export type LedgerCheck =
  | { kind: 'accept' }
  | { kind: 'duplicate'; existing: LedgerEntry }
  | { kind: 'conflict'; existing: LedgerEntry[]; message: string; hint: string }
  | { kind: 'invalid'; message: string }

/** Entries that no later entry has replaced. */
export function activeEntries(entries: LedgerEntry[]): LedgerEntry[] {
  const replaced = new Set(
    entries.map((entry) => entry.supersedes).filter((id): id is string => typeof id === 'string'),
  )
  return entries.filter((entry) => !replaced.has(entry.id))
}

/** Entries that some later entry replaced. */
export function supersededEntries(entries: LedgerEntry[]): LedgerEntry[] {
  const active = new Set(activeEntries(entries).map((entry) => entry.id))
  return entries.filter((entry) => !active.has(entry.id))
}

/** Active entries about one subject. */
export function factsAbout(entries: LedgerEntry[], subject: string): LedgerEntry[] {
  const key = foldKey(subject)
  return activeEntries(entries).filter((entry) => foldKey(entry.subject) === key)
}

/**
 * Decide whether a draft may enter the ledger.
 *
 * @param entries - the whole ledger, superseded rows included.
 * @param draft - the assertion under test.
 * @returns accept, duplicate, conflict, or invalid, with an explanation the
 * model can act on.
 */
export function checkLedgerWrite(entries: LedgerEntry[], draft: LedgerDraft): LedgerCheck {
  const subject = draft.subject.trim()
  const predicate = draft.predicate.trim()
  const value = draft.value.trim()

  if (!subject || !predicate || !value) {
    return { kind: 'invalid', message: 'subject、predicate、value 都不能为空。' }
  }
  if (!Number.isInteger(draft.chapter) || draft.chapter < 0) {
    return { kind: 'invalid', message: 'chapter 必须是非负整数（设定阶段用 0）。' }
  }

  const supersedes = draft.supersedes?.trim() || null
  if (supersedes) {
    const target = entries.find((entry) => entry.id === supersedes)
    if (!target) {
      return { kind: 'invalid', message: `supersedes 指向的条目 ${supersedes} 不存在。` }
    }
    if (foldKey(target.subject) !== foldKey(subject) || foldKey(target.predicate) !== foldKey(predicate)) {
      return {
        kind: 'invalid',
        message: `只能替换同一主体、同一属性的条目。${supersedes} 是「${target.subject}·${target.predicate}」，你写的是「${subject}·${predicate}」。`,
      }
    }
    if (target.chapter > draft.chapter) {
      return {
        kind: 'invalid',
        message: `不能用更早的章节（第${draft.chapter}章）替换更晚的设定（${supersedes}，第${target.chapter}章）。`,
      }
    }
    return { kind: 'accept' }
  }

  const sameKey = activeEntries(entries).filter(
    (entry) => foldKey(entry.subject) === foldKey(subject) && foldKey(entry.predicate) === foldKey(predicate),
  )
  if (sameKey.length === 0) return { kind: 'accept' }

  const identical = sameKey.find((entry) => foldKey(entry.value) === foldKey(value))
  if (identical) return { kind: 'duplicate', existing: identical }

  const sameChapter = sameKey.filter((entry) => entry.chapter === draft.chapter)
  const conflictSet = sameChapter.length > 0 ? sameChapter : sameKey
  const earliest = conflictSet[0]
  const quoted = earliest?.quote ? `（原文：${earliest.quote}）` : ''
  const message =
    sameChapter.length > 0
      ? `同一章内自相矛盾：${subject}·${predicate} 在第${draft.chapter}章已经是「${earliest?.value}」，这里要写成「${value}」。${quoted}`
      : `跨章改动已有设定：${subject}·${predicate} 在第${earliest?.chapter}章记为「${earliest?.value}」，现在要改成「${value}」。${quoted}`

  return {
    kind: 'conflict',
    existing: conflictSet,
    message,
    hint:
      sameChapter.length > 0
        ? `先确认哪一个是对的；定稿后把对的写成「${value}」，并删掉另一条。若确实要改，用 supersedes: "${earliest?.id}" 显式替换。`
        : `如果这是有意的人物/世界变化，重写这条并带上 supersedes: "${earliest?.id}"；否则请沿用旧设定。`,
  }
}

/** Render one entry as a single readable line. */
export function formatFact(entry: LedgerEntry): string {
  const origin = entry.chapter === 0 ? '设定阶段' : `第${entry.chapter}章`
  const quote = entry.quote ? `　原文：「${entry.quote}」` : ''
  return `${entry.id}｜${entry.subject}·${entry.predicate}＝${entry.value}｜${origin}${quote}`
}
