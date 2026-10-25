/**
 * The chapter card: what a chapter was about.
 *
 * Two doors write it — `novel_outline action="card"` and the chapter page in the
 * panel, which submits the card with the prose — and both have to merge rather
 * than replace. This repository has lost imported notes to a whole-object write
 * before, and a card is the same shape of object.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MissingPlanError, presentInText, updateCard } from '../src/domain/cards.ts'
import { ProjectStore } from '../src/domain/store.ts'
import type { ChapterPlan } from '../src/domain/types.ts'
import { PANEL_HEADER, PANEL_HEADER_VALUE, PANEL_PREFIX } from '../src/panel/serve.ts'
import { createHarness, valueOf, type Harness } from './helpers.ts'

/** A plan with just enough to be a card holder. */
function plan(number: number, extra: Partial<ChapterPlan> = {}): ChapterPlan {
  return { number, volume: 1, title: `第${number}章`, pov: '', characters: [], beats: [], hooks: [], approved: true, ...extra }
}

describe('chapter card domain', () => {
  let space: string | undefined

  afterEach(async () => {
    if (space) await rm(space, { recursive: true, force: true })
    space = undefined
  })

  /** A store holding one plan, in a throwaway directory. */
  async function store(): Promise<ProjectStore> {
    space = await mkdtemp(join(tmpdir(), 'inkwell-card-'))
    const made = new ProjectStore(space)
    await made.upsertPlan(plan(1))
    return made
  }

  it('keeps the fields the patch does not mention', async () => {
    const made = await store()
    await updateCard(made, 1, { summary: '一场雨夜的交易', events: ['发现尸体', '改航向'], scene: '雾港旧码头' })
    const card = await updateCard(made, 1, { scene: '码头仓库' })
    expect(card.summary).toBe('一场雨夜的交易')
    expect(card.events).toEqual(['发现尸体', '改航向'])
    expect(card.scene).toBe('码头仓库')
  })

  it('treats an empty string as a real edit and deletes the field', async () => {
    const made = await store()
    await updateCard(made, 1, { summary: '写过的梗概', scene: '旧码头' })
    const card = await updateCard(made, 1, { summary: '' })
    expect(card.summary).toBeUndefined()
    expect(card.scene).toBe('旧码头')
  })

  it('refuses a card for a chapter with no outline', async () => {
    const made = await store()
    await expect(updateCard(made, 9, { summary: '没有章纲' })).rejects.toBeInstanceOf(MissingPlanError)
  })

  it('lists only the names the prose actually uses', () => {
    const names = ['沈砚', '阿鸢', '郑雅洁']
    expect(presentInText('沈砚推开门，阿鸢不在。', names)).toEqual(['沈砚', '阿鸢'])
    expect(presentInText('', names)).toEqual([])
  })
})

describe('chapter card through the panel', () => {
  let server: Server | undefined
  let harness: Harness | undefined
  const spaces: string[] = []

  afterEach(async () => {
    if (server) {
      const open = server
      server = undefined
      await new Promise<void>((done) => open.close(() => done()))
    }
    if (harness) await harness.cleanup()
    harness = undefined
    for (const one of spaces.splice(0)) await rm(one, { recursive: true, force: true })
  })

  /** Mount the plugin and serve its panel route. */
  async function serve(): Promise<string> {
    harness ??= await createHarness()
    const route = harness.routes.find((candidate) => candidate.path === PANEL_PREFIX)
    if (!route) throw new Error('the plugin registered no panel route')
    const created = createServer((req, res) => void route.handler(req, res))
    server = created
    await new Promise<void>((done) => created.listen(0, '127.0.0.1', () => done()))
    const address = created.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    return `http://127.0.0.1:${address.port}`
  }

  /** Save a chapter through the same route the page posts to. */
  async function save(base: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${base}${PANEL_PREFIX}/entry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
      body: JSON.stringify(body),
    })
  }

  /** The store behind the mounted plugin. */
  function storeOf(one: Harness): ProjectStore {
    return new ProjectStore(one.root)
  }

  /** Start a book in the harness root, the one the panel route reads. */
  async function startBook(one: Harness): Promise<ProjectStore> {
    const book = new ProjectStore(one.root)
    await book.init('雾港', 800_000)
    await book.writeProject({ ...(await book.readProject()), phase: 'drafting' })
    return book
  }

  it('writes the card alongside the prose in one submit', async () => {
    const base = await serve()
    const book = await startBook(harness!)
    await book.upsertPlan(plan(1, { title: '裂缝', characters: [] }))

    const response = await save(base, {
      kind: 'chapter',
      key: '1',
      fields: {
        text: '雨落了一夜，码头的木板吸饱了水。'.repeat(12),
        title: '裂缝',
        scene: '雾港旧码头',
        story: '沈砚在雨夜发现一具不该出现的尸体。',
        events: '发现尸体\n改航向',
      },
    })
    expect(response.status).toBe(200)
    const card = (await storeOf(harness!).plans()).find((item) => item.number === 1)
    expect(card?.scene).toBe('雾港旧码头')
    expect(card?.summary).toBe('沈砚在雨夜发现一具不该出现的尸体。')
    expect(card?.events).toEqual(['发现尸体', '改航向'])
    // The contract still holds: an outline edit did not arrive with the card.
    expect(card?.title).toBe('裂缝')
  })

  it('gives an imported chapter a card even when it has no outline', async () => {
    const base = await serve()
    const book = await startBook(harness!)
    await book.writeChapter({
      number: 1,
      title: '裂缝',
      text: '雨落了一夜。'.repeat(40),
      words: 280,
      summary: '雨夜。',
      writtenAt: new Date().toISOString(),
    })

    const response = await save(base, {
      kind: 'chapter',
      key: '1',
      fields: { text: '雨落了一夜。'.repeat(40), scene: '雾港旧码头' },
    })
    expect(response.status).toBe(200)
    const card = (await storeOf(harness!).plans()).find((item) => item.number === 1)
    expect(card?.scene).toBe('雾港旧码头')
  })
})

describe('novel_outline action="card"', () => {
  let harness: Harness | undefined

  afterEach(async () => {
    if (harness) await harness.cleanup()
    harness = undefined
  })

  /** A book with one approved chapter and one character. */
  async function book(): Promise<Harness> {
    harness ??= await createHarness()
    const store = new ProjectStore(harness.root)
    await store.init('雾港', 800_000)
    await store.upsertCharacter({ name: '沈砚', role: 'protagonist', voice: '短句。', appearance: '', goal: '', secret: '', updatedAt: new Date().toISOString() })
    await store.upsertPlan({ number: 1, volume: 1, title: '裂缝', pov: '沈砚', characters: ['沈砚'], beats: ['发现尸体', '改航向'], hooks: [], approved: true })
    return harness
  }

  it('writes the card and leaves the contract alone', async () => {
    const one = await book()
    const value = valueOf<{ report: string }>(
      await one.call('novel_outline', {
        action: 'card',
        number: 1,
        summary: '沈砚在雨夜发现一具尸体。',
        scene: '雾港旧码头',
        events: ['发现尸体', '改航向'],
        hooks: ['岸上有人等他'],
      }),
    )
    expect(value.report).toContain('章卡已更新')
    const plan = (await new ProjectStore(one.root).plans())[0]!
    expect(plan.summary).toBe('沈砚在雨夜发现一具尸体。')
    expect(plan.scene).toBe('雾港旧码头')
    expect(plan.events).toEqual(['发现尸体', '改航向'])
    // Recording what happened is not an outline edit: no re-approval needed.
    expect(plan.approved).toBe(true)
    expect(plan.beats).toEqual(['发现尸体', '改航向'])
  })

  it('refuses a name that has no character card', async () => {
    const one = await book()
    const refused = await one.call('novel_outline', { action: 'card', number: 1, characters: ['阿鸢'] })
    expect(refused.ok).toBe(false)
    expect(String(refused.ok === false ? refused.error : '')).toMatch(/角色卡上没有的人/)
  })

  it('refuses an empty card', async () => {
    const one = await book()
    const refused = await one.call('novel_outline', { action: 'card', number: 1 })
    expect(refused.ok).toBe(false)
    expect(String(refused.ok === false ? refused.error : '')).toMatch(/至少要给一个字段/)
  })
})
