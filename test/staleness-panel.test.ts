/**
 * The page says when its own record is out of date.
 *
 * A check the author never runs is a check that does not exist. The panel is
 * where a place or a person is looked at, so that is where "this line was read
 * off a draft you have since rewritten" has to appear.
 */
import { expect, it } from 'vitest'
import { buildEntry } from '../src/panel/entry.ts'
import type { CharacterCard, ChapterMeta, PlaceCard, Snapshot } from '../src/domain/types.ts'

/** A book with one rewritten chapter and two records that predate the rewrite. */
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
    characters: [character()],
    world: [],
    places: [place()],
    storyPoints: [],
    timeline: { formatVersion: 1, anchors: [], spans: [], recalls: [] },
    relations: { formatVersion: 1, edges: [] },
    volumes: [],
    plans: [],
    ledger: [],
    chapters: [meta()],
  }
}

function meta(): ChapterMeta {
  return { number: 3, title: '第3章', words: 2000, summary: '', writtenAt: 'now', revision: 2 }
}

function character(): CharacterCard {
  return {
    name: '沈砚',
    role: 'protagonist',
    voice: '短句',
    appearance: '旧长衫',
    goal: '查清那批货',
    secret: '放行单是他签的',
    personality: '开始替人圆谎',
    updatedAt: 'now',
    stages: [{ label: '第3章 · 开始替人圆谎', text: '原来是认死理。', chapter: 3, cause: '他把阿鸢送走以后', revision: 1 }],
  }
}

function place(): PlaceCard {
  return {
    name: '码头',
    aliases: [],
    kind: '街区',
    firstChapter: 3,
    latestChapter: 3,
    detail: '一片漆黑',
    states: [{ chapter: 3, detail: '湿的，灯一直亮着', revision: 1 }],
    updatedAt: 'now',
  }
}

it('marks a character stage that predates the rewrite', () => {
  const page = buildEntry(book(), 'character', '沈砚', [], '/tmp/book')
  const list = page?.lists.find((item) => item.label === '记录过期')
  expect(list).toBeDefined()
  expect(list?.items[0]).toContain('第 1 版')
  expect(list?.items[0]).toContain('第 2 版')
})

it('marks a place state that predates the rewrite', () => {
  const page = buildEntry(book(), 'place', '码头', [], '/tmp/book')
  const list = page?.lists.find((item) => item.label === '记录过期')
  expect(list).toBeDefined()
  expect(list?.items[0]).toContain('码头')
})

it('says nothing when the records are current', () => {
  const snapshot = book()
  snapshot.characters[0]!.stages = [{ label: '第3章 · 开始替人圆谎', text: 'x', chapter: 3, revision: 2 }]
  snapshot.places[0]!.states = [{ chapter: 3, detail: '一片漆黑', revision: 2 }]
  const page = buildEntry(snapshot, 'character', '沈砚', [], '/tmp/book')
  expect(page?.lists.some((item) => item.label === '记录过期')).toBe(false)
})
