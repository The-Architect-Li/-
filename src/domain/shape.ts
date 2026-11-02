/**
 * The shape of a long book, on one page.
 *
 * Every other check in this plugin looks at one chapter or one record. None of
 * them can answer 「这本书作为一本书怎么样」: whether the middle sags, whether the
 * last hundred chapters stopped having hooks, whether volume three is twice the
 * size of the others. Those are questions about a curve, and a curve needs to be
 * seen rather than listed — five hundred numbers is not a shape, it is a wall.
 *
 * So this draws. A block character per bucket, height by word count, plus the
 * places where the book stopped pulling. It is arithmetic on prose already on
 * disk: no model, no tokens, same picture every time.
 */
import type { ChapterMeta, ChapterPlan, VolumeOutline } from './types.ts'

/** One column of the shape. */
export interface ShapeBucket {
  /** First chapter in this bucket. */
  from: number
  /** Last chapter in this bucket. */
  to: number
  words: number
  chapters: number
  /** Chapters in this bucket that have a card with at least one hook. */
  hooked: number
}

/** What the report is drawn from. */
export interface ShapeReport {
  buckets: ShapeBucket[]
  /** Chapters per bucket. */
  span: number
  written: number
  words: number
  /** Longest and shortest committed chapter, by number. */
  longest: { number: number; words: number } | null
  shortest: { number: number; words: number } | null
  /** How many written chapters have a card at all. Zero means hooks are unknown. */
  carded: number
  /** Runs of consecutive written chapters whose card has no hook. */
  drySpells: { from: number; to: number; length: number }[]
  volumes: { number: number; title: string; from: number; to: number; words: number }[]
}

/** How many chapters one column covers when the book is long. */
function spanFor(written: number): number {
  if (written <= 40) return 1
  if (written <= 120) return 3
  if (written <= 400) return 10
  return 20
}

/**
 * Measure the book.
 *
 * Buckets are fixed-width so two hundred chapters and five hundred chapters can
 * be compared by eye: a 521-chapter book at 10 per column is 53 columns, which
 * fits a panel. A bucket's height is its **average** chapter length, not its
 * total — otherwise a bucket that happens to hold one more chapter than its
 * neighbour looks taller for no reason.
 *
 * @param chapters - every committed chapter.
 * @param plans - every chapter card, for hooks.
 * @param volumes - the volume list, for boundaries.
 * @returns everything the picture and the notes need.
 */
export function shapeOf(
  chapters: readonly ChapterMeta[],
  plans: readonly ChapterPlan[],
  volumes: readonly VolumeOutline[],
): ShapeReport {
  const ordered = [...chapters].sort((a, b) => a.number - b.number)
  const written = ordered.length
  const words = ordered.reduce((sum, chapter) => sum + chapter.words, 0)
  const span = spanFor(written)
  const first = ordered[0]?.number ?? 1
  const last = ordered[ordered.length - 1]?.number ?? 0

  const hooksByChapter = new Map<number, boolean>()
  for (const plan of plans) hooksByChapter.set(plan.number, plan.hooks.length > 0)

  const buckets: ShapeBucket[] = []
  for (let from = first; from <= last; from += span) {
    const to = from + span - 1
    const inside = ordered.filter((chapter) => chapter.number >= from && chapter.number <= to)
    if (inside.length === 0) continue
    buckets.push({
      from,
      // The last bucket usually reaches past the book: a 521-chapter book at 20
      // per column ends its 27th column at 540. Printing 540 would claim
      // chapters that do not exist.
      to: Math.min(to, last),
      words: Math.round(inside.reduce((sum, chapter) => sum + chapter.words, 0) / inside.length),
      chapters: inside.length,
      hooked: inside.filter((chapter) => hooksByChapter.get(chapter.number) === true).length,
    })
  }

  const sorted = [...ordered].sort((a, b) => b.words - a.words)
  const dry: { from: number; to: number; length: number }[] = []
  let runStart: number | null = null
  for (const chapter of ordered) {
    const hooked = hooksByChapter.get(chapter.number)
    // A chapter with no card at all is unknown, not dry: counting it would blame
    // the book for a card nobody has written yet.
    if (hooked === false) {
      runStart ??= chapter.number
      continue
    }
    if (runStart !== null) {
      dry.push({ from: runStart, to: chapter.number - 1, length: chapter.number - runStart })
      runStart = null
    }
  }
  if (runStart !== null) dry.push({ from: runStart, to: last, length: last - runStart + 1 })

  // Volumes are known from the cards, not from the chapter metadata: a chapter
  // file records its words, not which volume it belongs to.
  const volumeOfChapter = new Map<number, number>()
  for (const plan of plans) volumeOfChapter.set(plan.number, plan.volume)
  const volumeRanges = volumes
    .map((volume) => {
      const inside = ordered.filter((chapter) => volumeOfChapter.get(chapter.number) === volume.number)
      if (inside.length === 0) return null
      return {
        number: volume.number,
        title: volume.title,
        from: inside[0]!.number,
        to: inside[inside.length - 1]!.number,
        words: inside.reduce((sum, chapter) => sum + chapter.words, 0),
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)

  return {
    buckets,
    span,
    written,
    words,
    longest: sorted[0] === undefined ? null : { number: sorted[0].number, words: sorted[0].words },
    shortest: sorted[sorted.length - 1] === undefined ? null : { number: sorted[sorted.length - 1]!.number, words: sorted[sorted.length - 1]!.words },
    carded: ordered.filter((chapter) => hooksByChapter.has(chapter.number)).length,
    drySpells: dry.sort((a, b) => b.length - a.length),
    volumes: volumeRanges,
  }
}

/** The eight heights, low to high. */
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

/** Display width, counting a CJK character as two columns. */
function columns(text: string): number {
  let width = 0
  for (const char of text) width += /[\u3000-\u9fff\uff00-\uff60]/.test(char) ? 2 : 1
  return width
}

/**
 * The axis under the blocks: first chapter on the left, last on the right.
 *
 * Padded by display width rather than character count, because 「第521章」 is not
 * three columns wide and a label that drifts is worse than no label.
 *
 * @param from - first chapter.
 * @param to - last chapter.
 * @param width - how many columns the sparkline occupies.
 * @returns the line.
 */
export function axisLine(from: number, to: number, width: number): string {
  const left = `第${from}章`
  const right = `第${to}章`
  const gap = Math.max(1, width - columns(left) - columns(right))
  return `${left}${' '.repeat(gap)}${right}`
}

/**
 * One row of blocks, heights relative to the tallest bucket.
 *
 * @param values - the bucket averages.
 * @returns the line.
 */
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return ''
  const max = Math.max(...values)
  const min = Math.min(...values)
  const spread = max - min
  return values
    .map((value) => {
      const index = spread === 0 ? 0 : Math.round(((value - min) / spread) * (BLOCKS.length - 1))
      return BLOCKS[index]!
    })
    .join('')
}

/**
 * The picture and the notes.
 *
 * @param report - from {@link shapeOf}.
 * @returns the report text.
 */
export function describeShape(report: ShapeReport): string {
  if (report.buckets.length === 0) return '还没有写过正文，画不出形状。'
  const values = report.buckets.map((bucket) => bucket.words)
  const lines = [
    `全书形状：${report.written} 章、${(report.words / 10000).toFixed(1)} 万字，每格 ${report.span} 章（平均字数）。`,
    '',
    `  ${sparkline(values)}`,
    `  ${axisLine(report.buckets[0]!.from, report.buckets[report.buckets.length - 1]!.to, values.length)}`,
    '',
  ]

  const short = report.shortest
  const long = report.longest
  if (short !== null && long !== null) {
    lines.push(`最长的一章：第${long.number}章 ${long.words} 字`)
    lines.push(`最短的一章：第${short.number}章 ${short.words} 字`)
    lines.push('')
  }

  if (report.carded === 0) {
    // Saying "each card's hook connects" when there are no cards at all is a
    // sentence that sounds like good news and means nothing.
    lines.push('还没有任何章卡，钩子断档无从判断。章卡到位后这一项才有意义：novel_archive action="plan"', '')
  } else if (report.drySpells.length > 0) {
    const top = report.drySpells.slice(0, 3)
    lines.push(`章末没有钩子的连续段落（${report.drySpells.length} 段）：`)
    for (const spell of top) {
      lines.push(`  第${spell.from}–${spell.to}章　连续 ${spell.length} 章没有钩子`)
    }
    lines.push('', '钩子是读者翻下一章的理由。一段连续没有钩子，读者就在那里停下。', '')
  } else {
    lines.push('每张有钩子的章卡都接得上，没有连续断档。', '')
  }

  if (report.volumes.length > 0) {
    lines.push('分卷体量：')
    const biggest = Math.max(...report.volumes.map((volume) => volume.words))
    for (const volume of report.volumes) {
      const width = Math.max(1, Math.round((volume.words / biggest) * 18))
      lines.push(`  第${volume.number}卷 ${volume.title}　第${volume.from}–${volume.to}章　${'▉'.repeat(width)} ${(volume.words / 10000).toFixed(1)} 万字`)
    }
  } else {
    lines.push('这本书还没有分卷。分卷不是为了好看——它标出故事的结构边界，也让「第几卷开始」有答案。')
  }
  return lines.join('\n').trimEnd()
}
