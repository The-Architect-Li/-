/**
 * Relations as edges: both pages read one record, and either can fix it.
 *
 * The bug this file exists for: v0.19 stored a relation on one card, so the other
 * person's page could only show it read-only as 「别人写的」. A book where 王上 is
 * 刘紫灵's son could be described from one end only.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { updateCharacter } from '../src/domain/characters.ts'
import {
  checkRelations,
  describeRelation,
  looksSymmetric,
  migrateRelations,
  nameTokens,
  normaliseRelations,
  relationsOf,
  relationId,
  removeRelation,
  sameName,
  seenFrom,
  upsertRelation,
} from '../src/domain/relations.ts'
import { ProjectStore } from '../src/domain/store.ts'
import { buildEntry } from '../src/panel/entry.ts'
import type { CharacterCard, Snapshot } from '../src/domain/types.ts'
import { createHarness, valueOf } from './helpers.ts'

const card = (name: string, extra: Partial<CharacterCard> = {}): CharacterCard => ({
  name,
  role: 'supporting',
  voice: '',
  appearance: '',
  goal: '',
  secret: '',
  updatedAt: 'now',
  ...extra,
})

describe('the table', () => {
  it('gives one pair one id, whichever end is named first', () => {
    expect(relationId('王上', '刘紫灵')).toBe(relationId('刘紫灵', '王上'))
    expect(relationId('王上', '刘紫灵')).not.toBe(relationId('王上', '薛梦静'))
  })

  it('drops half-written edges instead of throwing on them', () => {
    const file = normaliseRelations({
      formatVersion: 1,
      edges: [
        { id: '', from: '王上', to: '刘紫灵', kind: '母亲', symmetric: false },
        { id: '', from: '王上', to: '', kind: '母亲', symmetric: false },
        { id: '', from: '王上', to: '王上', kind: '自己的', symmetric: false },
        { id: '', from: '王上', to: '刘紫灵', kind: '母亲', symmetric: false },
      ],
    })
    expect(file.edges).toHaveLength(1)
    expect(file.edges[0]!.to).toBe('刘紫灵')
  })

  it('treats the common words as symmetric unless told otherwise', () => {
    expect(looksSymmetric('夫妻')).toBe(true)
    expect(looksSymmetric('师徒')).toBe(false)
    expect(looksSymmetric('对手')).toBe(true)
  })
})

describe('migration', () => {
  it('folds a v0.19 card into edges once, and only once', () => {
    const cards = [card('王上', { relations: [{ name: '刘紫灵', kind: '母子，但彼此不认' }] })]
    const first = migrateRelations(undefined, cards)
    expect(first.changed).toBe(true)
    expect(first.file.migrated).toBe(true)
    expect(first.file.edges).toHaveLength(1)
    expect(first.file.edges[0]).toMatchObject({ from: '王上', to: '刘紫灵', kind: '母子，但彼此不认' })

    // The second read must not re-add what the author may have deleted since.
    const second = migrateRelations(first.file, cards)
    expect(second.changed).toBe(false)
    expect(second.file.edges).toHaveLength(1)
  })

  it('keeps a table that already has edges, even when the cards say otherwise', () => {
    const cards = [card('王上', { relations: [{ name: '刘紫灵', kind: '旧的' }] })]
    const existing = { formatVersion: 1 as const, edges: [{ id: relationId('王上', '阿鸢'), from: '王上', to: '阿鸢', kind: '新的', symmetric: false }] }
    const result = migrateRelations(existing, cards)
    expect(result.changed).toBe(false)
    expect(result.file.edges[0]!.to).toBe('阿鸢')
  })
})

describe('both pages', () => {
  const edge = { id: relationId('王上', '刘紫灵'), from: '王上', to: '刘紫灵', kind: '母亲', symmetric: false }
  const file = { formatVersion: 1 as const, edges: [edge] }

  it('shows the same record from either end, with each page’s own word', () => {
    expect(seenFrom(edge, '王上')).toMatchObject({ other: '刘紫灵', kind: '母亲' })
    // 刘紫灵's page has no word of its own yet, so it repeats the one that was stated
    // rather than inventing 「儿子」.
    expect(seenFrom(edge, '刘紫灵')).toMatchObject({ other: '王上', kind: '母亲' })

    const withReverse = { ...edge, reverse: '儿子' }
    expect(seenFrom(withReverse, '刘紫灵')).toMatchObject({ other: '王上', kind: '儿子' })
    expect(describeRelation(seenFrom(withReverse, '刘紫灵'))).toBe('王上 —— 儿子')
  })

  it('reads one edge on both cards, including through an alias', () => {
    const cards = [card('王上'), card('刘紫灵（网名刘格格）', { aliases: ['刘格格', '格格'] })]
    const table = { formatVersion: 1 as const, edges: [edge] }
    // The other side is shown as the card's own name, so one person cannot show up
    // twice under two spellings on one page.
    expect(relationsOf(table, cards, '王上').map((item) => item.other)).toEqual(['刘紫灵（网名刘格格）'])
    // A line written under the nickname still lands on the card that owns it.
    const named = { formatVersion: 1 as const, edges: [upsertRelation({ formatVersion: 1, edges: [] }, { from: '王上', to: '格格', kind: '压着的人' }).edges[0]!] }
    expect(relationsOf(named, cards, cards[1]!.name).map((item) => item.other)).toEqual(['王上'])
  })

  it('removes only the id it is given', () => {
    const two = upsertRelation(upsertRelation({ formatVersion: 1, edges: [] }, { from: '王上', to: '刘紫灵', kind: '母亲' }), {
      from: '王上',
      to: '阿鸢',
      kind: '债主',
    })
    const left = removeRelation(two, relationId('王上', '刘紫灵'))
    expect(left.edges.map((item) => item.to)).toEqual(['阿鸢'])
  })
})

describe('checking the table', () => {
  it('reports a name that answers to no card as information, not an error', () => {
    const file = upsertRelation({ formatVersion: 1, edges: [] }, { from: '王上', to: '还没登场的人', kind: '债主' })
    const findings = checkRelations(file, [card('王上')])
    expect(findings.map((item) => item.code)).toEqual(['relations/unknown-person'])
    expect(findings[0]!.severity).toBe('info')
  })

  it('refuses a symmetric edge that carries two different words', () => {
    const file = normaliseRelations({
      formatVersion: 1,
      edges: [{ id: '', from: '王上', to: '刘紫灵', kind: '夫妻', reverse: '债主', symmetric: true }],
    })
    const findings = checkRelations(file, [card('王上'), card('刘紫灵')])
    expect(findings.map((item) => item.code)).toEqual(['relations/contradiction'])
    expect(findings[0]!.severity).toBe('error')
  })
})

describe('editing from the far page', () => {
  const roots: string[] = []
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  it('writes the reverse word instead of flipping who said what', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkwell-rel-'))
    roots.push(root)
    const store = new ProjectStore(root)
    await store.writeProject({
      formatVersion: 1,
      title: '雾港',
      phase: 'drafting',
      premise: '',
      targetWords: 1000,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await updateCharacter(store, '王上', { relations: [{ name: '刘紫灵', kind: '母亲' }] })
    await updateCharacter(store, '刘紫灵', { relations: [{ name: '王上', kind: '儿子' }] })

    const table = await store.relations()
    expect(table.edges).toHaveLength(1)
    expect(table.edges[0]).toMatchObject({ from: '王上', to: '刘紫灵', kind: '母亲', reverse: '儿子' })

    // The file on disk is the record, not the cards: a card written before v0.21
    // must still read, and the cards must not carry a stale copy.
    const stored = JSON.parse(await readFile(join(root, 'canon', 'relations.json'), 'utf8')) as typeof table
    expect(stored.edges).toHaveLength(1)
    expect((await store.characters()).every((item) => item.relations === undefined)).toBe(true)
  })

  it('drops the edge when the line is deleted, and leaves the other page alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkwell-rel-'))
    roots.push(root)
    const store = new ProjectStore(root)
    await store.writeProject({
      formatVersion: 1,
      title: '雾港',
      phase: 'drafting',
      premise: '',
      targetWords: 1000,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await updateCharacter(store, '王上', { relations: [{ name: '刘紫灵', kind: '母亲' }] })
    await updateCharacter(store, '刘紫灵', { relations: [{ name: '王上', kind: '儿子' }] })
    // 刘紫灵 clears her line; the edge belonged to 王上, so it must survive.
    await updateCharacter(store, '刘紫灵', { relations: [] })
    expect((await store.relations()).edges).toHaveLength(1)
    // 王上 clears his: now nobody claims it.
    await updateCharacter(store, '王上', { relations: [] })
    expect((await store.relations()).edges).toHaveLength(0)
  })
})

describe('the page and the tool', () => {
  it('lists both directions once each, and names nobody it cannot find', () => {
    const snapshot = {
      project: {
        formatVersion: 1,
        title: '雾港',
        phase: 'drafting',
        premise: '',
        targetWords: 1000,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      characters: [card('王上'), card('刘紫灵')],
      world: [],
      places: [],
      storyPoints: [],
      timeline: { formatVersion: 1, anchors: [], spans: [] },
      relations: upsertRelation(
        upsertRelation({ formatVersion: 1, edges: [] }, { from: '王上', to: '刘紫灵', kind: '夫妻', symmetric: true }),
        { from: '刘紫灵', to: '外人', kind: '债主' },
      ),
      volumes: [],
      plans: [],
      ledger: [],
      chapters: [],
    } as Snapshot
    const page = buildEntry(snapshot, 'relations', 'relations', [], '/nowhere')
    const lists = page?.lists ?? []
    expect(lists.find((list) => list.label.includes('双向'))?.items).toEqual(['王上 —— 夫妻 —— 刘紫灵'])
    expect(lists.find((list) => list.label.includes('单向'))?.items).toEqual([
      '刘紫灵 —— 债主 → 外人（角色卡里还没有：外人）',
    ])
  })

  it('answers novel_check with the count when nothing is wrong', async () => {
    const harness = await createHarness()
    try {
      await harness.call('novel_project', { action: 'init', title: '雾港', targetWords: 800_000 })
      await harness.call('novel_canon', { action: 'upsert_character', name: '王上', voice: '短句' })
      await harness.call('novel_canon', { action: 'upsert_character', name: '刘紫灵', voice: '慢' })
      await harness.call('novel_canon', {
        action: 'upsert_character',
        name: '王上',
        relations: ['刘紫灵：母亲'],
      })
      const result = await harness.call('novel_check', { action: 'relations' })
      const value = valueOf<{ report: string }>(result)
      expect(value.report).toContain('关系表没有冲突：1 条关系')
    } finally {
      await harness.cleanup()
    }
  })
})

describe('matching a name through its brackets', () => {
  it('splits the spelling a novel uses into the pieces worth comparing', () => {
    expect(nameTokens('刘紫灵（网名刘格格，正文里直接叫「格格」）')).toEqual([
      '正文里直接叫',
      '网名刘格格',
      '刘紫灵',
      '格格',
    ])
  })

  it('finds the same person written two ways, and nobody else', () => {
    // The real book writes both 「端木晨琳（晨琳）」 and 「晨琳（端木晨琳）」.
    expect(sameName('晨琳（端木晨琳）', '端木晨琳（晨琳）')).toBe(true)
    expect(sameName('刘紫灵（网名刘格格）', '刘紫灵')).toBe(true)
    // A longer name that merely starts the same is somebody else.
    expect(sameName('王上势', '王上')).toBe(false)
    expect(sameName('大格格', '格格')).toBe(false)
  })

  it('puts a bracketed relation on the card it belongs to', () => {
    const cards = [card('端木晨琳（晨琳）', { aliases: ['晨琳'] }), card('王上')]
    const file = upsertRelation({ formatVersion: 1, edges: [] }, {
      from: '晨琳（端木晨琳）',
      to: '王上',
      kind: '夫妻',
    })
    const seen = relationsOf(file, cards, '端木晨琳（晨琳）')
    expect(seen.map((item) => `${item.other} ${item.kind}`)).toEqual(['王上 夫妻'])
  })
})
