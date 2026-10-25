/**
 * The one place the clock gets written.
 *
 * Three roads lead to a timeline — a person typing an anchor, a chapter naming
 * a date, an imported manuscript full of them — and all three have to produce
 * the same shape of fact. Keeping that in one module is what stops the panel,
 * the tool and the importer from drifting apart (`notes` was lost that way in
 * v0.12.1, the card lost its `state` in v0.14).
 *
 * Two rules hold whatever the road:
 *
 * - Nothing is written that the prose did not say. A season, a vague "later",
 *   an unparseable date: reported, not stored.
 * - A statement that contradicts the clock is reported, not quietly written.
 *   The contradiction is the finding; smoothing it over would erase exactly the
 *   thing the writer needs to see.
 */
import { describeWindow, parseWhen, resolveTimeline, windowAt, type Window } from './clock.ts'
import { firstAbsolute, scanProseTimes, type ProseTime } from './prose-time.ts'
import type { ProjectStore } from './store.ts'
import type { TimelineAnchor, TimelineFile, TimelineSpan } from './types.ts'

/** How far a stated date may miss the computed window before it is a conflict. */
const SLACK_DAYS = 90

/** What one adoption run did, in the words a report can print. */
export interface ClockAdoption {
  /** Anchors added, in the order they were written. */
  anchors: TimelineAnchor[]
  /** Spans added. */
  spans: TimelineSpan[]
  /** The start the run pinned, when the book had none. */
  start?: string
  /** Statements read and deliberately not stored, with the reason. */
  skipped: string[]
  /** Statements that contradict the clock. */
  conflicts: string[]
}

/** Next free id for one list, keeping anchors and spans in separate namespaces. */
function nextId(prefix: string, ids: readonly string[]): string {
  const highest = ids.reduce((max, id) => {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id)
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  return `${prefix}-${String(highest + 1).padStart(3, '0')}`
}

/**
 * Write one anchor, replacing whatever the same chapter already said.
 *
 * One anchor per chapter is the invariant the rest of the clock assumes: two
 * dates for one chapter is a contradiction wearing a data structure.
 *
 * @param store - the project.
 * @param input - chapter, date and one-line label.
 * @returns the anchor as stored.
 * @throws ClockFormatError when the date is not one this book can hold.
 */
export async function addAnchor(
  store: ProjectStore,
  input: { chapter: number; when: string; label: string; source?: 'manual' | 'prose' },
): Promise<TimelineAnchor> {
  parseWhen(input.when)
  const file = await store.timeline()
  const previous = file.anchors.find((item) => item.chapter === input.chapter)
  const anchor: TimelineAnchor = {
    id: previous?.id ?? nextId('ta', file.anchors.map((item) => item.id)),
    chapter: input.chapter,
    when: input.when.trim(),
    label: input.label.trim() === '' ? `第${input.chapter}章` : input.label.trim(),
    ...(input.source === undefined ? {} : { source: input.source }),
  }
  const anchors = previous
    ? file.anchors.map((item) => (item.chapter === input.chapter ? anchor : item))
    : [...file.anchors, anchor]
  await store.writeTimeline({ ...file, anchors })
  return anchor
}

/**
 * Read one chapter's prose and put any date it states on the clock.
 *
 * The rules, in order:
 *
 * 1. A chapter that already has an anchor keeps it — a person's statement
 *    outranks a scan of the same sentence.
 * 2. An absolute date the clock contradicts is reported, not written.
 * 3. An absolute date that fits becomes an anchor; when the book has no start
 *    yet, this is also where the start is pinned ("the first time the text
 *    names becomes the beginning", the rule the writer asked for).
 * 4. A relative distance becomes a span from the previous dated chapter, but
 *    only when there is a previous dated chapter to measure from.
 *
 * @param store - the project.
 * @param chapter - the chapter whose prose was just read.
 * @param text - that chapter's body.
 * @returns what was written, skipped and contradicted.
 */
export async function adoptClock(store: ProjectStore, chapter: number, text: string): Promise<ClockAdoption> {
  const result: ClockAdoption = { anchors: [], spans: [], skipped: [], conflicts: [] }
  const mentions = scanProseTimes(text)
  if (mentions.length === 0) return result

  const file = await store.timeline()
  const project = await store.readProject()
  const existing = file.anchors.find((item) => item.chapter === chapter)
  if (existing !== undefined) {
    result.skipped.push(`第${chapter}章已经有锚点（${existing.when}），这次没动它。`)
    return result
  }

  const window = windowAt(resolveTimeline(file, chapter), chapter)
  const absolute = mentions.filter((item) => item.kind === 'absolute')
  for (const mention of absolute) {
    const when = mention.when ?? ''
    let claimed: Window
    try {
      claimed = parseWhen(when)
    } catch {
      result.skipped.push(`「${mention.text}」不是能存进时钟的日期。`)
      continue
    }
    if (window !== undefined && (claimed.latest < window.earliest || claimed.earliest > window.latest)) {
      if (Math.abs(claimed.earliest - window.earliest) > SLACK_DAYS) {
        result.conflicts.push(
          `第${chapter}章正文写「${mention.text}」，但这一章的时间在 ${describeWindow(window)} —— 差得太远，没有写进时钟。`,
        )
        continue
      }
    }
    const label = `正文里写「${mention.text}」`
    const anchor = await addAnchor(store, { chapter, when, label, source: 'prose' })
    result.anchors.push(anchor)
    if (project.bookStart === undefined || project.bookStart === '') {
      const start = firstAbsolute(mentions)?.when
      if (start !== undefined) {
        await store.writeProject({ ...project, bookStart: start })
        result.start = start
      }
    }
    // One date per chapter is enough: the first one the prose states is where
    // the chapter happens, and later mentions inside it are detail.
    break
  }

  if (result.anchors.length === 0 && absolute.length === 0) {
    const distance = mentions.find((item) => item.kind === 'relative' && item.days !== undefined)
    const from = lastDatedChapter(file, chapter)
    if (distance !== undefined) {
      if (from === undefined) {
        result.skipped.push(`第${chapter}章说「${distance.text}」，但前面还没有一章有日期，量不出距离。`)
      } else {
        const spans: TimelineSpan[] = [
          ...file.spans,
          {
            id: nextId('ts', file.spans.map((item) => item.id)),
            fromChapter: from,
            toChapter: chapter,
            days: distance.days ?? { min: 0, max: 0 },
            text: distance.text,
          },
        ]
        await store.writeTimeline({ ...file, spans })
        result.spans.push(spans[spans.length - 1] as TimelineSpan)
      }
    }
  }

  return result
}

/** The nearest earlier chapter that has an anchor. */
function lastDatedChapter(file: TimelineFile, chapter: number): number | undefined {
  const earlier = file.anchors.filter((item) => item.chapter < chapter).map((item) => item.chapter)
  if (earlier.length === 0) return undefined
  return Math.max(...earlier)
}

/**
 * Build a clock for a book whose prose was written before the clock existed.
 *
 * The importer has eighty chapters of text and no anchor at all. Reading them
 * in order and adopting each one lands the book on a real timeline without
 * asking the writer to retype a single date.
 *
 * @param store - the project.
 * @param chapters - the bodies in reading order, with their numbers.
 * @returns what was written across the whole run.
 */
export async function seedClockFromProse(
  store: ProjectStore,
  chapters: ReadonlyArray<{ number: number; text: string }>,
): Promise<ClockAdoption> {
  const total: ClockAdoption = { anchors: [], spans: [], skipped: [], conflicts: [] }
  for (const chapter of [...chapters].sort((a, b) => a.number - b.number)) {
    const run = await adoptClock(store, chapter.number, chapter.text)
    total.anchors.push(...run.anchors)
    total.spans.push(...run.spans)
    total.skipped.push(...run.skipped)
    total.conflicts.push(...run.conflicts)
    if (total.start === undefined && run.start !== undefined) total.start = run.start
  }
  return total
}

/**
 * The mentions a report should show without writing anything.
 *
 * @param text - the chapter body.
 * @returns every time statement the scanner found.
 */
export function describeMentions(text: string): ProseTime[] {
  return scanProseTimes(text)
}
