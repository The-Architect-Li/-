/**
 * Looking things up in a book too long to remember.
 *
 * The rules that matter here are the ones a writer notices when they are wrong:
 * a word split at the wrong place, a count that lies, a "not found" that means
 * "we stopped looking".
 */
import { describe, expect, it } from 'vitest'
import { contextAt, describeSearch, parseTerms, searchChapters } from '../src/domain/search.ts'
import type { ChapterDraft } from '../src/domain/types.ts'

function chapter(number: number, text: string, title = `第${number}章`): ChapterDraft {
  return { number, title, text, words: text.length, summary: '', writtenAt: '2026-01-01T00:00:00.000Z', revision: 1 }
}

describe('parseTerms', () => {
  it('splits on spaces and Chinese punctuation', () => {
    expect(parseTerms('沈砚 瑶光境')).toEqual(['沈砚', '瑶光境'])
    expect(parseTerms('沈砚，瑶光境、阿鸢')).toEqual(['沈砚', '瑶光境', '阿鸢'])
  })

  it('keeps a quoted phrase whole', () => {
    expect(parseTerms('「那封没拆的信」 沈砚')).toEqual(['那封没拆的信', '沈砚'])
    expect(parseTerms('"third disciple" 掌门')).toEqual(['third disciple', '掌门'])
  })

  it('drops blanks and repeats', () => {
    expect(parseTerms('  沈砚   沈砚  ')).toEqual(['沈砚'])
    expect(parseTerms('   ')).toEqual([])
  })
})

describe('searchChapters', () => {
  const book = [
    chapter(1, '雾从海面漫上来。沈砚走进瑶光境。瑶光境的门在身后合上。'),
    chapter(2, '阿鸢在码头等他。'),
    chapter(3, '沈砚提起瑶光境，又说起那封信。'),
  ]

  it('finds every chapter that holds the word, in reading order', () => {
    const result = searchChapters(book, ['瑶光境'])
    expect(result.hits.map((hit) => hit.number)).toEqual([1, 3])
    expect(result.matched).toBe(2)
  })

  it('counts every occurrence, not just the sampled ones', () => {
    // Chapter 1 says it twice; a count of 1 would make the writer open the
    // chapter to check whether they had repeated themselves.
    const result = searchChapters(book, ['瑶光境'], { samples: 1 })
    expect(result.hits[0]?.count).toBe(2)
    expect(result.hits[0]?.samples).toHaveLength(1)
  })

  it('requires every term when several are given', () => {
    const result = searchChapters(book, ['沈砚', '阿鸢'])
    expect(result.hits).toEqual([])
  })

  it('honours a chapter range', () => {
    expect(searchChapters(book, ['瑶光境'], { from: 2 }).hits.map((hit) => hit.number)).toEqual([3])
    expect(searchChapters(book, ['瑶光境'], { to: 1 }).hits.map((hit) => hit.number)).toEqual([1])
  })

  it('keeps counting past the display limit, so the total is honest', () => {
    const many = Array.from({ length: 10 }, (_, index) => chapter(index + 1, '瑶光境'))
    const result = searchChapters(many, ['瑶光境'], { limit: 3 })
    expect(result.hits).toHaveLength(3)
    expect(result.matched).toBe(10)
    expect(result.truncated).toBe(true)
  })

  it('skips chapters with no prose yet', () => {
    const result = searchChapters([chapter(1, ''), chapter(2, '瑶光境')], ['瑶光境'])
    expect(result.scanned).toBe(1)
    expect(result.hits.map((hit) => hit.number)).toEqual([2])
  })
})

describe('contextAt', () => {
  it('keeps the word and folds newlines into one line', () => {
    const text = '第一段。\n\n第二段说到瑶光境，然后又走了。\n\n第三段。'
    const line = contextAt(text, text.indexOf('瑶光境'), 3)
    expect(line).toContain('瑶光境')
    expect(line).not.toContain('\n')
  })

  it('marks where it cut', () => {
    const text = `${'甲'.repeat(100)}瑶光境${'乙'.repeat(100)}`
    const line = contextAt(text, 100, 3)
    expect(line.startsWith('…')).toBe(true)
    expect(line.endsWith('…')).toBe(true)
  })
})

describe('describeSearch', () => {
  it('says where it looked when nothing matched', () => {
    const report = describeSearch(searchChapters([chapter(1, '别的话。')], ['瑶光境']), '瑶光境')
    expect(report).toContain('没有找到')
    expect(report).toContain('1 章')
  })

  it('mentions the cap when it bit', () => {
    const many = Array.from({ length: 5 }, (_, index) => chapter(index + 1, '瑶光境'))
    const report = describeSearch(searchChapters(many, ['瑶光境'], { limit: 2 }), '瑶光境')
    expect(report).toContain('5 章命中')
    expect(report).toContain('只列前 2 章')
  })

  it('asks for a word instead of failing on an empty query', () => {
    expect(describeSearch(searchChapters([], []), '')).toContain('要搜什么')
  })
})
