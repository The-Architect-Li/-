/**
 * Dates the prose actually states.
 *
 * The clock stores what the manuscript said, not what a writer might have
 * meant. This module is the reading half of that rule: it finds the places a
 * chapter names a time, and refuses to guess where the text did not say.
 *
 * Two kinds of statement come back:
 *
 * - **absolute** (`2020年10月`, `2019-03-07`, `二〇二〇年`, `十月十四日` with a
 *   year in hand): a window that can become an anchor as-is.
 * - **relative** (`三天后`, `半年后`, `次日`, `次年`): a distance forward from
 *   wherever the story already is, which becomes a span.
 *
 * Everything else — `那年秋天`, `多日后`, `开春` — is deliberately not returned:
 * a season is not a window, and inventing one puts a wrong fact in the file
 * that later contradicts a real one.
 */

/** One place the prose names a time. */
export interface ProseTime {
  /** The matched text, verbatim, so a report can quote it. */
  text: string
  /** Character offset in the source text. */
  index: number
  /** Which kind of statement it is. */
  kind: 'absolute' | 'relative'
  /** `YYYY`, `YYYY-MM` or `YYYY-MM-DD` — only for absolute statements. */
  when?: string
  /** How far forward the prose moves the clock — only for relative ones. */
  days?: { min: number; max: number }
}

/** Chinese digits that appear in dates, mapped to values. */
const CHINESE_DIGITS: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

/**
 * Relative phrases that need no arithmetic because the prose did it.
 */
const DAY_WORDS: Array<[RegExp, number]> = [
  [/第二天|次日|翌日|隔天|隔日/, 1],
  [/当天|同日|当日/, 0],
  [/第三天/, 2],
  [/一周后|一星期后|一个星期后/, 7],
  [/半个月后/, 15],
  [/一个月后/, 30],
  [/半年后/, 182],
  [/一年后/, 365],
  [/次年|翌年/, 365],
]

/** Read a run of Chinese digits as a base-10 number (`二〇二〇` → 2020). */
function chineseNumber(text: string): number | undefined {
  let value = 0
  if (text.length === 0) return undefined
  for (const char of text) {
    const digit = CHINESE_DIGITS[char]
    if (digit === undefined) return undefined
    value = value * 10 + digit
  }
  return value
}

/** Zero-pad to two digits, because `parseWhen` wants `2019-03`. */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Whether a year/month/day triple is a date a calendar can express. */
function realDate(year: number, month: number, day: number): boolean {
  if (year < 1000 || year > 2999) return false
  if (month < 1 || month > 12) return false
  if (day < 1 || day > 31) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

/**
 * Find every explicit time in one chapter's prose.
 *
 * @param text - the chapter body.
 * @returns the mentions in reading order; empty when the prose names no time.
 */
export function scanProseTimes(text: string): ProseTime[] {
  const found: ProseTime[] = []

  // 2020年10月14日 / 2020 年 10 月 / 2020年
  const fullDate = /(\d{4})\s*年(?:\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*[日号])?)?/g
  for (const match of text.matchAll(fullDate)) {
    const year = Number(match[1])
    const month = match[2] === undefined ? undefined : Number(match[2])
    const day = match[3] === undefined ? undefined : Number(match[3])
    if (month !== undefined && day !== undefined) {
      // A day the calendar does not have makes the whole statement unusable:
      // `2020年2月31日` should not quietly become "some time in February".
      if (realDate(year, month, day)) {
        found.push({ text: match[0].trim(), index: match.index ?? 0, kind: 'absolute', when: `${year}-${pad(month)}-${pad(day)}` })
      }
      continue
    }
    if (month !== undefined && realDate(year, month, 1)) {
      found.push({ text: match[0].trim(), index: match.index ?? 0, kind: 'absolute', when: `${year}-${pad(month)}` })
      continue
    }
    if (month === undefined && year >= 1000 && year <= 2999) {
      found.push({ text: match[0].trim(), index: match.index ?? 0, kind: 'absolute', when: String(year) })
    }
  }

  // 二〇二〇年（十月/十月十四日）— a year spelled in Chinese digits, four of
  // them. The month and day may be spelled the same way: prose that writes the
  // year in characters usually writes the rest that way too.
  const anyNumber = '[0-9〇零一二三四五六七八九十]{1,3}'
  const chineseYear = new RegExp(
    `([〇零一二三四五六七八九]{4})\\s*年(?:\\s*(${anyNumber})\\s*月(?:\\s*(${anyNumber})\\s*[日号])?)?`,
    'g',
  )
  for (const match of text.matchAll(chineseYear)) {
    const digits = match[1] ?? ''
    const year = chineseNumber(digits)
    if (year === undefined || year < 1000 || year > 2999) continue
    // Skip when the Arabic form already claimed this exact span.
    if (found.some((item) => item.index === (match.index ?? 0))) continue
    const month = match[2] === undefined ? undefined : countOf(match[2])
    const day = match[3] === undefined ? undefined : countOf(match[3])
    const when =
      month === undefined
        ? String(year)
        : day !== undefined && realDate(year, month, day)
          ? `${year}-${pad(month)}-${pad(day)}`
          : realDate(year, month, 1)
            ? `${year}-${pad(month)}`
            : undefined
    if (when === undefined) continue
    found.push({ text: match[0].trim(), index: match.index ?? 0, kind: 'absolute', when })
  }

  // 三天后 / 两三个月之后 / 半年后 — a distance, read by the same arithmetic
  // that reads `novel_timeline action="span"`. The marker can also sit in
  // front: 「又过了两三个月，他回来了」 states a jump just as plainly as
  // 「两三个月后」 does.
  const count = '[0-9０-９一二两三两半几数]{1,3}'
  const unit = '(?:天|日|周|星期|个月|月|年)'
  const patterns = [
    new RegExp(`(?:过了|又过了|再过)?\\s*(${count})\\s*(?:个)?\\s*(${unit})\\s*(?:之后|以后|后|过去了|过去)`, 'g'),
    new RegExp(`(?:过了|又过了|再过)\\s*(${count})\\s*(?:个)?\\s*(${unit})`, 'g'),
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const days = distanceInDays(match[1] ?? '', match[2] ?? '')
      if (days === undefined) continue
      const index = match.index ?? 0
      if (found.some((item) => item.index === index)) continue
      found.push({ text: match[0].trim(), index, kind: 'relative', days })
    }
  }

  // 第二天 / 次日 / 一周后 — phrases whose arithmetic is already done.
  for (const [pattern, days] of DAY_WORDS) {
    // `matchAll` insists on a global regexp; the table above is written without
    // the flag because these are read as plain phrases.
    for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) {
      const index = match.index ?? 0
      if (found.some((item) => item.index === index)) continue
      found.push({ text: match[0], index, kind: 'relative', days: { min: days, max: days } })
    }
  }

  return found.sort((a, b) => a.index - b.index)
}

/** Turn 「两」 + 「个月」 into a day range, or nothing when the text is vague. */
function distanceInDays(countText: string, unit: string): { min: number; max: number } | undefined {
  const units: Record<string, [number, number]> = {
    天: [1, 1], 日: [1, 1], 周: [7, 7], 星期: [7, 7], 个月: [30, 31], 月: [30, 31], 年: [365, 366],
  }
  const span = units[unit]
  if (!span) return undefined

  // `两三个月` — two numerals, so the range is low × min to high × max.
  if (countText.length === 2) {
    const low = singleCount(countText[0] ?? '')
    const high = singleCount(countText[1] ?? '')
    if (low !== undefined && high !== undefined) {
      return { min: Math.round(low * span[0]), max: Math.round(high * span[1]) }
    }
  }

  const count = singleCount(countText)
  if (count === undefined || count <= 0) return undefined
  // Half a year is 182.5 days; a range stores whole days, so the bound floors.
  const low = count % 1 === 0 ? count * span[0] : Math.floor(count * span[0])
  const high = count % 1 === 0 ? count * span[1] : Math.floor(count * span[1])
  return { min: Math.round(Math.min(low, high)), max: Math.round(Math.max(low, high)) }
}

/** One numeral as the prose writes them: `3`, `三`, `两`, `半`, `几`, `数`. */
function singleCount(text: string): number | undefined {
  if (/^[0-9０-９]+$/.test(text)) return Number(text.normalize('NFKC'))
  if (text === '两' || text === '二') return 2
  if (text === '半') return 0.5
  if (text === '几') return 3
  if (text === '数') return 4
  return chineseNumber(text)
}

/** A month or day number, however the sentence spelled it. */
function countOf(text: string): number | undefined {
  if (/^[0-9０-９]+$/.test(text)) return Number(text.normalize('NFKC'))
  return chineseNumber(text)
}

/**
 * The first absolute date in a chapter, if it names one.
 *
 * "The first time the text names becomes the start" is a rule only for the
 * opening chapter; later chapters accumulate anchors instead.
 *
 * @param times - the scan result.
 * @returns the first absolute mention, or undefined.
 */
export function firstAbsolute(times: readonly ProseTime[]): ProseTime | undefined {
  return times.find((item) => item.kind === 'absolute')
}
