/**
 * The slice of the book a cross-chapter reviewer is allowed to read.
 *
 * A consistency reviewer has to compare chapter 85 against what came before, but
 * "what came before" is 84 chapters and 350,000 characters. Feeding all of it
 * costs more than writing the chapter did, and most of it answers a question
 * nobody asked.
 *
 * So the window is a shape, not a dump: the last few chapters **in full** (the
 * place where continuity actually breaks: a name spelled differently, a dead man
 * walking, a promise answered twice) and a longer run behind them as **recaps**
 * only — one line each, cheap to read, enough to catch "this contradicts what
 * happened ten chapters ago".
 *
 * The recaps come from the chapter cards, so a stale card is worse than no card:
 * it says what happened last time somebody looked. That is why the window marks
 * a recap `stale` when the prose has been rewritten since the card was written,
 * and why the reviewer is told to trust it less.
 */
import { countChars } from './text.ts'
import type { ChapterDraft, ChapterMeta, Snapshot } from './types.ts'

/** How much to read, and in what detail. */
export interface ReviewWindowOptions {
  /** Chapters to read in full, newest last. 0 means recaps only. */
  full: number
  /** Chapters behind those to summarise. 0 means no recaps. */
  recap: number
  /**
   * Character ceiling for the whole window. A chapter that would blow the
   * budget is demoted to its recap instead of being dropped — a reviewer that
   * loses a chapter silently will invent what it does not miss.
   */
  budget: number
}

/** One chapter read in full. */
export interface WindowChapter {
  number: number
  title: string
  words: number
  text: string
}

/** One chapter read as a recap. */
export interface WindowRecap {
  number: number
  title: string
  summary: string
  /** The card was written for an earlier revision of this chapter. */
  stale: boolean
  /** Where the summary came from: the chapter card, or the prose's last line. */
  source: 'card' | 'tail'
}

/** What a reviewer gets, plus what it was not given. */
export interface ReviewWindow {
  full: WindowChapter[]
  recaps: WindowRecap[]
  /** Chapters before the window, i.e. how much history is out of sight. */
  omitted: number
  /** Characters actually spent on the window. */
  chars: number
  /** One line for the tool report. */
  report: string
}

/** Defaults matching the studio's habit: three in full, seven as recaps. */
export const REVIEW_WINDOW_DEFAULTS: ReviewWindowOptions = { full: 3, recap: 7, budget: 12_000 }

/**
 * Is this chapter's card older than the prose it describes?
 *
 * `ChapterPlan.cardRevision` records the prose revision the card was written
 * from. A prose edit bumps `ChapterMeta.revision`; the two disagreeing means the
 * card describes text that no longer exists.
 *
 * @param plan - the chapter card, if there is one.
 * @param meta - the chapter as it exists on disk, if it exists.
 * @returns true when the card predates the current prose.
 */
export function cardIsStale(
  plan: { cardRevision?: number | undefined } | undefined,
  meta: { revision?: number | undefined } | undefined,
): boolean {
  if (!plan || !meta) return false
  // A card written before this book versioned cards has no revision to compare;
  // treating that as fresh would hide every legacy card, so it counts as stale
  // only when the prose has moved past revision 1.
  const from = plan.cardRevision ?? 1
  return (meta.revision ?? 1) > from
}

/**
 * Choose the window for one chapter.
 *
 * Only chapters already on disk count: a draft under review is not history yet,
 * and the chapter being reviewed is handed in separately.
 *
 * @param snapshot - the book, for chapter cards.
 * @param drafts - chapters with text, as `allChapters()` returns them.
 * @param target - the chapter about to be reviewed.
 * @param options - how many in full, how many as recap, char ceiling.
 * @returns the window plus a one-line description of it.
 */
export function buildReviewWindow(
  snapshot: Snapshot,
  drafts: readonly ChapterDraft[],
  target: number,
  options: ReviewWindowOptions = REVIEW_WINDOW_DEFAULTS,
): ReviewWindow {
  const before = drafts
    .filter((draft) => draft.number < target)
    .slice()
    .sort((a, b) => a.number - b.number)

  const metaByNumber = new Map<number, ChapterMeta>(snapshot.chapters.map((meta) => [meta.number, meta]))
  const planByNumber = new Map(snapshot.plans.map((plan) => [plan.number, plan]))

  const recent = before.slice(Math.max(0, before.length - options.full))
  const older = before.slice(Math.max(0, before.length - options.full - options.recap), Math.max(0, before.length - options.full))

  let spent = 0
  const full: WindowChapter[] = []
  const demoted: number[] = []

  // Newest first: when the budget runs out it is the oldest of the quoted
  // chapters that should become a recap, not the one right before the chapter
  // under review. The seam is where continuity breaks.
  for (const draft of [...recent].reverse()) {
    const chars = countChars(draft.text)
    if (spent + chars > options.budget && full.length > 0) {
      demoted.push(draft.number)
      continue
    }
    spent += chars
    full.push({ number: draft.number, title: draft.title, words: draft.words, text: draft.text })
  }
  full.sort((a, b) => a.number - b.number)

  const recaps: WindowRecap[] = []
  for (const number of [...older.map((draft) => draft.number), ...demoted]) {
    const meta = metaByNumber.get(number)
    const plan = planByNumber.get(number)
    const card = plan?.summary?.trim() ?? ''
    const summary = card !== '' ? card : (meta?.summary ?? '').trim()
    if (summary === '') continue
    recaps.push({
      number,
      title: meta?.title ?? plan?.title ?? `第${number}章`,
      summary,
      stale: cardIsStale(plan, meta),
      source: card !== '' ? 'card' : 'tail',
    })
    spent += summary.length
  }
  recaps.sort((a, b) => a.number - b.number)

  const lowest = before[0]?.number ?? target
  const covered = full.length + recaps.length
  const omitted = covered === 0 ? 0 : Math.max(0, before.length - covered) + Math.max(0, lowest - 1)

  const parts: string[] = []
  parts.push(full.length > 0 ? `正文 ${describeRange(full.map((item) => item.number))}` : '没有可读的近期正文')
  parts.push(recaps.length > 0 ? `梗概 ${describeRange(recaps.map((item) => item.number))}` : '没有可读的梗概')
  if (demoted.length > 0) parts.push(`超预算转梗概 ${describeRange(demoted)}`)
  if (omitted > 0) parts.push(`更早 ${omitted} 章未读`)
  const staleCount = recaps.filter((item) => item.stale).length
  if (staleCount > 0) parts.push(`其中 ${staleCount} 条梗概已过期`)

  return {
    full,
    recaps,
    omitted,
    chars: spent,
    report: `审稿窗口：${parts.join('；')}（约 ${spent} 字）。`,
  }
}

/**
 * Render a set of chapter numbers compactly: `第82–84章`.
 *
 * @param numbers - chapter numbers, any order.
 * @returns a human-readable range, or an empty string for no numbers.
 */
export function describeRange(numbers: readonly number[]): string {
  if (numbers.length === 0) return ''
  const sorted = [...numbers].sort((a, b) => a - b)
  const runs: string[] = []
  let start = sorted[0]!
  let previous = start
  for (const number of sorted.slice(1)) {
    if (number === previous + 1) {
      previous = number
      continue
    }
    runs.push(start === previous ? `第${start}章` : `第${start}–${previous}章`)
    start = number
    previous = number
  }
  runs.push(start === previous ? `第${start}章` : `第${start}–${previous}章`)
  return runs.join('、')
}
