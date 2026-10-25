/**
 * The shape of a person, not just their four prose fields.
 *
 * A character sheet answers more than "how do they talk": what else the book
 * calls them, what they are like, what they have been through, who they are to
 * whom, and where they stand right now. The panel and `novel_canon` both write
 * cards, so both must mean the same thing by "I only changed the status" —
 * which is why every door goes through `updateCharacter`.
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { answersTo, updateCharacter } from '../src/domain/characters.ts'
import { emptyRelations, relationsOf, upsertRelation } from '../src/domain/relations.ts'
import { ProjectStore } from '../src/domain/store.ts'
import type { CharacterCard } from '../src/domain/types.ts'
import { readCharacterPatch } from '../src/panel/edit.ts'
import { PANEL_HEADER, PANEL_HEADER_VALUE, PANEL_PREFIX } from '../src/panel/serve.ts'
import { createHarness, type Harness } from './helpers.ts'

const stateHome = await mkdtemp(join(tmpdir(), 'inkwell-characters-home-'))
process.env.DSH_HOME = stateHome
afterAll(async () => {
  delete process.env.DSH_HOME
  await rm(stateHome, { recursive: true, force: true })
})

let harness: Harness | undefined
let server: Server | undefined
let base = ''

afterEach(async () => {
  if (server) {
    const open = server
    server = undefined
    await new Promise<void>((done) => open.close(() => done()))
  }
  if (harness) await harness.cleanup()
  harness = undefined
})

/** Start a book with the panel route reachable over HTTP. */
async function start(): Promise<void> {
  harness = await createHarness()
  await harness.call('novel_project', { action: 'init', title: '雾港' })
  const route = harness.routes.find((candidate) => candidate.path === PANEL_PREFIX)
  if (!route) throw new Error('the plugin registered no panel route')
  const created = createServer((req, res) => void route.handler(req, res))
  server = created
  await new Promise<void>((done) => created.listen(0, '127.0.0.1', () => done()))
  const address = created.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${address.port}${PANEL_PREFIX}`
}

/** The card as stored, so a projection cannot satisfy the assertion. */
async function cardOf(name: string): Promise<CharacterCard | undefined> {
  if (harness === undefined) throw new Error('no harness yet')
  return (await new ProjectStore(harness.root).characters()).find((card) => card.name === name)
}

/** POST an edit to one entry. */
async function edit(kind: string, key: string, fields: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/entry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
    body: JSON.stringify({ kind, key, fields }),
  })
}

describe('updateCharacter', () => {
  it('keeps every field an edit does not mention', async () => {
    await start()
    if (harness === undefined) throw new Error('no harness')
    const store = new ProjectStore(harness.root)
    await updateCharacter(store, '王上', {
      role: 'protagonist',
      voice: '短句',
      personality: '记仇，但从不当场发作',
      status: '刚把第二批货压进仓',
      aliases: ['王总', '小王'],
      stages: [{ label: '工地上', text: '扛水泥，被人叫小名' }],
      relations: [{ name: '刘紫灵', kind: '母女，但彼此不认' }],
      notes: '名字里的「上」是他自己改的',
    })

    await updateCharacter(store, '王上', { status: '被停职' })

    const card = await cardOf('王上')
    expect(card?.status).toBe('被停职')
    expect(card?.voice).toBe('短句')
    expect(card?.personality).toContain('记仇')
    expect(card?.aliases).toEqual(['王总', '小王'])
    expect(card?.stages).toEqual([{ label: '工地上', text: '扛水泥，被人叫小名' }])
    // Relations moved to their own table in v0.21: one edge, both ends named.
    expect(card?.relations).toBeUndefined()
    expect((await store.relations()).edges).toEqual([
      expect.objectContaining({ from: '王上', to: '刘紫灵', kind: '母女，但彼此不认' }),
    ])
    expect(card?.notes).toContain('自己改的')
  })

  it('clears a field on an empty value, because a mistake must be undoable', async () => {
    await start()
    if (harness === undefined) throw new Error('no harness')
    const store = new ProjectStore(harness.root)
    await updateCharacter(store, '阿鸢', { status: '在船上', relations: [{ name: '沈砚', kind: '船工同伴' }] })
    await updateCharacter(store, '阿鸢', { status: '', relations: [] })
    const card = await cardOf('阿鸢')
    expect(card?.status).toBeUndefined()
    expect(card?.relations).toBeUndefined()
    expect((await store.relations()).edges).toEqual([])
  })

  it('creates the card when nobody wrote one yet', async () => {
    await start()
    if (harness === undefined) throw new Error('no harness')
    const card = await updateCharacter(new ProjectStore(harness.root), '郑雅洁', { voice: '快，爱抢话' })
    expect(card.role).toBe('supporting')
    expect(card.appearance).toBe('')
    expect(card.voice).toBe('快，爱抢话')
  })
})

describe('answersTo', () => {
  it('finds a person through the name their heading carried in brackets', () => {
    const [subject]: CharacterCard[] = [
      {
        name: '刘紫灵（网名刘格格，正文里直接叫「格格」）',
        role: 'supporting',
        voice: '',
        appearance: '',
        goal: '',
        secret: '',
        aliases: ['刘格格', '格格', '刘紫灵'],
        updatedAt: 'now',
      },
    ]
    const other: CharacterCard = {
      name: '王上',
      role: 'protagonist',
      voice: '',
      appearance: '',
      goal: '',
      secret: '',
      relations: [{ name: '格格', kind: '压着的人' }],
      updatedAt: 'now',
    }
    expect(answersTo(subject!, '格格')).toBe(true)
    expect(answersTo(subject!, '刘紫灵')).toBe(true)
    expect(answersTo(subject!, '别人')).toBe(false)
    // A relation written under the nickname still lands on the card that owns it.
    const edge = upsertRelation(emptyRelations(), { from: '王上', to: '格格', kind: '压着的人' })
    const seen = relationsOf(edge, [subject!, other], subject!.name)
    expect(seen.map((item) => `${item.other} ${item.kind}`)).toEqual(['王上 压着的人'])
  })
})

describe('the character page', () => {
  it('shows names, character, stages, relations and status', async () => {
    await start()
    if (harness === undefined) throw new Error('no harness')
    const store = new ProjectStore(harness.root)
    await updateCharacter(store, '王上', {
      voice: '短句',
      aliases: ['王总'],
      personality: '记仇',
      status: '在仓库',
      stages: [{ label: '工地上', text: '扛水泥' }],
      relations: [{ name: '刘紫灵', kind: '母女' }],
    })
    const page = (await (await fetch(`${base}/entry?kind=character&key=${encodeURIComponent('王上')}`)).json()) as {
      data: { fields: { label: string; value: string }[]; lists: { label: string; items: string[] }[] }
    }
    const labels = page.data.fields.map((field) => field.label)
    expect(labels).toContain('别称')
    expect(labels).toContain('性格')
    expect(labels).toContain('当前状态')
    expect(page.data.fields.find((field) => field.label === '别称')?.value).toBe('王总')
    expect(page.data.lists.find((list) => list.label === '经历的阶段')?.items).toEqual(['工地上：扛水泥'])
    // The person named in the relation has no card yet, and the page says so
    // instead of pretending the relation is broken.
    expect(page.data.lists.find((list) => list.label === '关系')?.items).toEqual([
      '刘紫灵 —— 母女（角色卡里还没有这个人）',
    ])
  })

  it('shows the other side of a relation on the other person’s page', async () => {
    await start()
    if (harness === undefined) throw new Error('no harness')
    const store = new ProjectStore(harness.root)
    await updateCharacter(store, '刘紫灵', { voice: '慢' })
    await updateCharacter(store, '王上', { voice: '短句', relations: [{ name: '刘紫灵', kind: '母女' }] })
    const page = (await (await fetch(`${base}/entry?kind=character&key=${encodeURIComponent('刘紫灵')}`)).json()) as {
      data: { lists: { label: string; items: string[] }[] }
    }
    // One edge, so the other person's page reads the same record — and can edit it.
    expect(page.data.lists.find((list) => list.label === '关系')?.items).toEqual(['王上 —— 母女'])
  })

  it('writes relations and stages typed into the editor', async () => {
    await start()
    if (harness === undefined) throw new Error('no harness')
    await harness.call('novel_canon', { action: 'upsert_character', name: '王上', voice: '短句' })
    const response = await edit('character', '王上', {
      aliases: '王总、上势老板, 小王',
      status: '被停职',
      stages: '工地上：扛水泥\n上势老板：有人替他挡酒',
      relations: '刘紫灵：母女',
    })
    expect(response.status).toBe(200)
    const card = await cardOf('王上')
    expect(card?.aliases).toEqual(['王总', '上势老板', '小王'])
    expect(card?.status).toBe('被停职')
    expect(card?.stages).toHaveLength(2)
    expect((await new ProjectStore(harness.root).relations()).edges).toEqual([
      expect.objectContaining({ from: '王上', to: '刘紫灵', kind: '母女' }),
    ])
  })

  it('refuses a stage line without a colon, and says what it wants', async () => {
    await start()
    if (harness === undefined) throw new Error('no harness')
    await harness.call('novel_canon', { action: 'upsert_character', name: '王上', voice: '短句' })
    const response = await edit('character', '王上', { stages: '工地上扛水泥' })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error?: { message?: string } }
    expect(body.error?.message ?? '').toContain('阶段：发生了什么')
  })
})

describe('novel_canon', () => {
  it('takes aliases, stages and relations as lines, and keeps them on a later write', async () => {
    await start()
    if (harness === undefined) throw new Error('no harness')
    await harness.call('novel_canon', {
      action: 'upsert_character',
      name: '王上',
      role: 'protagonist',
      voice: '短句',
      personality: '记仇',
      status: '在仓库',
      aliases: ['王总'],
      stages: ['工地上：扛水泥'],
      relations: ['刘紫灵：母女'],
    })
    await harness.call('novel_canon', { action: 'upsert_character', name: '王上', status: '跑路' })
    const card = await cardOf('王上')
    expect(card?.status).toBe('跑路')
    expect(card?.role).toBe('protagonist')
    expect(card?.personality).toBe('记仇')
    expect(card?.aliases).toEqual(['王总'])
    expect(card?.stages).toEqual([{ label: '工地上', text: '扛水泥' }])
    expect((await new ProjectStore(harness.root).relations()).edges).toEqual([
      expect.objectContaining({ from: '王上', to: '刘紫灵', kind: '母女' }),
    ])
  })

  it('refuses a relation that names nobody', async () => {
    await start()
    if (harness === undefined) throw new Error('no harness')
    const result = await harness.call('novel_canon', {
      action: 'upsert_character',
      name: '王上',
      voice: '短句',
      relations: ['刘紫灵母女'],
    })
    expect(result.ok).toBe(false)
    expect(String(result.ok === false ? result.error : '')).toContain('对方：关系')
  })
})

describe('readCharacterPatch', () => {
  it('reads one line per stage and one per relation, in the order typed', () => {
    const patch = readCharacterPatch('王上', {
      stages: '工地上：扛水泥\n\n上势老板：有人替他挡酒',
      relations: '刘紫灵：母女\n薛梦静：后来的',
    })
    expect(patch.stages).toEqual([
      { label: '工地上', text: '扛水泥' },
      { label: '上势老板', text: '有人替他挡酒' },
    ])
    expect(patch.relations).toEqual([
      { name: '刘紫灵', kind: '母女' },
      { name: '薛梦静', kind: '后来的' },
    ])
  })
})
