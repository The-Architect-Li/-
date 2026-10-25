/**
 * The rail: year points from a start date, events hanging off them.
 *
 * The point of these tests is not that the arithmetic is arithmetic — it is that
 * the rail never invents a date, never drops an event for being awkward, and
 * always says what it left out.
 */
import { describe, expect, it } from 'vitest'
import { addMonths, buildSpine, whenLabel } from '../src/domain/spine.ts'
import type { ChapterMeta, ChapterPlan, ProjectFile, Snapshot, TimelineFile } from '../src/domain/types.ts'
import { emptyRelations } from '../src/domain/relations.ts'

const NOW = '2026-10-25T00:00:00.000Z'

function project(overrides: Partial<ProjectFile> = {}): ProjectFile {
  return {
    formatVersion: 1,
    title: '雨书',
    phase: 'drafting',
    premise: '',
    targetWords: 800_000,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function chapter(number: number, title: string, words = 100): ChapterMeta {
  return { number, title, words, summary: '', writtenAt: NOW, revision: 1 }
}

function plan(number: number, title: string, overrides: Partial<ChapterPlan> = {}): ChapterPlan {
  return {
    number,
    title,
    volume: 1,
    pov: '',
    characters: [],
    beats: [],
    hooks: [],
    approved: true,
    ...overrides,
  }
}

function book(overrides: Partial<Snapshot> = {}): Snapshot {
  const timeline: TimelineFile = { formatVersion: 1, anchors: [], spans: [], recalls: [] }
  return {
    project: project(),
    characters: [],
    world: [],
    places: [],
    storyPoints: [],
    volumes: [],
    plans: [],
    chapters: [],
    ledger: [],
    timeline,
    relations: emptyRelations(),
    ...overrides,
  }
}

describe('addMonths', () => {
  it('keeps the day of the month, because a book counts anniversaries not fiscal years', () => {
    const october14 = Math.floor(Date.UTC(2020, 9, 14) / 86_400_000)
    expect(whenLabel(addMonths(october14, 12))).toBe('2021-10')
    expect(whenLabel(addMonths(october14, 12), true)).toBe('2021-10-14')
  })

  it('clamps the 31st to the shorter month rather than rolling into the next one', () => {
    const january31 = Math.floor(Date.UTC(2021, 0, 31) / 86_400_000)
    expect(whenLabel(addMonths(january31, 1), true)).toBe('2021-02-28')
  })
})

describe('buildSpine', () => {
  it('puts a point every twelve months from the pinned start, and hangs chapters off them', () => {
    const spine = buildSpine(book({
      project: project({ bookStart: '2020-10' }),
      chapters: [chapter(1, '裂缝'), chapter(2, '金童玉女'), chapter(3, '火种')],
      plans: [plan(1, '裂缝', { summary: '雨夜发现尸体' }), plan(2, '金童玉女'), plan(3, '火种')],
      timeline: {
        formatVersion: 1,
        anchors: [
          { id: 'ta-001', chapter: 1, when: '2020-10', label: '开局' },
          { id: 'ta-002', chapter: 3, when: '2022-04', label: '' },
        ],
        spans: [],
        recalls: [],
      },
    }))
    expect(spine.nodes.map((node) => node.label)).toEqual(['2020-10', '2021-10', '2022-10'])
    expect(spine.nodes[0]!.kind).toBe('start')
    expect(spine.nodes[1]!.kind).toBe('year')
    expect(spine.loose).toHaveLength(0)
    // Chapters 1 and 2 both sit on the chapter-1 anchor: no span moved the clock
    // between them, so they belong to the same year, not to two.
    const firstYear = spine.events.filter((event) => event.node === 0)
    // One bubble per chapter: the card is the text, the anchor's words are the note.
    expect(firstYear.map((event) => event.label)).toEqual(['第1章 裂缝', '第2章 金童玉女'])
    expect(firstYear[0]!.note).toBe('开局')
    expect(firstYear[0]!.text).toBe('雨夜发现尸体')
    const third = spine.events.find((event) => event.chapter === 3)
    // 2022-04 falls between the 2021-10 and 2022-10 points: the second bucket.
    expect(third?.node).toBe(1)
    expect(third?.at).toBeGreaterThan(spine.nodes[0]!.at)
    expect(spine.report).toContain('起点 2020-10')
  })

  it('falls back to the first anchor when the book never pinned a start', () => {
    const spine = buildSpine(book({
      chapters: [chapter(1, '裂缝')],
      plans: [plan(1, '裂缝')],
      timeline: {
        formatVersion: 1,
        anchors: [{ id: 'ta-001', chapter: 1, when: '2031-05', label: '' }],
        spans: [],
        recalls: [],
      },
    }))
    expect(spine.nodes[0]!.label).toBe('2031-05')
  })

  it('lists chapters the clock has not reached instead of dropping them', () => {
    const spine = buildSpine(book({
      project: project({ bookStart: '2020-10' }),
      chapters: [chapter(1, '裂缝'), chapter(2, '金童玉女')],
      plans: [plan(1, '裂缝'), plan(2, '金童玉女')],
      timeline: {
        formatVersion: 1,
        anchors: [{ id: 'ta-001', chapter: 2, when: '2020-11', label: '' }],
        spans: [],
        recalls: [],
      },
    }))
    // Chapter 1 is before the first known date, so it has no window.
    expect(spine.loose.map((event) => event.label)).toEqual(['第1章 裂缝'])
    expect(spine.report).toContain('1 章还没有日期')
  })

  it('says what is missing instead of drawing an empty rail', () => {
    const spine = buildSpine(book({ chapters: [chapter(1, '裂缝')], plans: [plan(1, '裂缝')] }))
    expect(spine.nodes).toHaveLength(0)
    expect(spine.report).toContain('还没有任何日期')
    expect(spine.loose.map((event) => event.label)).toEqual(['第1章 裂缝'])
  })

  it('drops an anchor that only repeats what its chapter card already says', () => {
    const spine = buildSpine(book({
      project: project({ bookStart: '2020-10' }),
      chapters: [chapter(1, '裂缝')],
      plans: [plan(1, '裂缝', { summary: '雨夜在码头发现一具尸体' })],
      timeline: {
        formatVersion: 1,
        anchors: [{ id: 'ta-001', chapter: 1, when: '2020-10', label: '雨夜在码头发现一具尸体' }],
        spans: [],
        recalls: [],
      },
    }))
    expect(spine.events.filter((event) => event.kind === 'anchor')).toHaveLength(0)
    expect(spine.events.some((event) => event.kind === 'chapter')).toBe(true)
  })

  it('runs longest-first: a chapter with a span is dated before its own anchor', () => {
    const spine = buildSpine(book({
      project: project({ bookStart: '2020-01' }),
      chapters: [chapter(1, '裂缝'), chapter(2, '金童玉女'), chapter(3, '火种')],
      plans: [plan(1, '裂缝'), plan(2, '金童玉女'), plan(3, '火种')],
      timeline: {
        formatVersion: 1,
        anchors: [{ id: 'ta-001', chapter: 1, when: '2020-01', label: '' }],
        spans: [{ id: 'ts-001', fromChapter: 1, toChapter: 2, days: { min: 60, max: 90 }, text: '过了两三个月' }],
        recalls: [],
      },
    }))
    const ordered = [...spine.events].sort((left, right) => left.at - right.at)
    expect(ordered[0]!.chapter).toBe(1)
    expect(ordered[1]!.chapter).toBe(2)
    expect(ordered[2]!.chapter).toBe(3)
  })

  it('stops adding points at the ceiling so a forty-year book cannot draw a thousand', () => {
    const spine = buildSpine(book({
      project: project({ bookStart: '2000-01' }),
      chapters: [chapter(1, '裂缝')],
      plans: [plan(1, '裂缝')],
      timeline: {
        formatVersion: 1,
        anchors: [{ id: 'ta-001', chapter: 1, when: '2039-01', label: '' }],
        spans: [],
        recalls: [],
      },
    }), { maxNodes: 5 })
    expect(spine.nodes).toHaveLength(5)
  })
})
