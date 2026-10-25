import { describe, expect, it } from 'vitest'
import {
  checkProseAgainstClock,
  describeWindow,
  parseDuration,
  parseWhen,
  resolveTimeline,
  windowAt,
} from '../src/domain/clock.ts'
import type { TimelineFile } from '../src/domain/types.ts'

function clock(overrides: Partial<TimelineFile> = {}): TimelineFile {
  return { formatVersion: 1, anchors: [], spans: [], ...overrides }
}

describe('parseWhen', () => {
  it('treats a bare year as the whole year', () => {
    const window = parseWhen('2019')
    expect(describeWindow(window).startsWith('2019-01-01')).toBe(true)
    expect(describeWindow(window).endsWith('2019-12-31')).toBe(true)
  })

  it('treats a bare month as the whole month, February included', () => {
    expect(describeWindow(parseWhen('2019-02'))).toBe('2019-02-01 ~ 2019-02-28')
    expect(describeWindow(parseWhen('2020-02'))).toBe('2020-02-01 ~ 2020-02-29')
  })

  it('keeps an exact day exact', () => {
    expect(describeWindow(parseWhen('2019-03-07'))).toBe('2019-03-07')
  })

  it('refuses text that is not a date', () => {
    expect(() => parseWhen('去年')).toThrow(/不是日期/)
    expect(() => parseWhen('2019-13')).toThrow(/月份/)
    expect(() => parseWhen('2019-02-31')).toThrow(/日期/)
  })
})

describe('parseDuration', () => {
  it('reads a range between two numerals', () => {
    expect(parseDuration('过了两三个月')).toEqual({ min: 60, max: 90 })
    expect(parseDuration('两三个月后')).toEqual({ min: 60, max: 90 })
  })

  it('reads a plain duration', () => {
    expect(parseDuration('三天后')).toEqual({ min: 3, max: 3 })
    expect(parseDuration('半个月')).toEqual({ min: 15, max: 15 })
    expect(parseDuration('半年')).toEqual({ min: 182, max: 182 })
    expect(parseDuration('三个月')).toEqual({ min: 90, max: 90 })
  })

  it('widens the upper bound when the prose refuses to be exact', () => {
    expect(parseDuration('一年多')).toEqual({ min: 365, max: 730 })
    expect(parseDuration('十几天')).toEqual({ min: 10, max: 20 })
  })

  it('does not read 上半年 as half a year', () => {
    expect(parseDuration('上半年')).toBeUndefined()
  })

  it('returns undefined when there is no duration', () => {
    expect(parseDuration('他推门进去')).toBeUndefined()
  })
})

describe('resolveTimeline', () => {
  it('walks the clock forward from an anchor through a span', () => {
    const file = clock({
      anchors: [{ id: 'a1', chapter: 1, when: '2019-01-15', label: '开场' }],
      spans: [{ id: 's1', fromChapter: 1, toChapter: 10, days: { min: 60, max: 90 }, text: '过了两三个月' }],
    })
    const resolution = resolveTimeline(file, 12)
    expect(describeWindow(windowAt(resolution, 1)!)).toBe('2019-01-15')
    expect(describeWindow(windowAt(resolution, 10)!)).toBe('2019-03-16 ~ 2019-04-15')
    // After the span the clock holds still until another span moves it.
    expect(describeWindow(windowAt(resolution, 12)!)).toBe('2019-03-16 ~ 2019-04-15')
    expect(resolution.findings).toEqual([])
  })

  it('keeps chapters before the first anchor unknown', () => {
    const file = clock({ anchors: [{ id: 'a1', chapter: 5, when: '2019', label: '开场' }] })
    const resolution = resolveTimeline(file, 8)
    expect(windowAt(resolution, 3)).toBeUndefined()
    expect(windowAt(resolution, 6)).toBeDefined()
  })

  it('flags a span that runs before any anchor', () => {
    const file = clock({ spans: [{ id: 's1', fromChapter: 1, toChapter: 3, days: { min: 3, max: 3 }, text: '三天后' }] })
    const codes = resolveTimeline(file, 5).findings.map((finding) => finding.code)
    expect(codes).toContain('timeline/span-before-anchor')
  })

  it('flags an anchor that moves time backwards', () => {
    const file = clock({
      anchors: [
        { id: 'a1', chapter: 1, when: '2019-06-01', label: '开场' },
        { id: 'a2', chapter: 5, when: '2019-01-01', label: '倒流' },
      ],
    })
    const codes = resolveTimeline(file, 6).findings.map((finding) => finding.code)
    expect(codes).toContain('timeline/anchor-rewind')
  })

  it('flags two different anchors on one chapter', () => {
    const file = clock({
      anchors: [
        { id: 'a1', chapter: 1, when: '2019-01', label: '开场' },
        { id: 'a2', chapter: 1, when: '2020-01', label: '另一个' },
      ],
    })
    const codes = resolveTimeline(file, 2).findings.map((finding) => finding.code)
    expect(codes).toContain('timeline/anchor-twice')
  })

  it('reports an anchor that disagrees with the accumulated spans without failing', () => {
    const file = clock({
      anchors: [
        { id: 'a1', chapter: 1, when: '2019-01-01', label: '开场' },
        { id: 'a2', chapter: 10, when: '2021-01-01', label: '两年后' },
      ],
      spans: [{ id: 's1', fromChapter: 1, toChapter: 10, days: { min: 60, max: 90 }, text: '过了两三个月' }],
    })
    const finding = resolveTimeline(file, 10).findings.find((entry) => entry.code === 'timeline/anchor-disagrees')
    expect(finding?.severity).toBe('info')
  })
})

describe('recalls', () => {
  const file = clock({
    anchors: [
      { id: 'a1', chapter: 1, when: '2019-01-15', label: '开场' },
      { id: 'a2', chapter: 20, when: '2019-08-01', label: '八月' },
    ],
  })

  it('accepts a recall whose date overlaps the remembered chapter', () => {
    const resolution = resolveTimeline(
      { ...file, recalls: [{ id: 'r1', chapter: 20, about: '货单', eventChapter: 1, claimed: '2019-01', text: '他还记得一月的货单。' }] },
      20,
    )
    expect(resolution.findings.filter((finding) => finding.code.startsWith('timeline/recall'))).toEqual([])
  })

  it('rejects a recall that moved the event a month', () => {
    const resolution = resolveTimeline(
      { ...file, recalls: [{ id: 'r1', chapter: 20, about: '货单', eventChapter: 1, claimed: '2019-02', text: '二月的货单他还记得。' }] },
      20,
    )
    const finding = resolution.findings.find((entry) => entry.code === 'timeline/recall-wrong-date')
    expect(finding?.severity).toBe('error')
    expect(finding?.message).toContain('2019-02')
  })

  it('rejects a recall that moved the event a year back', () => {
    const resolution = resolveTimeline(
      { ...file, recalls: [{ id: 'r1', chapter: 20, about: '货单', eventChapter: 1, claimed: '2018-12', text: '去年十二月的货单。' }] },
      20,
    )
    expect(resolution.findings.map((entry) => entry.code)).toContain('timeline/recall-wrong-date')
  })

  it('warns when the recall names no chapter to check against', () => {
    const resolution = resolveTimeline(
      { ...file, recalls: [{ id: 'r1', chapter: 20, about: '旧事', eventChapter: null, claimed: '2018', text: '那是旧事了。' }] },
      20,
    )
    expect(resolution.findings.map((entry) => entry.code)).toContain('timeline/recall-unlinked')
  })
})

describe('checkProseAgainstClock', () => {
  const start = parseWhen('2019-01-15')

  it('warns when a stated date sits far outside the chapter window', () => {
    const findings = checkProseAgainstClock('那还是 2015 年的事，他记得很清楚。', parseWhen('2019-01-15'), start)
    expect(findings.map((finding) => finding.code)).toContain('timeline/date-outside')
  })

  it('accepts a date inside the window', () => {
    const findings = checkProseAgainstClock('2019 年 1 月，雨下了一夜。', parseWhen('2019-01-15'), start)
    expect(findings.map((finding) => finding.code)).not.toContain('timeline/date-outside')
  })

  it('flags 这几年 in a book that has moved only months', () => {
    const findings = checkProseAgainstClock('这几年他一直在等。', parseWhen('2019-03'), start)
    expect(findings.map((finding) => finding.code)).toContain('timeline/unit-drift')
  })

  it('says nothing when the clock is unknown', () => {
    expect(checkProseAgainstClock('这几年他一直在等。', undefined, undefined)).toEqual([])
  })
})
