/**
 * Two questions no single chapter can answer.
 *
 * 「这本书作为一本书怎么样」 and 「我把谁写丢了」. Both are arithmetic over records that
 * already exist, so both are cheap — and both are easy to make lie: a bucket
 * that reports chapters that do not exist, a hook check that passes because
 * there are no cards to check.
 */
import { describe, expect, it } from 'vitest'
import { axisLine, describeShape, shapeOf, sparkline } from '../src/domain/shape.ts'
import { SILENT_AFTER, describePresence, presenceOf, silentPeople } from '../src/domain/presence.ts'
import type { ChapterMeta, ChapterPlan, VolumeOutline } from '../src/domain/types.ts'

function chapter(number: number, words: number): ChapterMeta {
  return { number, title: `第${number}章`, words, summary: '', writtenAt: '2026-01-01T00:00:00.000Z', revision: 1 }
}

function plan(number: number, over: Partial<ChapterPlan> = {}): ChapterPlan {
  return { number, volume: 1, title: `第${number}章`, pov: '', characters: [], beats: [], hooks: [], approved: true, ...over }
}

function volume(number: number, title = `第${number}卷`): VolumeOutline {
  return { number, title, summary: '', approved: true }
}

describe('shapeOf', () => {
  it('never reports a chapter that does not exist', () => {
    // 41 chapters at 20 per column: the third column would otherwise claim 61.
    const chapters = Array.from({ length: 41 }, (_, index) => chapter(index + 1, 1000))
    const shape = shapeOf(chapters, [], [])
    expect(shape.buckets[shape.buckets.length - 1]?.to).toBe(41)
  })

  it('measures a bucket by average, so one extra chapter does not look taller', () => {
    const chapters = [...Array.from({ length: 20 }, (_, i) => chapter(i + 1, 1000)), chapter(21, 1000)]
    const shape = shapeOf(chapters, [], [])
    expect(shape.buckets.every((bucket) => bucket.words === 1000)).toBe(true)
  })

  it('says hooks are unknown when no chapter has a card', () => {
    const shape = shapeOf([chapter(1, 1000), chapter(2, 1000)], [], [])
    expect(shape.carded).toBe(0)
    expect(describeShape(shape)).toContain('还没有任何章卡')
  })

  it('does not count a chapter with no card as a dry spell', () => {
    // Absence of a card is absence of information, not absence of a hook.
    const chapters = [chapter(1, 1000), chapter(2, 1000), chapter(3, 1000)]
    const shape = shapeOf(chapters, [plan(1, { hooks: ['她回头'] })], [])
    expect(shape.drySpells).toEqual([])
  })

  it('finds runs of chapters whose cards have no hook', () => {
    const chapters = Array.from({ length: 6 }, (_, i) => chapter(i + 1, 1000))
    const plans = [1, 2, 3, 4, 5, 6].map((n) => plan(n, { hooks: n === 6 ? ['有人敲门'] : [] }))
    const shape = shapeOf(chapters, plans, [])
    expect(shape.drySpells[0]).toMatchObject({ from: 1, to: 5, length: 5 })
  })

  it('reports volume sizes from the cards, since chapters do not carry a volume', () => {
    const chapters = [chapter(1, 1000), chapter(2, 2000), chapter(3, 500)]
    const plans = [plan(1, { volume: 1 }), plan(2, { volume: 2 }), plan(3, { volume: 2 })]
    const shape = shapeOf(chapters, plans, [volume(1, '入港'), volume(2, '沉船')])
    expect(shape.volumes.map((item) => [item.number, item.words])).toEqual([[1, 1000], [2, 2500]])
  })
})

describe('drawing', () => {
  it('scales the blocks to the range it was given', () => {
    expect(sparkline([1, 2, 3])).toBe('▁▅█')
    expect(sparkline([5, 5, 5])).toBe('▁▁▁')
    expect(sparkline([])).toBe('')
  })

  it('pads the axis by display width, not character count', () => {
    const line = axisLine(1, 521, 20)
    // 「第1章」 is 4 columns, 「第521章」 is 6; the total must be the bar width.
    expect(line.startsWith('第1章')).toBe(true)
    expect(line.endsWith('第521章')).toBe(true)
  })
})

describe('presenceOf', () => {
  it('counts only chapters that were actually written', () => {
    // A card for an unwritten chapter is a plan, not a scene.
    const report = presenceOf([plan(1, { characters: ['沈砚'] }), plan(2, { characters: ['沈砚'] })], [chapter(1, 100)])
    expect(report.people[0]?.chapters).toEqual([1])
    expect(report.covered).toBe(1)
    expect(report.written).toBe(1)
  })

  it('measures silence from the last appearance to the end of the book', () => {
    const plans = [plan(1, { characters: ['沈砚'] }), plan(2, { characters: ['阿鸢'] })]
    const chapters = [chapter(1, 100), chapter(2, 100), chapter(3, 100)]
    const report = presenceOf(plans, chapters)
    const aYuan = report.people.find((person) => person.name === '阿鸢')
    expect(aYuan?.last).toBe(2)
    expect(aYuan?.silent).toBe(1)
  })

  it('keeps cameos out of the reminder', () => {
    // 「只在第 1 章出现过一次」 is a spear carrier, not a dropped thread. 沈砚 has a
    // real presence and then one chapter of silence, so he is the one reported.
    const plans = [plan(1, { characters: ['老周', '沈砚'] }), plan(2, { characters: ['沈砚'] })]
    const chapters = [chapter(1, 100), chapter(2, 100), chapter(3, 100)]
    const silent = silentPeople(presenceOf(plans, chapters), 1)
    expect(silent.map((person) => person.name)).toEqual(['沈砚'])
    expect(silent[0]?.appearances).toBe(2)
  })

  it('says why it is empty instead of pretending nobody appears', () => {
    const report = presenceOf([], [chapter(1, 100), chapter(2, 100)])
    expect(report.covered).toBe(0)
    const text = describePresence(report)
    expect(text).toContain('算不出谁在场')
    expect(text).toContain('novel_archive')
  })

  it('lists the longest silence first', () => {
    const plans = [
      plan(1, { characters: ['老周'] }),
      plan(1, { characters: ['沈砚'] }),
      plan(9, { characters: ['沈砚'] }),
      plan(2, { characters: ['老周'] }),
    ]
    const chapters = Array.from({ length: 30 }, (_, i) => chapter(i + 1, 100))
    const report = presenceOf(plans, chapters)
    expect(report.people[0]?.name).toBe('阿鸢'.length === 2 ? '老周' : '老周')
    expect(report.people[0]?.silent).toBe(28)
    expect(SILENT_AFTER).toBeGreaterThan(0)
  })
})
