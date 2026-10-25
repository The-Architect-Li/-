/**
 * The page behind a tree row.
 *
 * A reader who clicks a row expects that thing's card, not a highlight, so the
 * projection has to survive three shapes: a complete entry, a half-written one
 * (fields still empty), and one that has been deleted since the tree was drawn.
 * The last case must be `undefined` — a blank page is worse than "刷新一下".
 */
import { describe, expect, it } from 'vitest'
import type { ChapterMeta, ChapterPlan, CharacterCard, DraftRound, LedgerEntry, PlaceCard, Snapshot, StoryPoint, VolumeOutline, WorldEntry } from '../src/domain/types.ts'
import { buildEntry } from '../src/panel/entry.ts'

const PREMISE = '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。'.repeat(4)
const ROOT = 'C:/books/雾港/.novel'

/** A book with one of everything, so a page can be read end to end. */
function book(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    project: {
      formatVersion: 1,
      title: '雾港',
      phase: 'drafting',
      premise: PREMISE,
      targetWords: 200_000,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    characters: [],
    world: [],
    places: [],
    storyPoints: [],
    timeline: { formatVersion: 1, anchors: [], spans: [] },
    volumes: [],
    plans: [],
    ledger: [],
    chapters: [],
    ...overrides,
  }
}

/** One character card. */
function card(name: string, role: CharacterCard['role'], extra: Partial<CharacterCard> = {}): CharacterCard {
  return { name, role, voice: '', appearance: '', goal: '', secret: '', updatedAt: '2026-01-01T00:00:00.000Z', ...extra }
}

/** One world entry. */
function place(name: string, kind = '地点', detail = ''): WorldEntry {
  return { name, kind, detail, updatedAt: '2026-01-01T00:00:00.000Z' }
}

/** One chapter outline. */
function plan(number: number, extra: Partial<ChapterPlan> = {}): ChapterPlan {
  return { number, volume: 1, title: '', pov: '', characters: [], beats: [], hooks: [], approved: true, ...extra }
}

/** One committed chapter. */
function written(number: number, title: string, words: number): ChapterMeta {
  return { number, title, words, summary: '', writtenAt: '2026-01-05T00:00:00.000Z' }
}

/** One volume. */
function volume(number: number, title: string): VolumeOutline {
  return { number, title, summary: '', approved: true }
}

/** One ledger fact. */
function fact(subject: string, predicate: string, value: string, chapter: number, supersedes: string | null = null): LedgerEntry {
  return { id: `f-${subject}-${predicate}`, subject, predicate, value, chapter, quote: '原文', supersedes, createdAt: '2026-01-01T00:00:00.000Z' }
}

/** One draft round. */
function round(errors: number, words = 1200): DraftRound {
  return {
    number: 1,
    round: 1,
    text: '正文',
    words,
    summary: '摘要',
    autoFindings: Array.from({ length: errors }, (_unused, index) => ({
      severity: 'error' as const,
      code: `test/${index}`,
      message: `问题${index}`,
      evidence: '',
    })),
    writtenAt: '2026-01-03T00:00:00.000Z',
  }
}

describe('character page', () => {
  it('shows the card as labelled fields', () => {
    const snapshot = book({
      characters: [card('沈砚', 'protagonist', { voice: '短句，问句多', appearance: '手上有绳茧', goal: '找到妹妹', secret: '他签过那张货单' })],
      plans: [plan(1, { title: '裂缝', characters: ['沈砚'] }), plan(2, { title: '过秤', characters: ['沈砚'] })],
      ledger: [fact('沈砚', '身份', '船工', 1), fact('沈砚', '旧身份', '替人销赃', 0, 'f-x')],
    })
    const page = buildEntry(snapshot, 'character', '沈砚', [], ROOT)
    expect(page).toBeDefined()
    if (page === undefined) return
    expect(page.title).toBe('沈砚')
    expect(page.subtitle).toBe('主角 · 找到妹妹')
    expect(page.chip).toBe('主角')
    expect(page.fields.map((field) => field.label)).toEqual(['说话方式', '外貌', '目标', '秘密', '最近改动'])
    expect(page.fields[0]?.value).toBe('短句，问句多')
    // Only live facts belong on the card: a superseded one is history.
    const facts = page.lists.find((list) => list.label === '账本里的事实')
    expect(facts?.items).toEqual(['身份＝船工（第1章）'])
    const appearances = page.lists.find((list) => list.label === '出场章节')
    expect(appearances?.items).toEqual(['第1章 裂缝', '第2章 过秤'])
    expect(page.root).toBe(ROOT)
  })

  it('says so instead of inventing text for an empty card', () => {
    const snapshot = book({ characters: [card('阿鸢', 'supporting')] })
    const page = buildEntry(snapshot, 'character', '阿鸢', [], ROOT)
    expect(page?.subtitle).toBe('配角')
    expect(page?.fields[0]?.value).toBe('（还没写）')
    // Nothing to list means no empty heading.
    expect(page?.lists).toEqual([])
  })

  it('returns undefined for a name the book no longer has', () => {
    expect(buildEntry(book({ characters: [card('沈砚', 'protagonist')] }), 'character', '闻莺', [], ROOT)).toBeUndefined()
  })
})

describe('world page', () => {
  it('shows the entry and the facts recorded about it', () => {
    const snapshot = book({
      world: [place('雾港', '地点', '终年不散的雾，靠铜哨领航')],
      ledger: [fact('雾港', '规矩', '入港必须买引水', 3)],
    })
    const page = buildEntry(snapshot, 'world', '雾港', [], ROOT)
    expect(page?.subtitle).toBe('地点')
    expect(page?.chip).toBe('地点')
    expect(page?.fields.find((field) => field.label === '细节')?.value).toBe('终年不散的雾，靠铜哨领航')
    expect(page?.lists[0]?.items).toEqual(['规矩＝入港必须买引水（第3章）'])
  })

  it('falls back to 设定 when the entry has no kind', () => {
    const snapshot = book({ world: [{ name: '铜哨', kind: '', detail: '', updatedAt: '2026-01-01T00:00:00.000Z' }] })
    const page = buildEntry(snapshot, 'world', '铜哨', [], ROOT)
    expect(page?.subtitle).toBe('设定')
    expect(page?.chip).toBeUndefined()
  })
})

describe('chapter page', () => {
  it('describes a committed chapter with its outline', () => {
    const snapshot = book({
      volumes: [volume(1, '雾里的货单')],
      plans: [plan(1, { title: '裂缝', pov: '沈砚', characters: ['沈砚', '阿鸢'], beats: ['发现尸体', '改航向'], hooks: ['岸上有人等他'] })],
      chapters: [written(1, '裂缝', 2140)],
    })
    const page = buildEntry(snapshot, 'chapter', '1', [{ number: 1, rounds: [] }], ROOT)
    expect(page?.title).toBe('第1章 裂缝')
    expect(page?.chip).toBe('已完成')
    expect(page?.subtitle).toBe('第1卷 雾里的货单 · 2140 字')
    expect(page?.fields.find((field) => field.label === '字数')?.value).toBe('2140 字')
    expect(page?.lists.map((list) => list.label)).toEqual(['出场人物（章纲）', '必写节拍', '章末钩子'])
  })

  it('counts drafts when nothing is committed yet', () => {
    const snapshot = book({ plans: [plan(2, { title: '过秤', approved: false })] })
    const page = buildEntry(snapshot, 'chapter', '2', [{ number: 2, rounds: [round(2, 900)] }], ROOT)
    expect(page?.chip).toBe('1 稿')
    expect(page?.fields.find((field) => field.label === '章纲')?.value).toBe('待批准')
    expect(page?.fields.find((field) => field.label === '字数')?.value).toBe('900 字（草稿）')
    // The newest draft's findings are the reason the writer is on round two.
    expect(page?.lists.find((list) => list.label === '最新一稿的自动发现')?.items).toEqual(['✗ 问题0', '✗ 问题1'])
  })

  it('returns undefined for a chapter that never existed', () => {
    const snapshot = book({ plans: [plan(1)], chapters: [written(1, '裂缝', 100)] })
    expect(buildEntry(snapshot, 'chapter', '9', [], ROOT)).toBeUndefined()
    expect(buildEntry(snapshot, 'chapter', '零', [], ROOT)).toBeUndefined()
  })
})

describe('editable projection', () => {
  it('gives a character page a breadcrumb and typed-in inputs', () => {
    const snapshot = book({ characters: [card('沈砚', 'protagonist', { voice: '短句', goal: '找到妹妹' })] })
    const page = buildEntry(snapshot, 'character', '沈砚', [], ROOT)
    expect(page?.breadcrumb).toEqual(['人物设计', '主角'])
    expect(page?.edit.inputs.map((input) => input.key)).toEqual(['role', 'voice', 'appearance', 'goal', 'secret', 'notes'])
    expect(page?.edit.inputs.find((input) => input.key === 'voice')?.value).toBe('短句')
    // Role is a choice, not free text: the host supplies the options.
    expect(page?.edit.inputs.find((input) => input.key === 'role')?.options?.length).toBeGreaterThan(0)
    expect(page?.edit.body).toBeUndefined()
  })

  it('gives a world page its kind and detail', () => {
    const snapshot = book({ world: [place('秤房', '势力', '只有一家还开着')] })
    const page = buildEntry(snapshot, 'world', '秤房', [], ROOT)
    expect(page?.breadcrumb).toEqual(['世界观', '势力'])
    expect(page?.edit.inputs.map((input) => input.key)).toEqual(['kind', 'detail'])
    expect(page?.edit.inputs.find((input) => input.key === 'detail')?.multiline).toBe(true)
  })

  it('hands the chapter body to the page when the caller passes it', () => {
    const snapshot = book({
      volumes: [volume(1, '雾里的货单')],
      plans: [plan(1, { title: '裂缝' })],
      chapters: [written(1, '裂缝', 10)],
    })
    const page = buildEntry(snapshot, 'chapter', '1', [{ number: 1, rounds: [] }], ROOT, '沈砚发现船底藏着尸体。\n')
    expect(page?.breadcrumb).toEqual(['正文', '第1卷'])
    expect(page?.edit.body?.key).toBe('text')
    expect(page?.edit.body?.value).toBe('沈砚发现船底藏着尸体。\n')
    expect(page?.edit.inputs[0]?.value).toBe('裂缝')
  })

  it('prefers the written chapter title over the outline title', () => {
    const snapshot = book({ plans: [plan(1, { title: '裂缝' })], chapters: [written(1, '改过的标题', 10)] })
    const page = buildEntry(snapshot, 'chapter', '1', [], ROOT)
    expect(page?.title).toBe('第1章 改过的标题')
    expect(page?.edit.inputs[0]?.value).toBe('改过的标题')
  })

  it('leaves the body empty for a chapter nobody has written yet', () => {
    const snapshot = book({ volumes: [volume(1, '雾里的货单')], plans: [plan(2, { title: '过秤' })] })
    const page = buildEntry(snapshot, 'chapter', '2', [], ROOT)
    expect(page?.edit.body?.value).toBe('')
    expect(page?.breadcrumb).toEqual(['正文', '第1卷'])
  })
})

describe('place page', () => {
  const dock: PlaceCard = {
    name: '雾港旧码头',
    aliases: ['旧码头'],
    kind: '地点',
    firstChapter: 1,
    latestChapter: 7,
    detail: '三层砖楼，楼梯窄得抬不进箱子',
    states: [
      { chapter: 1, detail: '三层砖楼，楼梯窄得抬不进箱子' },
      { chapter: 7, detail: '拆成一片大平层，旧楼梯没了', note: '沈砚认不出' },
    ],
    notes: '库房在西侧',
    updatedAt: '2026-10-25T00:00:00.000Z',
  }

  it('keeps every state the place went through, oldest first', () => {
    const page = buildEntry(book({ places: [dock] }), 'place', '雾港旧码头', [], ROOT)
    expect(page?.breadcrumb).toEqual(['剧情设计', '地点'])
    expect(page?.chip).toBe('2 次变化')
    expect(page?.fields.find((field) => field.label === '现在的样子')?.value).toBe('拆成一片大平层，旧楼梯没了')
    expect(page?.lists.find((list) => list.label === '样子变过几次')?.items).toEqual([
      '第1章：三层砖楼，楼梯窄得抬不进箱子',
      '第7章：拆成一片大平层，旧楼梯没了（沈砚认不出）',
    ])
  })

  it('offers the description and the note for editing, not the chapter numbers', () => {
    const page = buildEntry(book({ places: [dock] }), 'place', '雾港旧码头', [], ROOT)
    expect(page?.edit.inputs.map((input) => input.key)).toEqual(['detail', 'notes'])
  })

  it('returns undefined for a place that is gone', () => {
    expect(buildEntry(book(), 'place', '雾港旧码头', [], ROOT)).toBeUndefined()
  })
})

describe('story point page', () => {
  const point: StoryPoint = {
    id: 'sp-001',
    name: '翻身',
    startChapter: 1,
    endChapter: 2,
    premise: '王上从码头混进上势',
    characters: ['王上'],
    closed: true,
    createdAt: '2026-10-25T00:00:00.000Z',
  }

  it('names the range it covers and the cards inside it', () => {
    const snapshot = book({
      storyPoints: [point],
      plans: [plan(1, { title: '裂缝' }), plan(2, { title: '过秤' }), plan(3, { title: '别处' })],
    })
    const page = buildEntry(snapshot, 'story', 'sp-001', [], ROOT)
    expect(page?.subtitle).toBe('第1–2章 · 1 人')
    expect(page?.chip).toBe('已收尾')
    expect(page?.lists.find((list) => list.label === '覆盖 2 张章卡')?.items).toEqual(['第1章 裂缝', '第2章 过秤'])
  })

  it('shows the newest point as still running', () => {
    const running: StoryPoint = { ...point, id: 'sp-002', startChapter: 3, endChapter: null, closed: false }
    const page = buildEntry(book({ storyPoints: [running] }), 'story', 'sp-002', [], ROOT)
    expect(page?.subtitle).toBe('第3章起 · 1 人')
    expect(page?.chip).toBe('进行中')
  })
})

describe('timeline page', () => {
  it('reads the clock back as dates, not as the entries that were stored', () => {
    const snapshot = book({
      chapters: [written(1, '裂缝', 10)],
      timeline: {
        formatVersion: 1,
        anchors: [{ id: 'ta-001', chapter: 1, when: '2019-03', label: '开局' }],
        spans: [{ id: 'ts-001', fromChapter: 1, toChapter: 1, days: { min: 60, max: 90 }, text: '过了两三个月' }],
        recalls: [{ id: 'tr-001', chapter: 1, about: '那船货', eventChapter: null, claimed: '2019-01', text: '去年一月' }],
      },
    })
    const page = buildEntry(snapshot, 'timeline', 'clock', [], ROOT)
    expect(page?.breadcrumb).toEqual(['剧情设计', '时间线'])
    expect(page?.fields.find((field) => field.label === '起点')?.value).toBe('第1章是 2019-03（开局）')
    expect(page?.lists.find((list) => list.label === '按章对照')?.items[0]).toBe('第1章：2019-03-01 ~ 2019-03-31')
  })

  it('says so instead of guessing when the book never said when it is', () => {
    const page = buildEntry(book(), 'timeline', 'clock', [], ROOT)
    expect(page?.fields.find((field) => field.label === '现在')?.value).toBe('（算不出来，先记一个锚点）')
    expect(page?.chip).toBeUndefined()
  })

  it('is read-only: a date needs the sentence that asserted it', () => {
    expect(buildEntry(book(), 'timeline', 'clock', [], ROOT)?.edit.inputs).toEqual([])
  })
})

describe('buildEntry', () => {
  it('treats an empty key as gone rather than as a match', () => {
    expect(buildEntry(book({ characters: [card('', 'minor')] }), 'character', '', [], ROOT)).toBeUndefined()
  })
})
