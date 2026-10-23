import { describe, expect, it } from 'vitest'
import {
  containment,
  countChars,
  countOccurrences,
  dialogueRatio,
  foldKey,
  meanStd,
  normalize,
  shingles,
  splitParagraphs,
  splitSentences,
  tailOf,
} from '../src/domain/text.ts'

describe('normalize', () => {
  it('folds full-width punctuation and collapses spaces', () => {
    expect(normalize('　主角　走了！ ')).toBe('主角 走了!')
  })
})

describe('foldKey', () => {
  it('ignores width, case and whitespace so equal facts compare equal', () => {
    expect(foldKey('左眼 颜色')).toBe(foldKey('左眼颜色'))
    expect(foldKey('ＡＢＣ')).toBe('abc')
  })
})

describe('countChars', () => {
  it('counts non-whitespace characters', () => {
    expect(countChars('他 走了。\n\n风很大。')).toBe(8)
  })
})

describe('splitSentences', () => {
  it('keeps terminal punctuation attached', () => {
    expect(splitSentences('他走了。风很大！你信吗？')).toEqual(['他走了。', '风很大！', '你信吗？'])
  })

  it('returns the trailing fragment without punctuation', () => {
    expect(splitSentences('他走了。然后')).toEqual(['他走了。', '然后'])
  })
})

describe('splitParagraphs', () => {
  it('splits on blank lines and drops empties', () => {
    expect(splitParagraphs('a\n\nb\n\n\nc')).toEqual(['a', 'b', 'c'])
  })
})

describe('shingles', () => {
  it('builds the expected number of windows', () => {
    expect(shingles('abcdef', 3).size).toBe(4)
  })

  it('ignores whitespace so reformatting does not change the fingerprint', () => {
    expect([...shingles('ab cd', 3)]).toEqual(['abc', 'bcd'])
  })
})

describe('containment', () => {
  it('is directional', () => {
    const small = new Set(['abc'])
    const large = new Set(['abc', 'def'])
    expect(containment(small, large)).toBe(1)
    expect(containment(large, small)).toBe(0.5)
  })

  it('is zero for an empty set', () => {
    expect(containment(new Set(), new Set(['x']))).toBe(0)
  })
})

describe('dialogueRatio', () => {
  it('measures quoted characters', () => {
    const text = '“走吧。”他说。'
    expect(dialogueRatio(text)).toBeCloseTo(5 / 8, 3)
  })
})

describe('meanStd', () => {
  it('is zero for a single value', () => {
    expect(meanStd([5])).toEqual({ mean: 5, std: 0 })
  })

  it('computes a population standard deviation', () => {
    expect(meanStd([2, 4, 4, 4, 5, 5, 7, 9])).toEqual({ mean: 5, std: 2 })
  })
})

describe('countOccurrences', () => {
  it('does not count overlapping matches', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2)
  })
})

describe('tailOf', () => {
  it('returns the whole text when it fits', () => {
    expect(tailOf('短句。', 10)).toBe('短句。')
  })

  it('truncates at a sentence boundary', () => {
    expect(tailOf('第一句。第二句。第三句。', 8)).toBe('第三句。')
  })
})
