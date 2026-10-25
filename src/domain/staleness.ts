/**
 * Records that describe prose which has since been rewritten.
 *
 * Three things in a book are readings of prose rather than prose themselves: a
 * chapter card (what happened), a place's state (what the room looks like), and a
 * character's stage (who he is). All three go stale the moment the chapter under
 * them is rewritten — and a stale record is worse than a missing one, because it
 * is served with full confidence into the next chapter's pack.
 *
 * The card case has been handled since v0.20. This file exists because the same
 * rule was being applied to one third of the records that need it.
 */
import type { Snapshot } from './types.ts'

/** One record whose chapter has moved on since it was written. */
export interface StaleRecord {
  /** What kind of record it is. */
  kind: 'card' | 'place' | 'stage'
  /** Who or what it describes. */
  subject: string
  /** The chapter it belongs to. */
  chapter: number
  /** The chapter revision the record was written against. */
  recorded: number
  /** The chapter revision on disk now. */
  current: number
  /** A short line for a report. */
  label: string
}

/** Everything that has gone stale, in one list. */
export interface Staleness {
  records: StaleRecord[]
  /** Chapters carrying at least one stale record. */
  chapters: number[]
}

/**
 * Compare every reading of prose against the prose it was read off.
 *
 * Records written before versioning existed have no stamp; they are treated as
 * version 1, which is what the chapter was before anyone rewrote it. That means
 * an untouched chapter never reports anything — the check only fires where a
 * rewrite actually happened.
 *
 * @param snapshot - the whole book, read once.
 * @returns the stale records, and which chapters they sit in.
 */
export function staleRecords(snapshot: Snapshot): Staleness {
  const revisionOf = new Map(snapshot.chapters.map((meta) => [meta.number, meta.revision ?? 1]))
  const records: StaleRecord[] = []

  for (const plan of snapshot.plans) {
    const current = revisionOf.get(plan.number)
    if (current === undefined) continue
    const recorded = plan.cardRevision ?? 1
    if (recorded >= current) continue
    records.push({
      kind: 'card',
      subject: `第${plan.number}章`,
      chapter: plan.number,
      recorded,
      current,
      label: `章卡：第${plan.number}章的梗概写在第 ${recorded} 版正文上，正文现在是第 ${current} 版`,
    })
  }

  for (const place of snapshot.places) {
    for (const state of place.states) {
      const current = revisionOf.get(state.chapter)
      if (current === undefined) continue
      const recorded = state.revision ?? 1
      if (recorded >= current) continue
      records.push({
        kind: 'place',
        subject: place.name,
        chapter: state.chapter,
        recorded,
        current,
        label: `地点：${place.name} 第${state.chapter}章的样子写在第 ${recorded} 版正文上，正文现在是第 ${current} 版`,
      })
    }
  }

  for (const card of snapshot.characters) {
    for (const stage of card.stages ?? []) {
      if (stage.chapter === undefined) continue
      const current = revisionOf.get(stage.chapter)
      if (current === undefined) continue
      const recorded = stage.revision ?? 1
      if (recorded >= current) continue
      records.push({
        kind: 'stage',
        subject: card.name,
        chapter: stage.chapter,
        recorded,
        current,
        label: `阶段：${card.name} 第${stage.chapter}章的转变写在第 ${recorded} 版正文上，正文现在是第 ${current} 版`,
      })
    }
  }

  const chapters = [...new Set(records.map((record) => record.chapter))].sort((left, right) => left - right)
  return { records, chapters }
}
