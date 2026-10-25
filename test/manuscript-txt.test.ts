import { describe, expect, it } from 'vitest'
import { chineseNumber, planChapters, splitManuscript } from '../src/domain/import-scan.ts'

/** One file, the way `readSources` hands it over. */
function file(name: string, text: string) {
  return { path: `C:/稿子/${name}`, name, text }
}

describe('chineseNumber', () => {
  it('reads the numerals a chapter heading uses', () => {
    expect(chineseNumber('一')).toBe(1)
    expect(chineseNumber('十')).toBe(10)
    expect(chineseNumber('十二')).toBe(12)
    expect(chineseNumber('二十三')).toBe(23)
    expect(chineseNumber('一百零一')).toBe(101)
    expect(chineseNumber('两百')).toBe(200)
  })

  it('refuses text that is not numerals', () => {
    expect(chineseNumber('裂缝')).toBeUndefined()
    expect(chineseNumber('')).toBeUndefined()
  })
})

describe('splitManuscript', () => {
  it('splits one long txt on its own chapter headings', () => {
    const text = [
      '第一章 裂缝',
      '',
      '雨落了一夜。',
      '',
      '第二章 金童玉女',
      '',
      '她当年那句话还在耳边。',
    ].join('\n')
    const parts = splitManuscript(file('待定.txt', text))
    expect(parts.map((part) => part.name)).toEqual(['第1章 裂缝.txt', '第2章 金童玉女.txt'])
    expect(parts[0]!.text).toBe('雨落了一夜。')
    expect(parts[1]!.text).toBe('她当年那句话还在耳边。')
  })

  it('reads Arabic numerals and English headings too', () => {
    const arabic = splitManuscript(file('book.txt', '第1章 起\n\n甲。\n\n第2章 承\n\n乙。'))
    expect(arabic.map((part) => part.name)).toEqual(['第1章 起.txt', '第2章 承.txt'])
    const english = splitManuscript(file('book.txt', 'Chapter 1 Dawn\n\nA.\n\nChapter 2 Dusk\n\nB.'))
    expect(english.map((part) => part.name)).toEqual(['第1章 Dawn.txt', '第2章 Dusk.txt'])
  })

  it('leaves a file alone when it names a chapter itself', () => {
    const parts = splitManuscript(file('第7章 过秤.md', '第一章不是标题。'))
    expect(parts).toHaveLength(1)
    expect(parts[0]!.name).toBe('第7章 过秤.md')
  })

  it('leaves a file alone when it holds fewer than two headings', () => {
    const parts = splitManuscript(file('序.txt', '第一章 只要一处\n\n正文。'))
    expect(parts).toHaveLength(1)
    expect(parts[0]!.name).toBe('序.txt')
  })

  it('keeps the first of two headings that claim one number', () => {
    const parts = splitManuscript(file('a.txt', '第1章 一\n\n甲。\n\n第1章 又一遍\n\n乙。\n\n第2章 二\n\n丙。'))
    expect(parts.map((part) => part.name)).toEqual(['第1章 一.txt', '第2章 二.txt'])
    expect(parts[0]!.text).toContain('甲。')
    expect(parts[0]!.text).toContain('乙。')
  })
})

describe('planChapters with one long file', () => {
  it('numbers a split txt as chapters', () => {
    const plan = planChapters([
      file('待定.txt', '第一章 裂缝\n\n雨落了一夜。\n\n第二章 金童玉女\n\n她当年那句话还在耳边。'),
    ])
    expect(plan.chapters.map((chapter) => [chapter.number, chapter.title])).toEqual([
      [1, '裂缝'],
      [2, '金童玉女'],
    ])
    expect(plan.chapters[0]!.words).toBeGreaterThan(0)
    expect(plan.ignored).toEqual([])
  })
})
