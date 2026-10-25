import { describe, expect, it } from 'vitest'
import { chapterRanges, describeCoverage, recordCoverage } from '../src/domain/records.ts'
import type { Snapshot } from '../src/domain/types.ts'

/**
 * A snapshot with only the fields coverage reads.
 *
 * @param chapters - written chapter numbers.
 * @param places - place cards, chapter-tagged.
 * @param clock - anchors and spans.
 * @returns a snapshot-shaped object.
 */
function snapshot(
  chapters: number[],
  places: { chapter: number }[] = [],
  clock: { anchors?: number[]; spans?: [number, number][] } = {},
): Snapshot {
  return {
    chapters: chapters.map((number) => ({ number, title: `第${number}章`, words: 10 })),
    places: places.map((entry, index) => ({
      name: `地点${index}`,
      states: [{ chapter: entry.chapter, detail: '样子', note: null }],
    })),
    storyPoints: [],
    timeline: {
      anchors: (clock.anchors ?? []).map((chapter) => ({ id: `a${chapter}`, chapter, when: '2019', label: 'x' })),
      spans: (clock.spans ?? []).map(([fromChapter, toChapter]) => ({
        id: `s${fromChapter}`,
        fromChapter,
        toChapter,
        days: { min: 1, max: 2 },
        text: 'x',
      })),
      recalls: [],
    },
  } as unknown as Snapshot
}

describe('recordCoverage', () => {
  it('calls every chapter of a fresh book silent, and says the book is empty', () => {
    const coverage = recordCoverage(snapshot([1, 2, 3]))
    expect(coverage.silent).toEqual([1, 2, 3])
    expect(coverage.empty).toBe(true)
    expect(coverage.reached).toBe(0)
  })

  it('counts a chapter covered by a place, an anchor, or a span', () => {
    const coverage = recordCoverage(
      snapshot([1, 2, 3, 4, 5], [{ chapter: 2 }], { anchors: [4], spans: [[1, 3]] }),
    )
    expect(coverage.silent).toEqual([5])
    expect(coverage.covered).toBe(4)
    expect(coverage.reached).toBe(4)
    expect(coverage.empty).toBe(false)
  })

  it('counts every chapter inside a span, not just its two ends', () => {
    const coverage = recordCoverage(snapshot([1, 2, 3, 4], [], { spans: [[1, 4]] }))
    expect(coverage.silent).toEqual([])
  })
})

describe('chapterRanges', () => {
  it('compresses consecutive numbers', () => {
    expect(chapterRanges([1, 2, 3, 7, 9, 10, 11])).toBe('第1–3、7、9–11章')
    expect(chapterRanges([5])).toBe('第5章')
    expect(chapterRanges([])).toBe('')
  })
})

describe('describeCoverage', () => {
  it('tells a freshly imported book to start at chapter one', () => {
    const text = describeCoverage(recordCoverage(snapshot([1, 2, 3])))
    expect(text).toContain('都还是空的')
    expect(text).toContain('novel_canon action="upsert_place"')
  })

  it('names the silent ranges and where the records stop', () => {
    const text = describeCoverage(recordCoverage(snapshot([1, 2, 3, 4, 5], [{ chapter: 1 }], { anchors: [2] })))
    expect(text).toContain('3 章没有留下任何记录')
    expect(text).toContain('第3–5章')
    expect(text).toContain('最远只到第 2 章')
    expect(text).toContain('最后一章也在里面')
  })

  it('says nothing when every chapter is covered', () => {
    expect(describeCoverage(recordCoverage(snapshot([1, 2], [{ chapter: 1 }], { anchors: [2] })))).toBe('')
  })
})
