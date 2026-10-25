import { describe, expect, it } from 'vitest'
import { buildReviewWindow, cardIsStale, describeRange, REVIEW_WINDOW_DEFAULTS } from '../src/domain/review-window.ts'
import { renderReviewWindow } from '../src/roles.ts'
import type { ChapterDraft, ChapterMeta, ChapterPlan, Snapshot } from '../src/domain/types.ts'

const EMPTY: Snapshot = {
  project: {
    formatVersion: 1,
    title: '测试书',
    premise: '一个够长的前提'.repeat(20),
    targetWords: 800_000,
    phase: 'drafting',
    roles: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  characters: [],
  world: [],
  places: [],
  storyPoints: [],
  timeline: { formatVersion: 1, anchors: [], spans: [], recalls: [] },
  volumes: [],
  plans: [],
  ledger: [],
  chapters: [],
}

function meta(number: number, revision = 1): ChapterMeta {
  return { number, title: `第${number}章`, words: 2000, summary: `第${number}章的末段`, writtenAt: 'now', revision }
}

function draft(number: number, text = '正文'.repeat(500)): ChapterDraft {
  return { number, title: `第${number}章`, words: 1000, summary: '', writtenAt: 'now', revision: 1, text }
}

function plan(number: number, summary?: string, cardRevision?: number): ChapterPlan {
  return {
    number,
    title: `第${number}章`,
    volume: 1,
    pov: '',
    characters: [],
    beats: [],
    hooks: [],
    approved: true,
    ...(summary === undefined ? {} : { summary }),
    ...(cardRevision === undefined ? {} : { cardRevision }),
  }
}

describe('buildReviewWindow', () => {
  it('reads the last three chapters in full and the seven before them as recaps', () => {
    const drafts = Array.from({ length: 12 }, (_, index) => draft(index + 1))
    const snapshot: Snapshot = {
      ...EMPTY,
      chapters: drafts.map((item) => meta(item.number)),
      plans: [2, 3, 4, 5, 6, 7, 8, 9].map((number) => plan(number, `第${number}章讲了什么`)),
    }
    const window = buildReviewWindow(snapshot, drafts, 13, { full: 3, recap: 7, budget: 100_000 })
    expect(window.full.map((item) => item.number)).toEqual([10, 11, 12])
    expect(window.recaps.map((item) => item.number)).toEqual([3, 4, 5, 6, 7, 8, 9])
    // Chapters 1 and 2 fall outside both counts and are reported as omitted.
    expect(window.omitted).toBe(2)
    expect(window.report).toContain('正文 第10–12章')
    expect(window.report).toContain('梗概 第3–9章')
    expect(window.report).toContain('更早 2 章未读')
  })

  it('demotes a chapter to its recap instead of dropping it when the budget is tight', () => {
    const drafts = Array.from({ length: 5 }, (_, index) => draft(index + 1, '字'.repeat(4000)))
    const snapshot: Snapshot = {
      ...EMPTY,
      chapters: drafts.map((item) => meta(item.number)),
      plans: drafts.map((item) => plan(item.number, `第${item.number}章的梗概`)),
    }
    const window = buildReviewWindow(snapshot, drafts, 6, { full: 3, recap: 0, budget: 9000 })
    // Two chapters fit the budget, and it is the oldest of the three that is
    // demoted — the chapter right before the one under review is the important one.
    expect(window.full.map((item) => item.number)).toEqual([4, 5])
    expect(window.recaps.map((item) => item.number)).toEqual([3])
    expect(window.report).toContain('超预算转梗概 第3章')
  })

  it('marks a recap stale when the prose moved past the card', () => {
    const drafts = [draft(1), draft(2), draft(3), draft(4)]
    const snapshot: Snapshot = {
      ...EMPTY,
      chapters: [meta(1, 3), meta(2, 1), meta(3, 1), meta(4, 1)],
      plans: [plan(1, '改之前的故事', 1), plan(2, '第2章的故事', 1)],
    }
    const window = buildReviewWindow(snapshot, drafts, 5, { full: 2, recap: 2, budget: 100_000 })
    // Chapter 1 was rewritten (revision 3) after its card was stamped 1.
    expect(window.recaps.find((item) => item.number === 1)?.stale).toBe(true)
    expect(window.recaps.find((item) => item.number === 2)?.stale).toBe(false)
    expect(window.report).toContain('其中 1 条梗概已过期')
  })

  it('falls back to the prose tail when a chapter has no card, and says so', () => {
    const drafts = [draft(1), draft(2), draft(3)]
    const snapshot: Snapshot = { ...EMPTY, chapters: drafts.map((item) => meta(item.number)), plans: [] }
    const window = buildReviewWindow(snapshot, drafts, 4, { full: 1, recap: 3, budget: 100_000 })
    expect(window.recaps.map((item) => item.source)).toEqual(['tail', 'tail'])
    expect(window.recaps[0]?.summary).toBe('第1章的末段')
  })

  it('has no window for the first chapter', () => {
    const window = buildReviewWindow(EMPTY, [], 1)
    expect(window.full).toEqual([])
    expect(window.recaps).toEqual([])
    expect(window.omitted).toBe(0)
    expect(window.report).toContain('没有可读的近期正文')
  })

  it('defaults to three in full and seven as recaps', () => {
    expect(REVIEW_WINDOW_DEFAULTS).toEqual({ full: 3, recap: 7, budget: 12_000 })
  })
})

describe('renderReviewWindow', () => {
  it('quotes the recent chapters, recaps the older ones, and labels a stale recap', () => {
    const sections = renderReviewWindow({
      full: [{ number: 84, title: '收网', words: 2200, text: '沈砚把伞收在门外。' }],
      recaps: [
        { number: 83, title: '旧账', summary: '账房先生交出了账本', stale: true, source: 'card' },
        { number: 82, title: '码头', summary: '第三号仓空着', stale: false, source: 'tail' },
      ],
      omitted: 81,
      chars: 2400,
      report: '',
    })
    const text = sections.join('\n')
    expect(text).toContain('## 前面几章的正文')
    expect(text).toContain('### 第84章　收网（2200 字）')
    expect(text).toContain('沈砚把伞收在门外。')
    expect(text).toContain('## 更早几章的梗概')
    expect(text).toContain('第83章　旧账：账房先生交出了账本　⚠ 正文改过，这条梗概可能过期')
    // A tail-derived line is not a human recap and is marked as such.
    expect(text).toContain('（取自正文末尾，不是人写的梗概）')
    expect(text).toContain('更早的 81 章不在这次审稿范围内')
  })

  it('says nothing when there is no history', () => {
    expect(renderReviewWindow({ full: [], recaps: [], omitted: 0, chars: 0, report: '' })).toEqual([])
  })
})

describe('describeRange', () => {
  it('collapses runs and keeps gaps apart', () => {
    expect(describeRange([1, 2, 3, 7, 9, 10, 11])).toBe('第1–3章、第7章、第9–11章')
    expect(describeRange([])).toBe('')
  })
})

describe('cardIsStale', () => {
  it('compares the two revision numbers', () => {
    expect(cardIsStale(plan(1, 'x', 2), meta(1, 2))).toBe(false)
    expect(cardIsStale(plan(1, 'x', 1), meta(1, 2))).toBe(true)
    // A card with no stamp predates versioning: it only counts as stale once the
    // prose has moved past revision 1.
    expect(cardIsStale(plan(1, 'x'), meta(1, 1))).toBe(false)
    expect(cardIsStale(plan(1, 'x'), meta(1, 4))).toBe(true)
    // No prose, no staleness.
    expect(cardIsStale(plan(1, 'x', 1), undefined)).toBe(false)
    expect(cardIsStale(undefined, meta(1, 2))).toBe(false)
  })
})
