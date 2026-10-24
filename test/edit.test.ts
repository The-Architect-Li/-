/**
 * The panel's write doors validate before they touch the store.
 *
 * These tests are about the refusals, not the happy path: a bad role, an empty
 * chapter, a two-megabyte paste. Each one has to be a sentence a writer can act
 * on, because the model reads the same message back.
 */
import { describe, expect, it } from 'vitest'
import { PanelInputError } from '../src/panel/dirs.ts'
import {
  MAX_CHAPTER_CHARS,
  MAX_FIELD_CHARS,
  readChapterPatch,
  readCharacterPatch,
  readWorldPatch,
} from '../src/panel/edit.ts'

describe('readCharacterPatch', () => {
  it('keeps the name from the route, not from the body', () => {
    const patch = readCharacterPatch('沈砚', { name: '闻莺', voice: '短句' })
    expect(patch.name).toBe('沈砚')
    expect(patch.voice).toBe('短句')
  })

  it('leaves omitted fields undefined so the store can keep the old value', () => {
    const patch = readCharacterPatch('沈砚', { goal: '找到妹妹' })
    expect(patch.voice).toBeUndefined()
    expect(patch.goal).toBe('找到妹妹')
  })

  it('trims what was typed', () => {
    expect(readCharacterPatch('沈砚', { voice: '  短句，问句多  ' }).voice).toBe('短句，问句多')
  })

  it('refuses a role the book does not use', () => {
    expect(() => readCharacterPatch('沈砚', { role: 'narrator' })).toThrow(PanelInputError)
    expect(() => readCharacterPatch('沈砚', { role: 'narrator' })).toThrow(/role 只能是/)
  })

  it('refuses a field that is not a string', () => {
    expect(() => readCharacterPatch('沈砚', { voice: 42 })).toThrow(/说话方式 必须是字符串/)
  })

  it('refuses a field that is really a pasted document', () => {
    const huge = '很'.repeat(MAX_FIELD_CHARS + 1)
    expect(() => readCharacterPatch('沈砚', { secret: huge })).toThrow(/秘密 太长了/)
  })
})

describe('readWorldPatch', () => {
  it('reads kind and detail', () => {
    const patch = readWorldPatch('雾港', { kind: '地点', detail: '终年不散的雾' })
    expect(patch).toEqual({ name: '雾港', kind: '地点', detail: '终年不散的雾' })
  })

  it('refuses an over-long kind, which is a one-line label', () => {
    expect(() => readWorldPatch('雾港', { kind: 'x'.repeat(300) })).toThrow(/设定类型 太长了/)
  })

  it('refuses a non-string detail', () => {
    expect(() => readWorldPatch('雾港', { detail: ['a'] })).toThrow(/设定内容 必须是字符串/)
  })
})

describe('readChapterPatch', () => {
  it('keeps the number from the route', () => {
    const patch = readChapterPatch('7', { text: '沈砚走进秤房。', title: '过秤' })
    expect(patch.number).toBe(7)
    expect(patch.title).toBe('过秤')
    expect(patch.text).toBe('沈砚走进秤房。')
  })

  it('refuses a chapter number that is not a positive integer', () => {
    expect(() => readChapterPatch('0', { text: 'x' })).toThrow('章号必须是正整数。')
    expect(() => readChapterPatch('1.5', { text: 'x' })).toThrow('章号必须是正整数。')
    expect(() => readChapterPatch('一', { text: 'x' })).toThrow('章号必须是正整数。')
  })

  it('refuses a missing or blank body', () => {
    expect(() => readChapterPatch('1', {})).toThrow(/缺少 text/)
    expect(() => readChapterPatch('1', { text: '   \n  ' })).toThrow('正文不能为空。')
  })

  it('refuses a body past the ceiling', () => {
    const huge = '文'.repeat(MAX_CHAPTER_CHARS + 1)
    expect(() => readChapterPatch('1', { text: huge })).toThrow(/正文 太长了/)
  })

  it('refuses an over-long title', () => {
    expect(() => readChapterPatch('1', { text: 'x', title: 't'.repeat(200) })).toThrow(/标题 太长了/)
  })
})
