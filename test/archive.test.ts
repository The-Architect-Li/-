/**
 * Reading prose into chapter cards.
 *
 * Nothing here spawns a model: the prompt, the parse, the merge and the
 * "which chapters still need one" question are all pure, and they are where
 * the bugs live. A card written from the wrong chapter number, or a merge that
 * quietly overwrites an approved outline, would be invisible until chapter 300.
 */
import { describe, expect, it } from 'vitest'
import {
  ARCHIVE_HEAD_CHARS,
  ARCHIVE_TAIL_CHARS,
  buildArchivePrompt,
  chaptersNeedingCards,
  mergeArchiveCard,
  parseArchiveOutput,
  trimForArchive,
} from '../src/domain/archive.ts'
import { ROLES } from '../src/roles.ts'
import type { ChapterDraft, ChapterPlan } from '../src/domain/types.ts'

function chapter(number: number, text: string, revision = 1): ChapterDraft {
  return {
    number,
    title: `第${number}章`,
    words: text.length,
    summary: '',
    writtenAt: '2026-01-01T00:00:00.000Z',
    revision,
    text,
  }
}

function plan(number: number, extra: Partial<ChapterPlan> = {}): ChapterPlan {
  return {
    number,
    volume: 0,
    title: `第${number}章`,
    pov: '',
    characters: [],
    beats: [],
    hooks: [],
    approved: false,
    ...extra,
  }
}

describe('trimForArchive', () => {
  it('leaves a short chapter alone', () => {
    const text = '雾从海面漫上来。'.repeat(10)
    expect(trimForArchive(text)).toBe(text)
  })

  it('keeps both ends and drops the middle', () => {
    const text = `${'甲'.repeat(ARCHIVE_HEAD_CHARS)}${'乙'.repeat(4000)}${'丙'.repeat(ARCHIVE_TAIL_CHARS)}`
    const trimmed = trimForArchive(text)
    expect(trimmed).toContain('甲')
    expect(trimmed).toContain('丙')
    expect(trimmed).toContain('中间略')
    expect(trimmed).not.toContain('乙')
    expect(trimmed.length).toBeLessThan(text.length)
  })
})

describe('buildArchivePrompt', () => {
  it('marks every chapter with its number so the answer can be keyed back', () => {
    const prompt = buildArchivePrompt(
      [
        { number: 7, title: '夜渡', text: '船靠岸了。' },
        { number: 8, title: '旧账', text: '阿鸢来了。' },
      ],
      ROLES.archivist.persona,
      ROLES.archivist.outputContract,
    )
    expect(prompt).toContain('=== 第7章 夜渡 ===')
    expect(prompt).toContain('=== 第8章 旧账 ===')
    expect(prompt).toContain('船靠岸了。')
    expect(prompt).toContain(ROLES.archivist.outputContract)
  })
})

describe('parseArchiveOutput', () => {
  it('reads a plain JSON array', () => {
    const cards = parseArchiveOutput(
      '[{"number":3,"summary":"沈砚发现了尸体。","events":["开舱","发现尸体"],"scene":"货舱","characters":["沈砚"],"hook":"谁把尸体搬上来的？"}]',
    )
    expect(cards).toHaveLength(1)
    expect(cards[0]).toEqual({
      number: 3,
      summary: '沈砚发现了尸体。',
      events: ['开舱', '发现尸体'],
      scene: '货舱',
      characters: ['沈砚'],
      hook: '谁把尸体搬上来的？',
    })
  })

  it('survives the fences and the chatter around it', () => {
    const cards = parseArchiveOutput(
      '好的，这是结果：\n```json\n[{"number":1,"summary":"她上了船。"}]\n```\n需要我继续吗？',
    )
    expect(cards.map((card) => card.number)).toEqual([1])
    expect(cards[0]?.summary).toBe('她上了船。')
  })

  it('reads a bulleted string where an array was asked for', () => {
    const cards = parseArchiveOutput('[{"number":2,"summary":"x","events":"1.开舱\\n2.发现尸体"}]')
    expect(cards[0]?.events).toEqual(['开舱', '发现尸体'])
  })

  it('returns what parsed when one chapter is broken', () => {
    const cards = parseArchiveOutput('[{"number":4,"summary":"好的。"},{"number":"五","summary":"坏的"},{"number":5,"summary":"另一章。"}]')
    expect(cards.map((card) => card.number)).toEqual([4, 5])
  })

  it('gives up quietly on prose instead of throwing', () => {
    expect(parseArchiveOutput('这一章讲的是沈砚发现尸体。')).toEqual([])
  })
})

describe('mergeArchiveCard', () => {
  const card = {
    number: 7,
    summary: '沈砚在货舱里发现了尸体。',
    events: ['开舱', '发现尸体'],
    scene: '货舱',
    characters: ['沈砚', '阿鸢'],
    hook: '谁搬上来的？',
  }

  it('creates a plan when the book had none, and does not call it approved', () => {
    const merged = mergeArchiveCard(undefined, card, '夜渡', 0, 3)
    expect(merged.summary).toBe(card.summary)
    expect(merged.events).toEqual(card.events)
    expect(merged.approved).toBe(false)
    expect(merged.cardRevision).toBe(3)
  })

  it('keeps the beats of a real outline', () => {
    // The archivist read the result; the outline is the intent. Overwriting the
    // beats with a recap would silently un-plan the chapter.
    const existing = plan(7, { volume: 1, beats: ['沈砚开舱', '阿鸢承认改过航向'], approved: true, hooks: ['旧钩子'] })
    const merged = mergeArchiveCard(existing, card, '夜渡', 0, 2)
    expect(merged.beats).toEqual(['沈砚开舱', '阿鸢承认改过航向'])
    expect(merged.approved).toBe(true)
    expect(merged.volume).toBe(1)
    expect(merged.summary).toBe(card.summary)
  })

  it('leaves the hook alone when the model found none', () => {
    const existing = plan(7, { hooks: ['谁改过航向？'] })
    const merged = mergeArchiveCard(existing, { ...card, hook: '' }, '夜渡', 0, 1)
    expect(merged.hooks).toEqual(['谁改过航向？'])
  })

  it('keeps the planned cast when the model named nobody', () => {
    const existing = plan(7, { characters: ['沈砚'] })
    const merged = mergeArchiveCard(existing, { ...card, characters: [] }, '夜渡', 0, 1)
    expect(merged.characters).toEqual(['沈砚'])
  })
})

describe('chaptersNeedingCards', () => {
  it('lists a chapter with no plan at all', () => {
    expect(chaptersNeedingCards([chapter(1, '正文。'), chapter(2, '正文。')], [])).toEqual([1, 2])
  })

  it('skips a chapter whose card describes the current prose', () => {
    const chapters = [chapter(1, '正文。', 2), chapter(2, '正文。', 1)]
    const plans = [plan(1, { summary: '有卡', cardRevision: 2 }), plan(2, { summary: '有卡', cardRevision: 1 })]
    expect(chaptersNeedingCards(chapters, plans)).toEqual([])
  })

  it('asks again when the body moved on since the card was written', () => {
    const chapters = [chapter(1, '正文。', 4)]
    const plans = [plan(1, { summary: '旧卡', cardRevision: 2 })]
    expect(chaptersNeedingCards(chapters, plans)).toEqual([1])
  })

  it('asks for a chapter whose plan exists but whose card is empty', () => {
    const chapters = [chapter(1, '正文。', 1)]
    expect(chaptersNeedingCards(chapters, [plan(1, { summary: '   ' })])).toEqual([1])
  })

  it('ignores a chapter with no prose yet', () => {
    expect(chaptersNeedingCards([chapter(1, ''), chapter(2, '正文。')], [])).toEqual([2])
  })
})
