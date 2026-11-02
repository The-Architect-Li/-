/**
 * One command, and why that one.
 *
 * A preset can tell a model what this tool is for; it cannot tell it that chapter
 * eight has a card, no prose, and an approved outline. That is state, and state is
 * what this answers — with the chapter number already filled in, because a
 * suggestion the author has to edit before running is a suggestion they skip.
 */
import { describe, expect, it } from 'vitest'
import { nextStep } from '../src/domain/next.ts'
import type { ChapterMeta, ChapterPlan, Snapshot } from '../src/domain/types.ts'

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    project: {
      formatVersion: 1,
      title: '雾港',
      phase: 'drafting',
      premise: '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。',
      targetWords: 800000,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    characters: [{ name: '沈砚', role: 'protagonist', voice: '', appearance: '', goal: '', secret: '', updatedAt: '2026-01-01T00:00:00.000Z' }],
    world: [{ name: '雾港', kind: '地点', detail: '', updatedAt: '2026-01-01T00:00:00.000Z' }],
    places: [],
    storyPoints: [],
    timeline: { start: '', anchors: [], spans: [] },
    relations: { edges: [] },
    volumes: [{ number: 1, title: '入港', summary: '', approved: true }],
    plans: [],
    ledger: [],
    chapters: [],
    ...over,
  } as Snapshot
}

function plan(number: number, approved = true): ChapterPlan {
  return { number, volume: 1, title: `第${number}章`, pov: '', characters: [], beats: ['a'], hooks: ['h'], approved }
}

function chapter(number: number): ChapterMeta {
  return { number, title: `第${number}章`, words: 3000, summary: '', writtenAt: '2026-01-01T00:00:00.000Z', revision: 1 }
}

describe('nextStep', () => {
  it('asks for a premise before anything else, on an empty book', () => {
    const step = nextStep(snapshot({ project: { ...snapshot().project, premise: '', phase: 'premise' } }))
    expect(step.command).toContain('novel_project action="premise"')
    expect(step.why).toContain('还没有前提')
  })

  it('does not lecture a writer who already has half a million words', () => {
    // Importing gives you 521 chapters and an empty premise line. 「还没有前提」
    // would read like a misfiled complaint; the sentence says what the line is for.
    const step = nextStep(
      snapshot({
        project: { ...snapshot().project, premise: '', phase: 'drafting' },
        chapters: [chapter(1), chapter(2)],
      }),
    )
    expect(step.why).toContain('已经有 2 章正文')
    expect(step.why).toContain('上下文包')
  })

  it('asks for a character card when the canon is empty', () => {
    const step = nextStep(snapshot({ project: { ...snapshot().project, phase: 'canon' }, characters: [] }))
    expect(step.command).toContain('novel_canon action="upsert_character"')
    expect(step.why).toContain('角色')
  })

  it('points at the first chapter with a card and no prose', () => {
    const step = nextStep(snapshot({ plans: [plan(7), plan(8)], chapters: [chapter(7)] }))
    expect(step.command).toBe('novel_dispatch action="round" number=8')
    expect(step.why).toContain('第8章')
  })

  it('asks for the approval when the card exists but is not approved', () => {
    const step = nextStep(snapshot({ plans: [plan(3, false)] }))
    expect(step.command).toContain('approve_chapter')
    expect(step.command).toContain('number=3')
  })

  it('puts the review queue first when there is anything in it', () => {
    // Proposals already read are cheaper to file than the next chapter is to
    // write, and leaving them sitting is how the records end up empty.
    const step = nextStep(snapshot({ plans: [plan(9)], chapters: [chapter(8)] }), [
      { id: 'p-0001', kind: 'ledger', subject: '沈砚', key: '左手', value: '有伤', chapter: 8, quote: '', at: '', sourceChapter: 8, role: 'keeper' },
    ])
    expect(step.command).toContain('novel_pending action="approve"')
    expect(step.why).toContain('1 条')
  })

  it('notices prose without cards, which is what an import looks like', () => {
    const step = nextStep(snapshot({ plans: [], chapters: [chapter(1), chapter(2), chapter(3)] }))
    expect(step.command).toContain('novel_archive action="plan"')
    expect(step.why).toContain('3 章')
  })

  it('proposes the next chapter number when everything is caught up', () => {
    const step = nextStep(snapshot({ plans: [plan(1)], chapters: [chapter(1)] }))
    expect(step.command).toContain('number=2')
    expect(step.why).toContain('第1章')
  })
})
