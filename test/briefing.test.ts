import { describe, expect, it } from 'vitest'
import { buildBriefing } from '../src/domain/briefing.ts'
import { resolveConfig } from '../src/config.ts'
import type { ChapterDraft, Snapshot } from '../src/domain/types.ts'

function snapshot(): Snapshot {
  return {
    project: {
      formatVersion: 1,
      title: '雾港',
      phase: 'drafting',
      premise: '一个替人销赃的船工发现自己的妹妹在货舱里。',
      targetWords: 800000,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    characters: [
      {
        name: '沈砚',
        role: 'protagonist',
        voice: '短句，几乎不用形容词，回答前先停顿',
        appearance: '左手少一根指节',
        goal: '找到妹妹',
        secret: '他烧过一艘船',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        name: '阿鸢',
        role: 'supporting',
        voice: '语速快，爱用反问',
        appearance: '总穿不合身的男装',
        goal: '拿回航图',
        secret: '改过航向',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    world: [{ name: '雾港', kind: '地点', detail: '终年起雾', updatedAt: '2026-01-01T00:00:00.000Z' }],
    places: [],
    storyPoints: [],
    timeline: { formatVersion: 1, anchors: [], spans: [] },
    relations: { formatVersion: 1, edges: [] },
    volumes: [{ number: 1, title: '入港', summary: '', approved: true }],
    plans: [
      {
        number: 3,
        volume: 1,
        title: '夜渡',
        pov: '沈砚',
        characters: ['沈砚', '阿鸢'],
        beats: ['沈砚发现船底藏着尸体', '阿鸢承认改过航向'],
        hooks: ['岸上有人等他'],
        approved: true,
      },
    ],
    ledger: [
      {
        id: 'f-0001',
        subject: '沈砚',
        predicate: '左眼颜色',
        value: '黑',
        chapter: 1,
        quote: '他的左眼黑得像井',
        supersedes: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'f-0002',
        subject: '阿鸢',
        predicate: '伏笔·航图',
        value: '她随身带着一半',
        chapter: 2,
        quote: '',
        supersedes: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    chapters: [
      { number: 1, title: '入港', words: 3000, summary: '沈砚接下一单货', writtenAt: '2026-01-01T00:00:00.000Z' },
      { number: 2, title: '旧账', words: 3200, summary: '阿鸢找上门', writtenAt: '2026-01-01T00:00:00.000Z' },
    ],
  }
}

function drafts(): ChapterDraft[] {
  return [
    { number: 1, title: '入港', words: 3000, summary: '沈砚接下一单货', writtenAt: '', text: '雾从海面漫上来。'.repeat(40) },
    { number: 2, title: '旧账', words: 3200, summary: '阿鸢找上门', writtenAt: '', text: '阿鸢把航图拍在桌上。'.repeat(30) },
  ]
}

describe('buildBriefing', () => {
  it('puts the contract and the cast in front', () => {
    const result = buildBriefing(snapshot(), drafts(), 3, resolveConfig())
    expect(result.markdown).toContain('本章合同')
    expect(result.markdown).toContain('沈砚发现船底藏着尸体')
    expect(result.markdown).toContain('说话方式')
    expect(result.sections[0]?.name).toBe('本章合同')
  })

  it('carries the facts and the open threads', () => {
    const result = buildBriefing(snapshot(), drafts(), 3, resolveConfig())
    expect(result.markdown).toContain('左眼颜色')
    expect(result.markdown).toContain('待回收线索')
    expect(result.markdown).toContain('航图')
  })

  it('stays inside the budget', () => {
    const result = buildBriefing(snapshot(), drafts(), 3, resolveConfig({ briefingBudgetChars: 900 }))
    expect(result.totalChars).toBeLessThanOrEqual(900 + 200)
    expect(result.budgetChars).toBe(900)
  })

  it('carries the book’s own craft notes into the pack', () => {
    const notes = [
      { name: '开篇钩子', title: '开篇钩子', text: '前三句里必须有一个问题。' },
      { name: '对话', title: '对话', text: '不写「说道」，用动作代替。' },
    ]
    const result = buildBriefing(snapshot(), drafts(), 3, resolveConfig(), notes)
    expect(result.markdown).toContain('写作笔记')
    expect(result.markdown).toContain('前三句里必须有一个问题')
    expect(result.markdown).toContain('不写「说道」')
    // Notes are how the book is written, not who is in it: they come after the
    // cast so a long note cannot push the people out of the budget.
    const order = result.sections.map((section) => section.name)
    expect(order.indexOf('写作笔记')).toBeGreaterThan(order.indexOf('出场角色'))
  })

  it('says nothing about notes when the book has none', () => {
    const result = buildBriefing(snapshot(), drafts(), 3, resolveConfig())
    expect(result.markdown).not.toContain('写作笔记')
  })

  it('keeps the contract and the cast when the notes would fill the budget', () => {
    const notes = Array.from({ length: 6 }, (_, index) => ({
      name: `note-${index}`,
      title: `笔记${index}`,
      text: '这一条很长的规则，用来把预算挤满。'.repeat(40),
    }))
    const result = buildBriefing(snapshot(), drafts(), 3, resolveConfig({ briefingBudgetChars: 900 }), notes)
    expect(result.markdown).toContain('本章合同')
    expect(result.markdown).toContain('说话方式')
  })

  it('warns when there is no outline instead of inventing one', () => {
    const state = snapshot()
    state.plans = []
    const result = buildBriefing(state, drafts(), 9, resolveConfig())
    expect(result.markdown).toContain('还没有章纲')
  })

  it('handles the first chapter with no previous text', () => {
    const result = buildBriefing(snapshot(), [], 1, resolveConfig())
    expect(result.markdown).toContain('这是第一章')
  })

  it('hands the writer the places the outline names, as they stand by now', () => {
    const state = snapshot()
    state.plans[0]!.beats.push('在三号仓里对质')
    state.places = [
      {
        name: '三号仓',
        aliases: ['旧仓'],
        kind: '室内',
        firstChapter: 1,
        latestChapter: 2,
        detail: '潮湿，霉味很重',
        states: [
          { chapter: 1, detail: '堆着别人的货' },
          { chapter: 2, detail: '潮湿，霉味很重' },
        ],
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ]
    const result = buildBriefing(state, drafts(), 3, resolveConfig())
    expect(result.markdown).toContain('本章地点')
    expect(result.markdown).toContain('三号仓')
    // The state in force as of chapter 3 is chapter 2's, not the standing detail.
    expect(result.markdown).toContain('第2章时：潮湿，霉味很重')
  })

  it('names who is in the room and how they stand to each other', () => {
    const state = snapshot()
    state.relations = {
      formatVersion: 1,
      edges: [{ id: 'rel-阿鸢|沈砚', from: '阿鸢', to: '沈砚', kind: '债主', symmetric: false, note: '他欠她一条船' }],
    }
    const result = buildBriefing(state, drafts(), 3, resolveConfig())
    expect(result.markdown).toContain('人物关系')
    expect(result.markdown).toContain('沈砚 —— 债主')
    expect(result.markdown).toContain('（本章在场）')
  })

  it('says the graph and the map are empty instead of pretending they are fine', () => {
    const result = buildBriefing(snapshot(), drafts(), 3, resolveConfig())
    expect(result.markdown).toContain('关系表里没有这几个人')
    expect(result.markdown).toContain('章纲没有点名地点')
  })
})
