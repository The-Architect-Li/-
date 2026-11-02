/**
 * Who is still in this book, and who quietly left.
 *
 * The failure this catches is not a mistake anyone makes in a chapter. It is
 * what happens over five hundred of them: a character walks on in chapter 74
 * and the author, who has written four hundred chapters since, does not notice
 * they never came back. Readers do. 「阿鸢后来呢」 is the most common question a
 * long serial gets, and the honest answer is usually "the writer forgot".
 *
 * Everything here is arithmetic over the chapter cards that already exist —
 * `plans[].characters` — so it costs nothing and cannot disagree with the book.
 * A character who is not on any card is not counted, which is why the report
 * says how many chapters had cards at all: on a book where the archivist has
 * never run, "nobody appears" would be a lie dressed as a finding.
 */
import type { ChapterMeta, ChapterPlan } from './types.ts'

/** One character's presence across the book. */
export interface Presence {
  name: string
  /** Chapters whose card names them, in reading order. */
  chapters: number[]
  first: number
  last: number
  /** Chapters between the last appearance and the end of the book. */
  silent: number
  /** Longest stretch between two consecutive appearances, inside their span. */
  longestGap: number
}

/** What the report needs besides the list. */
export interface PresenceReport {
  people: Presence[]
  /** Chapters that have a card naming at least one character. */
  covered: number
  /** Chapters written at all. */
  written: number
}

/**
 * Count appearances from the chapter cards.
 *
 * Only chapters that were actually written count: a card for an unwritten
 * chapter is a plan, and a plan is not a scene. Treating them alike would let a
 * character look present for chapters nobody has read.
 *
 * @param plans - every chapter card.
 * @param chapters - every committed chapter.
 * @returns who appears where, plus how much of the book the cards cover.
 */
export function presenceOf(plans: readonly ChapterPlan[], chapters: readonly ChapterMeta[]): PresenceReport {
  const written = new Set(chapters.map((chapter) => chapter.number))
  const lastChapter = chapters.reduce((max, chapter) => Math.max(max, chapter.number), 0)
  const byName = new Map<string, number[]>()
  let covered = 0

  for (const plan of plans) {
    if (!written.has(plan.number)) continue
    const names = plan.characters.map((name) => name.trim()).filter((name) => name !== '')
    if (names.length === 0) continue
    covered += 1
    for (const name of new Set(names)) {
      const list = byName.get(name) ?? []
      list.push(plan.number)
      byName.set(name, list)
    }
  }

  const people: Presence[] = [...byName.entries()].map(([name, list]) => {
    const sorted = [...list].sort((a, b) => a - b)
    const first = sorted[0]!
    const last = sorted[sorted.length - 1]!
    let longestGap = 0
    for (let index = 1; index < sorted.length; index += 1) {
      longestGap = Math.max(longestGap, sorted[index]! - sorted[index - 1]!)
    }
    return { name, chapters: sorted, first, last, silent: Math.max(0, lastChapter - last), longestGap }
  })

  people.sort((a, b) => b.silent - a.silent || b.chapters.length - a.chapters.length || a.name.localeCompare(b.name, 'zh'))
  return { people, covered, written: written.size }
}

/**
 * How long a silence has to be before it is worth mentioning.
 *
 * Long enough that a character resting for a volume is not a problem, short
 * enough to catch someone who left and was never brought back. Like the thread
 * checker this is a nudge, not a rule: a character is allowed to be gone for a
 * hundred chapters if the book is building to their return.
 */
export const SILENT_AFTER = 80

/** A character who may have been forgotten. */
export interface SilentPerson extends Presence {
  /** How many chapters they actually appear in. */
  appearances: number
}

/**
 * The people who have been gone long enough to ask about.
 *
 * One-appearance cameos are excluded: 「只在第 3 章出现过一次」 is a spear
 * carrier, and reminding the author about every one of them is noise. The
 * finding is for people the book treated as recurring and then dropped.
 *
 * @param report - from {@link presenceOf}.
 * @param silentAfter - chapters of silence that count.
 * @param minAppearances - appearances below which a character is a cameo.
 * @returns the people worth mentioning, longest silence first.
 */
export function silentPeople(
  report: PresenceReport,
  silentAfter: number = SILENT_AFTER,
  minAppearances = 2,
): SilentPerson[] {
  return report.people
    .filter((person) => person.silent >= silentAfter && person.chapters.length >= minAppearances)
    .map((person) => ({ ...person, appearances: person.chapters.length }))
}

/**
 * The report, in the shape a writer reads.
 *
 * @param report - from {@link presenceOf}.
 * @param silentAfter - the threshold the trailing note quotes.
 * @returns the text.
 */
export function describePresence(report: PresenceReport, silentAfter: number = SILENT_AFTER): string {
  if (report.written === 0) {
    return '还没有写过正文，谈不上谁出场。'
  }
  if (report.covered === 0) {
    return [
      `已经写了 ${report.written} 章，但没有任何一章的章卡写了出场人物，所以算不出谁在场。`,
      '章卡是这项统计的唯一来源。补卡：novel_archive action="plan" 看缺哪些，再 action="apply" 让档案员读。',
    ].join('\n')
  }
  const silent = silentPeople(report, silentAfter)
  const lines = [
    `出场统计：${report.people.length} 个人物，覆盖 ${report.covered} / ${report.written} 章（按章卡的出场名单算）。`,
    '',
  ]
  if (silent.length > 0) {
    lines.push(`已经 ${silentAfter} 章以上没出现的（${silent.length} 人）：`)
    for (const person of silent) {
      lines.push(
        `  ${person.name}　最后一次第${person.last}章　已经 ${person.silent} 章　（共出场 ${person.appearances} 章）`,
      )
    }
    lines.push('', '要么让他们回来，要么承认这条线断了。读者会记得，你会忘。', '')
  } else {
    lines.push(`没有人被落下 ${silentAfter} 章以上。`, '')
  }

  const busiest = [...report.people].sort((a, b) => b.chapters.length - a.chapters.length).slice(0, 5)
  if (busiest.length > 0) {
    lines.push('出场最多：')
    for (const person of busiest) {
      lines.push(`  ${person.name}　${person.chapters.length} 章　首次第${person.first}章`)
    }
    lines.push('')
  }

  const oneOff = report.people.filter((person) => person.chapters.length === 1)
  if (oneOff.length > 0) {
    lines.push(
      `只出现过一次的有 ${oneOff.length} 人：${oneOff.slice(0, 8).map((person) => person.name).join('、')}${oneOff.length > 8 ? '…' : ''}`,
    )
    lines.push('（这些多半是过场人物，不是漏掉的线。）')
  }
  return lines.join('\n').trimEnd()
}
