/**
 * The book's clock: parsing, resolution, and the checks that fall out of it.
 *
 * The rule this module exists to keep: a project stores only what the prose
 * said — "第 1 章是 2019 年 1 月 15 日", "第 40 章说过了两三个月" — and every
 * date anyone reads is computed from those statements. Two copies of a date is
 * how a character ends up remembering a February event in December.
 *
 * All arithmetic is in whole days since the Unix epoch, UTC. Story time is a
 * *window*, never a point: "两三个月" is 60–90 days, and a check that pretends
 * otherwise would either flag honest prose or miss real errors.
 */
import type { Finding, StoryTime, TimelineFile } from './types.ts'

const DAY = 86_400_000

/** Chinese numerals and the digits they stand for, longest first. */
const NUMERALS: ReadonlyArray<readonly [string, number]> = [
  ['二十三', 23],
  ['二十二', 22],
  ['二十一', 21],
  ['二十', 20],
  ['十九', 19],
  ['十八', 18],
  ['十七', 17],
  ['十六', 16],
  ['十五', 15],
  ['十四', 14],
  ['十三', 13],
  ['十二', 12],
  ['十一', 11],
  ['十', 10],
  ['九', 9],
  ['八', 8],
  ['七', 7],
  ['六', 6],
  ['五', 5],
  ['四', 4],
  ['三', 3],
  ['两', 2],
  ['二', 2],
  ['一', 1],
]

/** Days per unit, as a lower/upper pair: 一个月 is 28–31 days, 一年 is 365. */
const UNITS: ReadonlyArray<readonly [string, readonly [number, number]]> = [
  ['星期', [7, 7]],
  ['礼拜', [7, 7]],
  ['周', [7, 7]],
  ['个月', [30, 30]],
  ['月', [30, 30]],
  ['天', [1, 1]],
  ['日', [1, 1]],
  ['年', [365, 365]],
  ['小时', [0, 1]],
]

/** A window of story time, in days since the epoch. */
export interface Window {
  earliest: number
  latest: number
}

/** Everything the resolver produces for a book. */
export interface TimelineResolution {
  /** Resolved window per chapter, for chapters the clock can reach. */
  byChapter: Map<number, StoryTime>
  /** Ordered anchors as given, for display. */
  anchors: ReadonlyArray<{ chapter: number; when: string; label: string }>
  /** Problems that make the clock itself wrong, not the prose. */
  findings: Finding[]
}

/** Raised when a caller hands the clock something it cannot read. */
export class ClockFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClockFormatError'
  }
}

/**
 * Read a numeral at the start of a string.
 *
 * @param text - text such as `两`, `3`, `二十三`.
 * @returns the number and how many characters it used, or undefined.
 */
function readNumber(text: string): { value: number; length: number } | undefined {
  const digits = /^(\d+)/.exec(text)
  const digitsText = digits?.[1]
  if (digitsText !== undefined) return { value: Number(digitsText), length: digitsText.length }
  for (const [word, value] of NUMERALS) {
    if (text.startsWith(word)) return { value, length: word.length }
  }
  return undefined
}

/**
 * Turn a stated duration into a day range.
 *
 * The point is to stay honest about precision: `两三个月` is 60–90 days, `半年`
 * is one number, and `一年多` is 365–730, because the prose refused to say.
 *
 * @param text - the sentence fragment, e.g. `过了两三个月`, `三天后`.
 * @returns the range in days, or undefined when nothing parseable is in it.
 */
export function parseDuration(text: string): { min: number; max: number } | undefined {
  const cleaned = text.replace(/\s+/g, '')
  if (cleaned.length === 0) return undefined
  if (/半(?:个)?年/.test(cleaned) && !/[上下这那同]半年/.test(cleaned)) return { min: 182, max: 182 }
  if (/半(?:个)?月/.test(cleaned)) return { min: 15, max: 15 }

  for (let index = 0; index < cleaned.length; index += 1) {
    const rest = cleaned.slice(index)
    const first = readNumber(rest)
    if (!first) continue
    const afterFirst = rest.slice(first.length)

    // `两三个月` — two numerals, no 到/至 between them, then one unit.
    const second = readNumber(afterFirst.replace(/^(?:到|至|、|或|～|-|~)+/, ''))
    if (second) {
      const tail = afterFirst.replace(/^(?:到|至|、|或|～|-|~)+/, '').slice(second.length)
      const unit = UNITS.find(([word]) => tail.startsWith(word))
      if (unit) {
        const low = first.value * unit[1][0]
        const high = second.value * unit[1][1]
        return { min: Math.min(low, high), max: Math.max(low, high) }
      }
    }

    const unit = UNITS.find(([word]) => afterFirst.startsWith(word))
    if (!unit) {
      // `十几天` — the prose says "ten-something", so the range is the number doubled.
      const fuzzy = /^几/.exec(afterFirst)
      if (fuzzy) {
        const fuzzyUnit = UNITS.find(([word]) => afterFirst.slice(fuzzy[0].length).startsWith(word))
        if (fuzzyUnit) {
          const low = first.value * fuzzyUnit[1][0]
          const high = first.value * 2 * fuzzyUnit[1][1]
          return { min: low, max: high }
        }
      }
      continue
    }
    const low = first.value * unit[1][0]
    const high = first.value * unit[1][1]
    const hasSlack = /多|余|来/.test(afterFirst.slice(unit[0].length))
    if (hasSlack) return { min: low, max: Math.max(high * 2, high + 30) }
    return { min: low, max: high }
  }

  // Bare "几天"/"数月" with no numeral in front still says something.
  if (/几天/.test(cleaned)) return { min: 2, max: 6 }
  if (/数月/.test(cleaned)) return { min: 60, max: 180 }
  if (/数年/.test(cleaned)) return { min: 730, max: 1825 }
  return undefined
}

/**
 * Days since the epoch for one calendar date, in UTC.
 *
 * @param year - four-digit year.
 * @param month - 1-based month.
 * @param day - 1-based day; 1 when the caller only knows the month.
 * @returns the day number.
 */
function dayNumber(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / DAY)
}

/** Last day of a month, so `2019-02` means the whole of February. */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Read a `YYYY`, `YYYY-MM` or `YYYY-MM-DD` date into a window.
 *
 * A coarser date stands for the whole period it names: the year 2019 is
 * Jan 1 – Dec 31. That keeps a month-level statement from being compared
 * against a day-level one as if both were equally precise.
 *
 * @param when - the text from the file.
 * @returns the window in day numbers.
 * @throws ClockFormatError when the text is not a date this module accepts.
 */
export function parseWhen(when: string): Window {
  const text = when.trim()
  const match = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(text)
  if (!match) {
    throw new ClockFormatError(`"${when}" 不是日期。要写成 2019、2019-01 或 2019-01-15。`)
  }
  const year = Number(match[1])
  const month = match[2] === undefined ? 1 : Number(match[2])
  const day = match[3] === undefined ? 1 : Number(match[3])
  if (year < 1000 || year > 2999) throw new ClockFormatError(`年份 ${year} 不在 1000–2999 之内。`)
  if (month < 1 || month > 12) throw new ClockFormatError(`月份 ${month} 不合法。`)
  if (day < 1 || day > 31) throw new ClockFormatError(`日期 ${day} 不合法。`)
  if (match[3] !== undefined) {
    const probe = new Date(Date.UTC(year, month - 1, day))
    if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
      throw new ClockFormatError(`${year}-${month}-${day} 这个日期不存在。`)
    }
  }
  if (match[2] === undefined) return { earliest: dayNumber(year, 1, 1), latest: dayNumber(year, 12, 31) }
  if (match[3] === undefined) {
    return { earliest: dayNumber(year, month, 1), latest: dayNumber(year, month, lastDayOfMonth(year, month)) }
  }
  const exact = dayNumber(year, month, day)
  return { earliest: exact, latest: exact }
}

/**
 * Render a window the way a person reads a date range.
 *
 * @param window - day numbers.
 * @returns e.g. `2019-03-01` for a single day, `2019-03 ~ 2019-05` for a range.
 */
export function describeWindow(window: Window): string {
  const iso = (day: number): string => new Date(day * DAY).toISOString().slice(0, 10)
  const start = iso(window.earliest)
  const end = iso(window.latest)
  return start === end ? start : `${start} ~ ${end}`
}

/**
 * Compose a chapter's window from the clock.
 *
 * @param file - the stored clock.
 * @param maxChapter - highest chapter number to resolve; 0 resolves setup only.
 * @param options - `tolerance` in days, for judging anchors against spans.
 * @returns per-chapter windows plus findings about the clock itself.
 */
export function resolveTimeline(
  file: TimelineFile,
  maxChapter: number,
  options: { tolerance?: number } = {},
): TimelineResolution {
  const tolerance = options.tolerance ?? 60
  const findings: Finding[] = []

  const anchors = [...file.anchors].sort((a, b) => a.chapter - b.chapter || a.when.localeCompare(b.when))
  const parsedAnchors: Array<{ chapter: number; window: Window; when: string; label: string }> = []
  for (const anchor of anchors) {
    try {
      parsedAnchors.push({ chapter: anchor.chapter, window: parseWhen(anchor.when), when: anchor.when, label: anchor.label })
    } catch (error) {
      findings.push({
        code: 'timeline/bad-anchor',
        severity: 'error',
        message: `第 ${anchor.chapter} 章的时间锚点读不懂：${anchor.when}`,
        evidence: `${(error as Error).message}（${anchor.label}）`,
      })
    }
  }

  const byChapterAnchor = new Map<number, Window>()
  for (const anchor of parsedAnchors) {
    const existing = byChapterAnchor.get(anchor.chapter)
    if (existing) {
      if (existing.earliest !== anchor.window.earliest || existing.latest !== anchor.window.latest) {
        findings.push({
          code: 'timeline/anchor-twice',
          severity: 'error',
          message: `第 ${anchor.chapter} 章有两个不同的时间锚点，不知道该信哪个`,
          evidence: `${describeWindow(existing)} 与 ${describeWindow(anchor.window)}`,
        })
      }
      continue
    }
    byChapterAnchor.set(anchor.chapter, anchor.window)
  }

  const spans = [...file.spans].sort((a, b) => a.toChapter - b.toChapter || a.fromChapter - b.fromChapter)
  const arrivals = new Map<number, typeof spans>()
  for (const span of spans) {
    if (span.toChapter < span.fromChapter) {
      findings.push({
        code: 'timeline/span-backwards',
        severity: 'error',
        message: `时间跨度 ${span.fromChapter} → ${span.toChapter} 是往回走的`,
        evidence: span.text,
      })
      continue
    }
    const list = arrivals.get(span.toChapter) ?? []
    list.push(span)
    arrivals.set(span.toChapter, list)
  }

  const byChapter = new Map<number, StoryTime>()
  let current: Window | undefined

  for (let chapter = 0; chapter <= maxChapter; chapter += 1) {
    const anchor = byChapterAnchor.get(chapter)
    const arriving = arrivals.get(chapter) ?? []

    if (anchor) {
      if (current && anchor.earliest < current.earliest - tolerance) {
        findings.push({
          code: 'timeline/anchor-rewind',
          severity: 'error',
          message: `第 ${chapter} 章的时间锚点比前面倒退了`,
          evidence: `锚点 ${describeWindow(anchor)}，而上一章之前已经走到 ${describeWindow(current)}`,
        })
      } else if (current && Math.abs(anchor.earliest - current.earliest) > tolerance) {
        findings.push({
          code: 'timeline/anchor-disagrees',
          severity: 'info',
          message: `第 ${chapter} 章的锚点与前面累加出来的时间差了一段`,
          evidence: `锚点 ${describeWindow(anchor)}；按「过了多久」累加应是 ${describeWindow(current)}`,
        })
      }
      current = anchor
    } else if (arriving.length > 0) {
      if (!current) {
        findings.push({
          code: 'timeline/span-before-anchor',
          severity: 'warn',
          message: `第 ${chapter} 章有时间跨度，但这之前没有任何日期锚点，算不出具体时间`,
          evidence: arriving.map((span) => span.text).join('；'),
        })
      } else {
        let earliest = current.earliest
        let latest = current.latest
        for (const span of arriving) {
          earliest += Math.max(0, span.days.min)
          latest += Math.max(span.days.min, span.days.max)
        }
        current = { earliest, latest }
      }
    }

    if (current) byChapter.set(chapter, { earliest: current.earliest, latest: current.latest, anchored: Boolean(anchor) })
  }

  const recalls = file.recalls ?? []
  for (const recall of recalls) {
    const claimedWindow = (() => {
      try {
        return parseWhen(recall.claimed)
      } catch {
        findings.push({
          code: 'timeline/bad-recall',
          severity: 'error',
          message: `第 ${recall.chapter} 章的回忆日期读不懂：${recall.claimed}`,
          evidence: recall.text,
        })
        return undefined
      }
    })()
    if (!claimedWindow) continue
    if (recall.eventChapter === null) {
      findings.push({
        code: 'timeline/recall-unlinked',
        severity: 'warn',
        message: `第 ${recall.chapter} 章回忆「${recall.about}」，但没说它发生在第几章，无法核对日期`,
        evidence: recall.text,
      })
      continue
    }
    const actual = byChapter.get(recall.eventChapter)
    if (!actual) {
      findings.push({
        code: 'timeline/recall-unknown-time',
        severity: 'warn',
        message: `第 ${recall.chapter} 章回忆第 ${recall.eventChapter} 章的事，但那章的时间还定不下来`,
        evidence: recall.text,
      })
      continue
    }
    const overlaps = claimedWindow.latest >= actual.earliest && claimedWindow.earliest <= actual.latest
    if (!overlaps) {
      findings.push({
        code: 'timeline/recall-wrong-date',
        severity: 'error',
        message: `回忆里的日期对不上：说 ${recall.claimed}，但那件事发生在 ${describeWindow({ earliest: actual.earliest, latest: actual.latest })}`,
        evidence: `第 ${recall.chapter} 章：「${recall.text}」`,
      })
    }
  }

  return {
    byChapter,
    anchors: parsedAnchors.map((anchor) => ({ chapter: anchor.chapter, when: anchor.when, label: anchor.label })),
    findings,
  }
}

/**
 * The window that applies to a chapter, falling back to the newest earlier one.
 *
 * Chapters with no span and no anchor still happen after the last known date,
 * so the last resolved window is the honest answer rather than "unknown".
 *
 * @param resolution - output of `resolveTimeline`.
 * @param chapter - the chapter asked about.
 * @returns its window, or undefined when the clock never starts.
 */
export function windowAt(resolution: TimelineResolution, chapter: number): Window | undefined {
  for (let index = chapter; index >= 0; index -= 1) {
    const found = resolution.byChapter.get(index)
    if (found) return { earliest: found.earliest, latest: found.latest }
  }
  return undefined
}

/**
 * Check a chapter's prose against the clock it is supposed to sit in.
 *
 * Two things are knowable without a model: a stated absolute date that sits
 * outside the window, and a unit drift ("这几年" in a book that has moved three
 * months). Everything subtler is the reviewer's job, which is why the briefing
 * carries this window.
 *
 * @param text - the chapter body.
 * @param window - the chapter's resolved window, when known.
 * @param bookStart - earliest window in the book, for the drift check.
 * @returns findings.
 */
export function checkProseAgainstClock(text: string, window: Window | undefined, bookStart: Window | undefined): Finding[] {
  const findings: Finding[] = []
  if (!window) return findings

  const datePattern = /(\d{4})\s*年(?:\s*(\d{1,2})\s*月)?(?:\s*(\d{1,2})\s*[日号])?/g
  for (const match of text.matchAll(datePattern)) {
    const year = Number(match[1])
    if (year < 1000 || year > 2999) continue
    const month = match[2] === undefined ? undefined : Number(match[2])
    let claimed: Window
    try {
      claimed = parseWhen(month === undefined ? String(year) : `${year}-${String(month).padStart(2, '0')}`)
    } catch {
      continue
    }
    {
      const day = match[3] === undefined ? undefined : Number(match[3])
      if (month !== undefined && day !== undefined && day >= 1 && day <= 31) {
        claimed = { earliest: claimed.earliest + day - 1, latest: claimed.earliest + day - 1 }
      }
    }
    const slackDays = 90
    const overlaps = claimed.latest >= window.earliest && claimed.earliest <= window.latest
    if (!overlaps && Math.abs(claimed.earliest - window.earliest) > slackDays) {
      findings.push({
        code: 'timeline/date-outside',
        severity: 'warn',
        message: `正文写了 ${match[0]}，但这一章的故事时间在 ${describeWindow(window)} 前后`,
        evidence: match[0],
      })
    }
  }

  if (bookStart && window) {
    const elapsed = (window.earliest - bookStart.earliest) / 365
    if (elapsed < 0.8 && /这几年|这些年|多年来|这几年间/.test(text)) {
      findings.push({
        code: 'timeline/unit-drift',
        severity: 'warn',
        message: `正文说「这几年」，但从开头到现在书里只过了约 ${Math.max(1, Math.round(elapsed * 12))} 个月`,
        evidence: (/.{0,12}(?:这几年|这些年|多年来).{0,12}/.exec(text) ?? ['这几年'])[0],
      })
    }
    if (elapsed > 2 && /这几个月|前些月|几个月来/.test(text)) {
      findings.push({
        code: 'timeline/unit-drift',
        severity: 'warn',
        message: `正文说「这几个月」，但从开头到现在书里已经过了约 ${Math.round(elapsed)} 年`,
        evidence: (/.{0,12}(?:这几个月|前些月|几个月来).{0,12}/.exec(text) ?? ['这几个月'])[0],
      })
    }
  }

  return findings
}
