import { expect, it } from 'vitest'
import { staleRecords } from '../src/domain/staleness.ts'
import type { CharacterCard, ChapterMeta, ChapterPlan, PlaceCard, Snapshot } from '../src/domain/types.ts'

/** A book with three chapters, so a rewrite can be described per chapter. */
function book(): Snapshot {
  return {
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
    relations: { formatVersion: 1, edges: [] },
    volumes: [],
    plans: [],
    ledger: [],
    chapters: [],
  }
}

function meta(number: number, revision = 1): ChapterMeta {
  return { number, title: `第${number}章`, words: 2000, summary: '', writtenAt: 'now', revision }
}

function plan(number: number, cardRevision?: number): ChapterPlan {
  return {
    number,
    title: `第${number}章`,
    pov: '',
    characters: [],
    beats: ['一', '二'],
    hooks: [],
    approved: true,
    volume: 1,
    ...(cardRevision === undefined ? {} : { cardRevision }),
  }
}

function place(states: PlaceCard['states']): PlaceCard {
  return {
    name: '码头',
    aliases: [],
    kind: '街区',
    firstChapter: 1,
    latestChapter: 3,
    detail: '湿的',
    states,
    updatedAt: 'now',
  }
}

/** One character with a stage, so the stage branch has something to compare. */
function character(stages: CharacterCard['stages']): CharacterCard {
  return {
    name: '沈砚',
    role: 'protagonist',
    voice: '短句',
    appearance: '旧长衫',
    goal: '查清那批货',
    secret: '放行单是他签的',
    updatedAt: 'now',
    stages,
  }
}

it('says nothing when no chapter has been rewritten', () => {
  const snapshot = book()
  snapshot.chapters = [meta(1), meta(2)]
  snapshot.plans = [plan(1, 1), plan(2, 1)]
  snapshot.places = [place([{ chapter: 1, detail: '湿的', revision: 1 }])]
  snapshot.characters = [character([{ label: '第1章', text: 'x', chapter: 1, revision: 1 }])]
  expect(staleRecords(snapshot).records).toEqual([])
})

it('reports a card, a place state and a stage that were read off an older draft', () => {
  const snapshot = book()
  snapshot.chapters = [meta(1, 3), meta(2, 1)]
  snapshot.plans = [plan(1, 2)]
  snapshot.places = [place([{ chapter: 1, detail: '早就拆了', revision: 1 }])]
  snapshot.characters = [character([{ label: '第1章 · 变了', text: 'x', chapter: 1, cause: '因为', revision: 2 }])]

  const stale = staleRecords(snapshot)
  expect(stale.records.map((record) => record.kind)).toEqual(['card', 'place', 'stage'])
  expect(stale.records[0]).toMatchObject({ chapter: 1, recorded: 2, current: 3 })
  expect(stale.records[1]?.label).toContain('码头')
  expect(stale.chapters).toEqual([1])
})

it('treats an unstamped record as version one, so an untouched chapter stays quiet', () => {
  const snapshot = book()
  snapshot.chapters = [meta(1, 1), meta(2, 1)]
  snapshot.places = [place([{ chapter: 1, detail: '湿的' }, { chapter: 2, detail: '干的' }])]
  const stale = staleRecords(snapshot)
  expect(stale.records).toEqual([])
})

it('reads an unstamped record as version one, so a rewrite does get reported', () => {
  const snapshot = book()
  snapshot.chapters = [meta(2, 2)]
  snapshot.places = [place([{ chapter: 2, detail: '干的' }])]
  const stale = staleRecords(snapshot)
  expect(stale.records).toHaveLength(1)
  expect(stale.records[0]).toMatchObject({ kind: 'place', recorded: 1, current: 2 })
})

it('ignores records about chapters that were never written', () => {
  const snapshot = book()
  snapshot.chapters = []
  snapshot.plans = [plan(1, 1), plan(2, 1)]
  snapshot.places = [place([{ chapter: 2, detail: '还没写', revision: 1 }])]
  expect(staleRecords(snapshot).records).toEqual([])
})
