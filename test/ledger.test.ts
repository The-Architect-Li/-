import { describe, expect, it } from 'vitest'
import {
  activeEntries,
  checkLedgerWrite,
  factsAbout,
  formatFact,
  supersededEntries,
} from '../src/domain/ledger.ts'
import type { LedgerEntry } from '../src/domain/types.ts'

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: 'f-0001',
    subject: '沈砚',
    predicate: '左眼颜色',
    value: '黑',
    chapter: 3,
    quote: '他的左眼黑得像井',
    supersedes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('checkLedgerWrite', () => {
  it('accepts the first assertion about a subject', () => {
    expect(checkLedgerWrite([], { subject: '沈砚', predicate: '左眼颜色', value: '黑', chapter: 3 }))
      .toEqual({ kind: 'accept' })
  })

  it('rejects empty fields', () => {
    const result = checkLedgerWrite([], { subject: ' ', predicate: '左眼颜色', value: '黑', chapter: 1 })
    expect(result.kind).toBe('invalid')
  })

  it('rejects a negative chapter', () => {
    const result = checkLedgerWrite([], { subject: '沈砚', predicate: '左眼颜色', value: '黑', chapter: -1 })
    expect(result.kind).toBe('invalid')
  })

  it('treats the same value as a duplicate instead of a conflict', () => {
    const result = checkLedgerWrite([entry()], {
      subject: '沈砚',
      predicate: '左眼颜色',
      value: ' 黑 ',
      chapter: 4,
    })
    expect(result.kind).toBe('duplicate')
  })

  it('refuses a contradiction inside one chapter', () => {
    const result = checkLedgerWrite([entry()], {
      subject: '沈砚',
      predicate: '左眼颜色',
      value: '蓝',
      chapter: 3,
    })
    expect(result.kind).toBe('conflict')
    if (result.kind === 'conflict') {
      expect(result.message).toContain('同一章内自相矛盾')
      expect(result.hint).toContain('f-0001')
    }
  })

  it('refuses an unannounced change across chapters', () => {
    const result = checkLedgerWrite([entry()], {
      subject: '沈砚',
      predicate: '左眼颜色',
      value: '蓝',
      chapter: 9,
    })
    expect(result.kind).toBe('conflict')
    if (result.kind === 'conflict') {
      expect(result.message).toContain('跨章改动')
      expect(result.hint).toContain('supersedes: "f-0001"')
    }
  })

  it('accepts an explicit replacement', () => {
    const result = checkLedgerWrite([entry()], {
      subject: '沈砚',
      predicate: '左眼颜色',
      value: '蓝',
      chapter: 9,
      supersedes: 'f-0001',
    })
    expect(result.kind).toBe('accept')
  })

  it('refuses a replacement that names a different fact', () => {
    const result = checkLedgerWrite([entry()], {
      subject: '沈砚',
      predicate: '佩刀',
      value: '断水',
      chapter: 9,
      supersedes: 'f-0001',
    })
    expect(result.kind).toBe('invalid')
  })

  it('refuses a replacement pointing at a missing id', () => {
    const result = checkLedgerWrite([entry()], {
      subject: '沈砚',
      predicate: '左眼颜色',
      value: '蓝',
      chapter: 9,
      supersedes: 'f-9999',
    })
    expect(result.kind).toBe('invalid')
  })

  it('refuses to let an earlier chapter overwrite a later one', () => {
    const result = checkLedgerWrite([entry({ chapter: 9 })], {
      subject: '沈砚',
      predicate: '左眼颜色',
      value: '蓝',
      chapter: 3,
      supersedes: 'f-0001',
    })
    expect(result.kind).toBe('invalid')
  })
})

describe('activeEntries', () => {
  it('drops entries replaced by a later one', () => {
    const old = entry({ id: 'f-0001' })
    const replacement = entry({ id: 'f-0002', value: '蓝', chapter: 9, supersedes: 'f-0001' })
    expect(activeEntries([old, replacement]).map((item) => item.id)).toEqual(['f-0002'])
    expect(supersededEntries([old, replacement]).map((item) => item.id)).toEqual(['f-0001'])
  })
})

describe('factsAbout', () => {
  it('matches the subject regardless of spacing', () => {
    expect(factsAbout([entry()], '沈 砚')).toHaveLength(1)
  })
})

describe('formatFact', () => {
  it('renders setup facts without a chapter number', () => {
    expect(formatFact(entry({ chapter: 0, quote: '' }))).toContain('设定阶段')
  })
})
