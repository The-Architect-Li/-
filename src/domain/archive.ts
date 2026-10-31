/**
 * Turning prose into chapter cards, one batch at a time.
 *
 * A manuscript that arrives from elsewhere has prose and nothing else: no
 * chapter cards, no outline, no record of who walked on in chapter 40. Every
 * downstream feature — the continuity checker, the briefing, "where was this
 * place in chapter 12" — reads those cards, so a book without them is a book
 * the plugin can carry but not understand.
 *
 * The card cannot be derived by regex. `deriveSummary` takes the last paragraph,
 * which for a downloaded txt is a sentence and a row of dashes. So a model reads
 * the prose and writes the card, in batches, under a budget the author sets.
 *
 * Two rules make it safe to run on 500 chapters:
 *
 * - the model only *proposes*; writing goes through the same `upsertPlan` the
 *   panel uses, and only fields that are still empty are filled unless asked;
 * - a batch is a fixed number of chapters, and the caller says which ones, so
 *   the run can be stopped, inspected, and resumed without redoing work.
 */
import { deriveSummary } from './save.ts'
import { countChars } from './text.ts'
import type { ChapterDraft, ChapterPlan } from './types.ts'

/** One chapter as the archivist was given it. */
export interface ArchiveInput {
  number: number
  title: string
  text: string
}

/** What the archivist proposes for one chapter. */
export interface ArchiveCard {
  number: number
  summary: string
  events: string[]
  scene: string
  characters: string[]
  hook: string
}

/** How much of a chapter the archivist is shown. */
export const ARCHIVE_HEAD_CHARS = 1200
/** …and how much of its ending. The hook lives there. */
export const ARCHIVE_TAIL_CHARS = 1200

/**
 * Trim one chapter for the prompt: the opening and the last stretch.
 *
 * A 6000-character chapter costs more than the card is worth, and the two ends
 * carry almost all of what the card needs — who is here and how it starts, and
 * what the chapter leaves hanging. The middle is where the prose is, not where
 * the facts are.
 *
 * @param text - the full chapter.
 * @returns the head, an ellipsis when the middle was cut, and the tail.
 */
export function trimForArchive(text: string): string {
  const body = text.trim()
  if (body.length <= ARCHIVE_HEAD_CHARS + ARCHIVE_TAIL_CHARS) return body
  return `${body.slice(0, ARCHIVE_HEAD_CHARS)}\n\n…（中间略）…\n\n${body.slice(-ARCHIVE_TAIL_CHARS)}`
}

/**
 * The archivist's prompt for one batch.
 *
 * The chapters are separated by explicit markers rather than JSON: a model
 * reads prose better than it reads escaped strings, and the answers come back
 * keyed by the number printed in the marker.
 *
 * @param batch - the chapters to read, in order.
 * @param persona - the role's persona, so this module owns only the task half.
 * @param contract - the role's output contract.
 * @returns the prompt.
 */
export function buildArchivePrompt(
  batch: readonly ArchiveInput[],
  persona: string,
  contract: string,
): string {
  const parts = [
    persona,
    '',
    `## 这一次要读的 ${batch.length} 章`,
    '一章一段，每段以 `=== 第N章 标题 ===` 开头。读完之后，为每一章写一张卡。',
    '',
  ]
  for (const chapter of batch) {
    parts.push(`=== 第${chapter.number}章 ${chapter.title} ===`, trimForArchive(chapter.text), '')
  }
  parts.push(contract)
  return parts.join('\n')
}

/** Strip the fences and the chatter a model wraps JSON in. */
function sliceJsonArray(output: string): string {
  const cleaned = output.replace(/```json|```/g, '').trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start < 0 || end <= start) return cleaned
  return cleaned.slice(start, end + 1)
}

/**
 * Read the archivist's answer.
 *
 * Partial answers are the normal case — a model that had trouble with chapter
 * 47 still answered 46 and 48 — so this returns whatever parsed and lets the
 * caller report the gap instead of throwing the batch away.
 *
 * @param output - the child's raw text.
 * @returns the cards it could read, in the order given.
 */
export function parseArchiveOutput(output: string): ArchiveCard[] {
  let value: unknown
  try {
    value = JSON.parse(sliceJsonArray(output))
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  const cards: ArchiveCard[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const number = Number(record.number)
    if (!Number.isInteger(number) || number < 1) continue
    const summary = typeof record.summary === 'string' ? record.summary.trim() : ''
    if (summary === '') continue
    cards.push({
      number,
      summary,
      events: readStrings(record.events),
      scene: typeof record.scene === 'string' ? record.scene.trim() : '',
      characters: readStrings(record.characters),
      hook: typeof record.hook === 'string' ? record.hook.trim() : '',
    })
  }
  return cards
}

/** A field that may be an array, a bulleted string, or absent. */
function readStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item !== '')
  }
  if (typeof value === 'string') {
    return value
      .split(/\r?\n|；|;/)
      .map((item) => item.replace(/^[\s\-*·\d.、]+/, '').trim())
      .filter((item) => item !== '')
  }
  return []
}

/**
 * Fold one proposed card into the plan that already exists.
 *
 * Never silently replaces an approved beat list: a plan that came from a real
 * outline is the author's intent, and the archivist is reading the result. It
 * fills the card's own fields and leaves the contract alone.
 *
 * @param existing - the plan on disk, if any.
 * @param card - what the archivist proposed.
 * @param title - the chapter's title, for a plan that does not exist yet.
 * @param volume - which volume an unassigned chapter belongs to (0 = none).
 * @param revision - the prose revision this card describes.
 * @returns the plan to store.
 */
export function mergeArchiveCard(
  existing: ChapterPlan | undefined,
  card: ArchiveCard,
  title: string,
  volume: number,
  revision: number,
): ChapterPlan {
  const base: ChapterPlan = existing ?? {
    number: card.number,
    volume,
    title,
    pov: '',
    characters: [],
    beats: [],
    hooks: [],
    approved: false,
  }
  return {
    ...base,
    // The volume is the book's own arrangement; a card never re-files a chapter.
    volume: existing === undefined ? volume : base.volume,
    // A card written from prose is not an approved outline. The beats stay
    // whatever they were, including empty, so the contract checker keeps saying
    // "this chapter has no plan" instead of pretending the recap is one.
    title: base.title === '' ? title : base.title,
    summary: card.summary,
    events: card.events,
    scene: card.scene,
    characters: card.characters.length > 0 ? card.characters : base.characters,
    hooks: card.hook === '' ? base.hooks : [card.hook],
    cardRevision: revision,
  }
}

/**
 * Which chapters still need a card.
 *
 * "Needs one" is: no plan, or a plan whose card was never written from prose, or
 * a card that describes an older revision than the body.
 *
 * @param chapters - every chapter in the book, with its text.
 * @param plans - every plan.
 * @returns chapter numbers in reading order.
 */
export function chaptersNeedingCards(
  chapters: readonly ChapterDraft[],
  plans: readonly ChapterPlan[],
): number[] {
  const byNumber = new Map(plans.map((plan) => [plan.number, plan]))
  return chapters
    .filter((chapter) => chapter.text.trim() !== '')
    .filter((chapter) => {
      const plan = byNumber.get(chapter.number)
      if (plan === undefined) return true
      if (plan.summary === undefined || plan.summary.trim() === '') return true
      return (plan.cardRevision ?? 0) < (chapter.revision ?? 0)
    })
    .map((chapter) => chapter.number)
    .sort((a, b) => a - b)
}

/**
 * A card that was never written from prose, for the report to quote back.
 *
 * @param chapter - the chapter as stored.
 * @returns a one-line preview, trimmed.
 */
export function cardPreview(chapter: ChapterDraft): string {
  const summary = chapter.summary.trim()
  return summary.length > 40 ? `${summary.slice(0, 40)}…` : summary
}

/**
 * The summary a chapter gets when no model touched it.
 *
 * Kept here rather than in the importer so the difference between "a card" and
 * "the last paragraph" is stated once, where the archivist can be compared.
 *
 * @param text - the prose.
 * @returns a short, honest placeholder.
 */
export function fallbackSummary(text: string): string {
  return deriveSummary(text)
}

/** Re-exported so callers can size a batch without importing text.ts. */
export function archiveWeight(text: string): number {
  return countChars(text)
}
