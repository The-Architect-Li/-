/**
 * The shape of a book's clock as a rail: year points, and events hanging off it.
 *
 * The timeline file answers "when is chapter N" and "does this recall lie". It is
 * not a thing you can look at: ninety anchors and eighty chapters, all correct, and
 * the author still cannot see the shape of their own story's time.
 *
 * A spine is that shape. The clock starts somewhere the book actually says — the
 * first anchor, or the start date pinned on the book — and then every twelve
 * months is a point. Between two points sits whatever happened in that year, in
 * order, so 「第三年发生了什么」 is a glance instead of a scroll.
 *
 * Everything here is derived. The only stored facts stay in `timeline.json` and
 * `project.json`; a spine is rebuilt from them on every request, so it cannot
 * drift from the clock it draws.
 */
import { parseWhen, resolveTimeline, windowAt } from './clock.ts'
import type { Snapshot } from './types.ts'

/** One millisecond is not in play here: windows are day numbers since 1970-01-01. */
const DAYS_IN_YEAR = 365

/** What a point on the rail means. */
export type SpineNodeKind = 'start' | 'year'

/** A point on the rail: the start, then one per twelve months. */
export interface SpineNode {
  /** Day number, comparable with `Window.earliest`. */
  at: number
  /** `2020-10`, the way the author writes it. */
  label: string
  kind: SpineNodeKind
}

/** What an event is: a dated statement, or a chapter that falls on the clock. */
export type SpineEventKind = 'anchor' | 'chapter'

/** One bubble on the rail. */
export interface SpineEvent {
  kind: SpineEventKind
  /** Chapter the event belongs to; 0 for a start date with no chapter. */
  chapter: number
  /** Day number. */
  at: number
  /** `第12章 换地方`, or the anchor's own words. */
  label: string
  /** One line of what happened; may be empty. */
  text: string
  /**
   * The anchor's own words, when this chapter was also dated on purpose.
   *
   * Kept apart from `text` so a bubble can say both what the chapter card
   * records and what the author wrote when pinning the date — and so the two do
   * not look like two separate events on the same day.
   */
  note?: string
  /** Index into `nodes`; -1 when the event predates the first point. */
  node: number
}

/** The rail, ready to draw. */
export interface Spine {
  /** Day number the rail starts at, when the book has said anything at all. */
  start: number | undefined
  nodes: SpineNode[]
  events: SpineEvent[]
  /** Events that have a chapter but no date yet — the clock has not reached them. */
  loose: SpineEvent[]
  report: string
}

/** Options for {@link buildSpine}. */
export interface SpineOptions {
  /** `YYYY`, `YYYY-MM` or `YYYY-MM-DD` pinned on the book, overriding the first anchor. */
  start?: string | undefined
  /** Months between points; a year unless the author asked otherwise. */
  stepMonths?: number
  /** Rail length ceiling, so a book spanning forty years cannot draw a thousand points. */
  maxNodes?: number
}

/** Day number to `YYYY-MM-DD` in UTC, the format the rest of the plugin prints. */
function isoDay(days: number): string {
  return new Date(days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * A day number as the author thinks of it — `2020-10`, or `2020-10-05` when it is a day.
 *
 * @param days - day number.
 * @param exact - keep the day.
 * @returns the label.
 */
export function whenLabel(days: number, exact = false): string {
  const iso = isoDay(days)
  return exact ? iso : iso.slice(0, 7)
}

/**
 * Add whole months to a day number, keeping the day of the month where it exists.
 *
 * The rail's points are the same date every year (2020-10 → 2021-10), not the first
 * of January: an anniversary is what a book with a season in it actually counts.
 *
 * @param days - the day to start from.
 * @param months - how many months to add; may be 0.
 * @returns the new day number.
 */
export function addMonths(days: number, months: number): number {
  const start = new Date(days * 86_400_000)
  const year = start.getUTCFullYear()
  const month = start.getUTCMonth() + months
  const day = start.getUTCDate()
  const shifted = new Date(Date.UTC(year, month, 1))
  const daysInMonth = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate()
  return Math.floor(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), Math.min(day, daysInMonth)) / 86_400_000)
}

/**
 * Build the rail for one book.
 *
 * @param snapshot - the book.
 * @param options - start override and step, all optional.
 * @returns the rail, its events, and a one-line report.
 */
export function buildSpine(snapshot: Snapshot, options: SpineOptions = {}): Spine {
  const step = Math.max(1, Math.round(options.stepMonths ?? 12))
  const ceiling = Math.max(2, Math.round(options.maxNodes ?? 40))
  const highest = Math.max(1, snapshot.chapters.length, ...snapshot.plans.map((plan) => plan.number), 1)
  const resolution = resolveTimeline(snapshot.timeline, highest)

  const pinned = options.start ?? snapshot.project.bookStart
  let start: number | undefined
  let startExact = false
  if (pinned !== undefined && pinned.trim() !== '') {
    try {
      const window = parseWhen(pinned)
      start = window.earliest
      startExact = window.latest === window.earliest
    } catch {
      // A pinned start that does not parse is reported by the caller's clock check;
      // the rail falls back to the first anchor rather than drawing nothing.
      start = undefined
    }
  }
  if (start === undefined) {
    const first = [...snapshot.timeline.anchors].sort((a, b) => a.chapter - b.chapter)[0]
    if (first !== undefined) {
      try {
        const window = parseWhen(first.when)
        start = window.earliest
        startExact = window.latest === window.earliest
      } catch {
        start = undefined
      }
    }
  }
  if (start === undefined) start = windowAt(resolution, 1)?.earliest

  const titled = new Map<number, string>()
  for (const plan of snapshot.plans) titled.set(plan.number, plan.title)
  for (const chapter of snapshot.chapters) {
    if (!titled.has(chapter.number) || titled.get(chapter.number) === '') titled.set(chapter.number, chapter.title)
  }

  const events: SpineEvent[] = []
  const loose: SpineEvent[] = []

  const forChapter = new Map<number, SpineEvent>()
  for (const anchor of snapshot.timeline.anchors) {
    let at: number
    try {
      at = parseWhen(anchor.when).earliest
    } catch {
      continue
    }
    const exact = anchor.when.trim().split('-').length === 3
    events.push({
      kind: 'anchor',
      chapter: anchor.chapter,
      at,
      label: `第${anchor.chapter}章 ${whenLabel(at, exact)}`,
      text: anchor.label,
      node: -1,
    })
  }

  for (let number = 1; number <= highest; number += 1) {
    const plan = snapshot.plans.find((item) => item.number === number)
    const card = plan?.summary ?? plan?.events?.[0] ?? ''
    const window = windowAt(resolution, number)
    const title = titled.get(number) ?? ''
    if (window === undefined) {
      // Nothing on the clock yet: a chapter before the first anchor. It still
      // exists, so it is listed rather than silently dropped.
      if (plan !== undefined || snapshot.chapters.some((item) => item.number === number)) {
        loose.push({ kind: 'chapter', chapter: number, at: Number.POSITIVE_INFINITY, label: `第${number}章 ${title}`.trim(), text: card, node: -1 })
      }
      continue
    }
    events.push({
      kind: 'chapter',
      chapter: number,
      at: window.earliest,
      label: `第${number}章 ${title}`.trim(),
      text: card,
      node: -1,
    })
  }

  events.sort((left, right) => left.at - right.at || left.chapter - right.chapter || left.kind.localeCompare(right.kind))
  for (const event of events) {
    if (event.kind === 'chapter') forChapter.set(event.chapter, event)
  }
  // A chapter that was dated on purpose keeps one bubble, not two: the card's
  // line is the text, the anchor's line is the note. Two bubbles on the same day
  // for the same chapter read as two events, which is a lie about the count.
  const deduped: SpineEvent[] = []
  for (const event of events) {
    if (event.kind === 'anchor') {
      const sibling = forChapter.get(event.chapter)
      const words = event.text.trim()
      if (sibling !== undefined) {
        if (words !== '' && !sibling.text.includes(words)) {
          sibling.note = sibling.note === undefined ? words : `${sibling.note}；${words}`
        }
        continue
      }
      if (words === '') continue
      deduped.push(event)
      continue
    }
    deduped.push(event)
  }

  const nodes: SpineNode[] = []
  if (start !== undefined) {
    nodes.push({ at: start, label: whenLabel(start, startExact), kind: 'start' })
    const last = deduped.length === 0 ? start : Math.max(start, ...deduped.map((event) => event.at))
    // Points run to the year the last event landed in, and one past it: a rail
    // that stops exactly at the last event reads as "the story ended here", which
    // is a claim this function is not entitled to make.
    for (let index = 1; index < ceiling; index += 1) {
      const at = addMonths(start, index * step)
      nodes.push({ at, label: whenLabel(at, false), kind: 'year' })
      if (at > last) break
    }
  }

  for (const event of [...deduped, ...loose]) {
    let index = -1
    for (let cursor = 0; cursor < nodes.length; cursor += 1) {
      if (nodes[cursor]!.at <= event.at) index = cursor
      else break
    }
    event.node = index
  }

  const years = nodes.length
  const report = start === undefined
    ? '还没有任何日期：先记一个锚点（novel_timeline action="anchor"），或者在书里钉一个起点（action="start"）。'
    : `起点 ${nodes[0]!.label}，${years} 个点，${deduped.length} 个事件` +
      (loose.length > 0 ? `，${loose.length} 章还没有日期` : '') +
      (deduped.length > 0 ? `，最远到 ${whenLabel(Math.max(...deduped.map((event) => event.at)))}` : '')

  return { start, nodes, events: deduped, loose, report }
}

/** Days in a year, exported so the panel can print 「第 N 年」 without importing the clock. */
export const DAYS_PER_YEAR = DAYS_IN_YEAR
