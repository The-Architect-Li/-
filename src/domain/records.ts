/**
 * Which chapters have not left a trace in the story records.
 *
 * Places, story points and the clock are all *written by hand* — the author (or
 * the model, on the author's behalf) says "this chapter happens in the 旧码头,
 * and it is 3 月 12 日". Nothing can infer that safely, so the honest thing a
 * plugin can do is notice the silence: chapter 60 exists, and no place has been
 * touched since chapter 41.
 *
 * This module answers one question — "which written chapters left no record?" —
 * and says it the same way to the tool report, the checker, and (through the
 * checker) the briefing. It is a pure function over the snapshot so it costs no
 * tokens and cannot disagree with itself.
 */
import type { Snapshot } from './types.ts'

/** One book's record coverage, as numbers a report can print. */
export interface RecordCoverage {
  /** Written chapters that no place, story point, or clock entry mentions. */
  silent: number[]
  /** Chapters that do have prose. */
  written: number[]
  /** How many chapters any record mentions at all. */
  covered: number
  /** Highest chapter number any record mentions; 0 when there is none. */
  reached: number
  places: number
  storyPoints: number
  /** Anchors, spans and recalls together: the clock's entries. */
  clockEntries: number
  /** True when the book has prose but not one place, arc, or date. */
  empty: boolean
}

/**
 * Gather the chapters each record kind has touched.
 *
 * A timeline span counts for both ends of the range it covers — a span saying
 * "第 1 章到第 4 章过了两三个月" is evidence about chapters 1 through 4, not just
 * the two it names.
 *
 * @param snapshot - the book.
 * @returns the union of chapters any record mentions.
 */
function touchedChapters(snapshot: Snapshot): Set<number> {
  const touched = new Set<number>()
  for (const place of snapshot.places) {
    for (const state of place.states) touched.add(state.chapter)
  }
  for (const point of snapshot.storyPoints) {
    if (point.startChapter > 0) touched.add(point.startChapter)
    if (point.endChapter !== null && point.endChapter > 0) touched.add(point.endChapter)
  }
  const clock = snapshot.timeline
  for (const anchor of clock.anchors) touched.add(anchor.chapter)
  for (const span of clock.spans) {
    const from = Math.min(span.fromChapter, span.toChapter)
    const to = Math.max(span.fromChapter, span.toChapter)
    for (let chapter = Math.max(1, from); chapter <= to; chapter += 1) touched.add(chapter)
  }
  for (const recall of clock.recalls ?? []) {
    touched.add(recall.chapter)
    if (recall.eventChapter !== null) touched.add(recall.eventChapter)
  }
  return touched
}

/**
 * Measure how much of the manuscript the records have caught up with.
 *
 * @param snapshot - the book, as the store sees it.
 * @returns coverage counts, with the silent chapters in reading order.
 */
export function recordCoverage(snapshot: Snapshot): RecordCoverage {
  const written = snapshot.chapters
    .map((chapter) => chapter.number)
    .sort((left, right) => left - right)
  const touched = touchedChapters(snapshot)
  const clock = snapshot.timeline
  const clockEntries = clock.anchors.length + clock.spans.length + (clock.recalls?.length ?? 0)
  const covered = written.filter((number) => touched.has(number)).length
  const reached = touched.size === 0 ? 0 : Math.max(...touched)
  return {
    written,
    silent: written.filter((number) => !touched.has(number)),
    covered,
    reached,
    places: snapshot.places.length,
    storyPoints: snapshot.storyPoints.length,
    clockEntries,
    empty: written.length > 0 && snapshot.places.length === 0 && snapshot.storyPoints.length === 0 && clockEntries === 0,
  }
}

/**
 * Compress a list of chapter numbers into ranges, the way a report reads best.
 *
 * @param chapters - numbers, any order.
 * @returns `第1–3、7、9–11章`, or an empty string.
 */
export function chapterRanges(chapters: readonly number[]): string {
  if (chapters.length === 0) return ''
  const sorted = [...new Set(chapters)].sort((left, right) => left - right)
  const parts: string[] = []
  let start = sorted[0]!
  let previous = start
  for (const number of sorted.slice(1)) {
    if (number === previous + 1) {
      previous = number
      continue
    }
    parts.push(start === previous ? `${start}` : `${start}–${previous}`)
    start = number
    previous = number
  }
  parts.push(start === previous ? `${start}` : `${start}–${previous}`)
  return `第${parts.join('、')}章`
}

/**
 * Say what to do about the silence, in the words a writer would use.
 *
 * The wording changes with how much is missing, because the same advice is
 * useless for a freshly imported book (nothing is recorded — start at the
 * beginning) and for a book forty chapters in (the tail is what drifted).
 *
 * @param coverage - what `recordCoverage` measured.
 * @returns a short paragraph, or an empty string when nothing is missing.
 */
export function describeCoverage(coverage: RecordCoverage): string {
  if (coverage.written.length === 0) return ''
  if (coverage.empty) {
    return [
      `这本书有 ${coverage.written.length} 章正文，但地点、故事点、时间线都还是空的。`,
      '读第 1 章就能定下第一批：这一章发生在哪（novel_canon action="upsert_place"）、大概什么时候（novel_timeline action="anchor"）、这一卷讲什么（novel_story action="add"）。',
      '别想一次补完 —— 边写边记才是这套东西的用法。',
    ].join('\n')
  }
  if (coverage.silent.length === 0) return ''
  const ranges = chapterRanges(coverage.silent)
  const newest = coverage.written[coverage.written.length - 1] ?? 0
  const lastSilent = coverage.silent[coverage.silent.length - 1] ?? 0
  const lines = [
    `${coverage.written.length} 章正文里，${coverage.silent.length} 章没有留下任何记录：${ranges}。`,
    `已有记录：地点 ${coverage.places} 处、故事点 ${coverage.storyPoints} 段、时钟 ${coverage.clockEntries} 条，最远只到第 ${coverage.reached || 1} 章。`,
  ]
  if (lastSilent === newest) {
    lines.push('最后一章也在里面——刚写的这一章还没记地点和日子。')
  }
  lines.push(
    '补的时候按章往前：novel_canon action="upsert_place" 记这一章的地点（state 里写它此刻的样子）、novel_timeline action="anchor" 记日子、novel_timeline action="span" 记「过了多久」。参考 novel_briefing 给的第几章上下文，不用一次读完。',
  )
  return lines.join('\n')
}
