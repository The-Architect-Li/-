import { describe, expect, it } from 'vitest'
import { firstAbsolute, scanProseTimes } from '../src/domain/prose-time.ts'

describe('scanProseTimes', () => {
  it('reads a full Chinese date', () => {
    const found = scanProseTimes('那是一九九七年的事，到了 2020年10月14日 她回来了。')
    const dates = found.filter((item) => item.kind === 'absolute')
    expect(dates.map((item) => item.when)).toEqual(['1997', '2020-10-14'])
  })

  it('reads a year and month, and a bare year', () => {
    expect(scanProseTimes('2008年5月，地震').map((item) => item.when)).toEqual(['2008-05'])
    expect(scanProseTimes('2008年，地震').map((item) => item.when)).toEqual(['2008'])
  })

  it('reads a year spelled in Chinese digits', () => {
    expect(scanProseTimes('二〇二〇年的雪').map((item) => item.when)).toEqual(['2020'])
  })

  it('reads a month and day spelled in Chinese digits', () => {
    expect(scanProseTimes('二〇〇九年十月，她进了厂').map((item) => item.when)).toEqual(['2009-10'])
    expect(scanProseTimes('二〇二〇年十月二十一日，天晴').map((item) => item.when)).toEqual(['2020-10-21'])
  })

  it('refuses a day the calendar does not have, without falling back to the month', () => {
    expect(scanProseTimes('2020年2月31日，什么都没发生。')).toEqual([])
  })

  it('reads distances forward', () => {
    const found = scanProseTimes('三天后，雨停了。又过了两三个月，他回来了。半年后她才知道。')
    const rel = found.filter((item) => item.kind === 'relative')
    expect(rel.map((item) => item.days)).toEqual([
      { min: 3, max: 3 },
      { min: 60, max: 93 },
      // Half a year is 182.5 days; the range keeps both whole-day bounds.
      { min: 182, max: 183 },
    ])
  })

  it('reads the day words the prose already counted', () => {
    const found = scanProseTimes('第二天一早，次日黄昏，一周后。')
    expect(found.filter((item) => item.kind === 'relative').map((item) => item.days)).toEqual([
      { min: 1, max: 1 },
      { min: 1, max: 1 },
      { min: 7, max: 7 },
    ])
  })

  it('does not invent a window for seasons and vague phrases', () => {
    expect(scanProseTimes('那年秋天，多日后，开春了，入冬以后。')).toEqual([])
  })

  it('keeps the text and the offset, in reading order', () => {
    const found = scanProseTimes('2019年3月7日那天，三天后。')
    expect(found.map((item) => [item.text, item.index])).toEqual([
      ['2019年3月7日', 0],
      ['三天后', 12],
    ])
  })

  it('reads a Chinese year with a month after it', () => {
    const found = scanProseTimes('二〇二〇年10月，雪')
    expect(found.filter((item) => item.kind === 'absolute').map((item) => item.when)).toEqual(['2020-10'])
  })
})

describe('firstAbsolute', () => {
  it('returns the first stated date, skipping relative ones', () => {
    const found = scanProseTimes('三天后，也就是 1998年9月，他离开了。')
    expect(firstAbsolute(found)?.when).toBe('1998-09')
  })

  it('returns nothing when the prose never names a date', () => {
    expect(firstAbsolute(scanProseTimes('雨下了一夜。'))).toBeUndefined()
  })
})
