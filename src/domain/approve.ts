/**
 * Turning an approved proposal into a write.
 *
 * Every branch here maps one `kind` onto one existing store call — the same
 * call the author would have made by hand. Nothing new is decided at this
 * point: the keeper already decided *what*, the person already decided *yes*,
 * and a third model asked to "carry it out" could only add mistakes.
 *
 * The mapping is stated rather than inferred:
 *
 * - `ledger` → a fact in the ledger, with the quote kept as its evidence;
 * - `place`  → a new state on the place card, which is how a place is allowed
 *   to change without losing what it was before;
 * - `stage`  → a new stage on the character card, so "he changed" is a record
 *   and not an overwrite;
 * - `anchor` → a dated point on the clock;
 * - `card`   → the chapter's recap fields.
 *
 * A proposal whose subject does not exist yet is applied to a *stub* card, and
 * the report says so. Refusing instead would mean the author has to create the
 * card first — which is the manual step this whole queue exists to remove.
 */
import type { ProjectStore } from './store.ts'
import { addAnchor } from './timeline-edit.ts'
import { UNASSIGNED } from './volumes.ts'
import type { PendingItem } from './pending.ts'
import type { CharacterCard, ChapterPlan, PlaceCard } from './types.ts'

/** What one approval did. */
export interface Applied {
  id: string
  /** `ledger` / `place` / … , for the report. */
  kind: string
  /** One line saying what landed. */
  line: string
  /** True when the write created something that did not exist. */
  created: boolean
}

/** What one approval could not do. */
export interface Skipped {
  id: string
  line: string
}

/** The result of approving a batch. */
export interface ApproveResult {
  applied: Applied[]
  skipped: Skipped[]
}

/**
 * Apply one approved proposal.
 *
 * @param store - the book.
 * @param item - the proposal.
 * @param now - timestamp for the record.
 * @returns what happened, or why nothing did.
 */
export async function applyPending(
  store: ProjectStore,
  item: PendingItem,
  now: Date = new Date(),
): Promise<Applied | Skipped> {
  const stamp = now.toISOString()
  switch (item.kind) {
    case 'ledger': {
      const before = await store.ledger()
      const duplicate = before.some(
        (entry) =>
          entry.subject === item.subject &&
          entry.predicate === item.key &&
          entry.value === item.value &&
          entry.chapter === item.chapter,
      )
      if (duplicate) {
        return { id: item.id, line: `账本里已经有这一条：${item.subject}·${item.key}＝${item.value}。` }
      }
      const entry = await store.appendLedger({
        subject: item.subject,
        predicate: item.key === '' ? '状态' : item.key,
        value: item.value,
        chapter: item.chapter,
        quote: item.quote,
        supersedes: null,
      })
      return { id: item.id, kind: 'ledger', line: `记了一条事实 ${entry.id}：${item.subject}·${entry.predicate}＝${item.value}。`, created: true }
    }

    case 'place': {
      const cards = await store.places()
      const card = cards.find((entry) => entry.name === item.subject)
      const detail = item.value
      if (card === undefined) {
        const created: PlaceCard = {
          name: item.subject,
          aliases: [],
          kind: '地点',
          firstChapter: item.chapter,
          latestChapter: item.chapter,
          detail,
          states: [{ chapter: item.chapter, detail, ...(item.quote === '' ? {} : { note: item.quote }) }],
          updatedAt: stamp,
        }
        await store.upsertPlace(created)
        return { id: item.id, kind: 'place', line: `新建地点「${item.subject}」，第${item.chapter}章的样子：${detail}`, created: true }
      }
      // A place is allowed to change; the previous state stays in the list, so
      // "the courtyard in chapter 1 is a flat in chapter 100" is remembered.
      const states = [...card.states.filter((state) => state.chapter !== item.chapter), { chapter: item.chapter, detail }].sort(
        (a, b) => a.chapter - b.chapter,
      )
      const next: PlaceCard = {
        ...card,
        latestChapter: Math.max(card.latestChapter, item.chapter),
        firstChapter: Math.min(card.firstChapter === 0 ? item.chapter : card.firstChapter, item.chapter),
        detail,
        states,
        updatedAt: stamp,
      }
      await store.upsertPlace(next)
      return { id: item.id, kind: 'place', line: `地点「${item.subject}」从第${item.chapter}章起：${detail}（旧样子留在历史里）`, created: false }
    }

    case 'stage': {
      const cards = await store.characters()
      const card = cards.find((entry) => entry.name === item.subject)
      if (card === undefined) {
        // A stub, so the fact is not lost just because nobody made a card yet.
        const stub: CharacterCard = {
          name: item.subject,
          role: 'supporting',
          voice: '',
          appearance: '',
          goal: '',
          secret: '',
          stages: [{ label: item.key === '' ? '当前' : item.key, text: item.value, chapter: item.chapter }],
          updatedAt: stamp,
        }
        await store.upsertCharacter(stub)
        return {
          id: item.id,
          kind: 'stage',
          line: `还没有「${item.subject}」的角色卡，先建了一张只有这一段的卡（voice 空着，等你自己填）。`,
          created: true,
        }
      }
      const stages = [
        ...(card.stages ?? []).filter((stage) => stage.chapter !== item.chapter),
        { label: item.key === '' ? '当前' : item.key, text: item.value, chapter: item.chapter },
      ].sort((a, b) => (a.chapter ?? 0) - (b.chapter ?? 0))
      await store.upsertCharacter({ ...card, stages, updatedAt: stamp })
      return { id: item.id, kind: 'stage', line: `「${item.subject}」多了一段经历：第${item.chapter}章 ${item.value}`, created: false }
    }

    case 'anchor': {
      try {
        await addAnchor(store, { chapter: item.chapter, when: item.value, label: item.subject === '' ? '正文' : item.subject, source: 'prose' })
        return { id: item.id, kind: 'anchor', line: `第${item.chapter}章钉在 ${item.value}。`, created: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { id: item.id, line: `日期没钉上：${message}` }
      }
    }

    case 'card': {
      const plans = await store.plans()
      const plan: ChapterPlan = plans.find((entry) => entry.number === item.chapter) ?? {
        number: item.chapter,
        volume: UNASSIGNED,
        title: '',
        pov: '',
        characters: [],
        beats: [],
        hooks: [],
        approved: false,
      }
      // `card` comes in as key=summary / key=events / key=scene, because one
      // proposal carries one field. The key says which; anything else lands in
      // the recap, which is the field that was empty anyway.
      const next: ChapterPlan = { ...plan }
      if (item.key === 'events') {
        next.events = [...(plan.events ?? []), item.value].filter(Boolean)
      } else if (item.key === 'scene') {
        next.scene = item.value
      } else {
        next.summary = item.value
      }
      await store.upsertPlan(next)
      return { id: item.id, kind: 'card', line: `第${item.chapter}章章卡（${item.key === '' ? '梗概' : item.key}）：${item.value}`, created: plans.every((entry) => entry.number !== item.chapter) }
    }

    default:
      return { id: item.id, line: `不认识的类别：${String(item.kind)}。` }
  }
}

/**
 * Apply a batch.
 *
 * One failure does not stop the batch: a bad date should not cost the author the
 * other nine approvals, and each result is reported on its own line so the
 * queue can be cleaned up correctly afterwards.
 *
 * @param store - the book.
 * @param items - approved proposals, in the order the author saw them.
 * @param now - timestamp.
 * @returns what landed and what did not.
 */
export async function applyPendingBatch(
  store: ProjectStore,
  items: readonly PendingItem[],
  now: Date = new Date(),
): Promise<ApproveResult> {
  const applied: Applied[] = []
  const skipped: Skipped[] = []
  for (const item of items) {
    try {
      const result = await applyPending(store, item, now)
      if ('kind' in result) applied.push(result)
      else skipped.push(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      skipped.push({ id: item.id, line: `${item.subject}：${message}` })
    }
  }
  return { applied, skipped }
}
