/**
 * The workshop panel: projection, route, and the "no book yet" state.
 *
 * The panel is read-only and derived, so both halves are testable without a
 * browser: the projection is a pure function of a snapshot, and the route is a
 * plain node HTTP handler. The tests below cover the projection's union rule
 * (a plan with no chapter is a row, and so is a chapter with no plan), the
 * facts strip, the empty state, and the route's own guards.
 */
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { ProjectStore } from '../src/domain/store.ts'
import type {
  ChapterMeta,
  ChapterPlan,
  CharacterCard,
  DraftRound,
  LedgerEntry,
  Snapshot,
  VolumeOutline,
  WorldEntry,
} from '../src/domain/types.ts'
import { buildPanelSnapshot, emptyPanelSnapshot } from '../src/panel/model.ts'
import { PANEL_HEADER, PANEL_HEADER_VALUE, PANEL_PREFIX, readPanel } from '../src/panel/serve.ts'
import { createHarness, type Harness } from './helpers.ts'

// The shelf lives under dsh's state directory, which must not be the real one
// during a test run: a suite that appends to the developer's book list is a bug.
const stateHome = await mkdtemp(join(tmpdir(), 'inkwell-home-'))
process.env.DSH_HOME = stateHome
afterAll(async () => {
  delete process.env.DSH_HOME
  await rm(stateHome, { recursive: true, force: true })
})

const PREMISE = '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。'.repeat(4)

/** A book assembled in memory, for the projection tests. */
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
    volumes: [],
    plans: [],
    ledger: [],
    chapters: [],
    ...overrides,
  }
}

/** One outline, approved or not. */
function plan(number: number, approved: boolean, title = ''): ChapterPlan {
  return { number, volume: 1, title, pov: '沈砚', characters: [], beats: [], hooks: [], approved }
}

/** One draft round carrying the findings a propose call would have stored. */
function round(number: number, roundNumber: number, errors: number, warnings: number): DraftRound {
  const autoFindings = [
    ...Array.from({ length: errors }, (_unused, index) => ({
      severity: 'error' as const,
      code: `test/error-${index}`,
      message: 'x',
      evidence: '',
    })),
    ...Array.from({ length: warnings }, (_unused, index) => ({
      severity: 'warn' as const,
      code: `test/warn-${index}`,
      message: 'y',
      evidence: '',
    })),
  ]
  return {
    number,
    round: roundNumber,
    text: '正文',
    words: 10,
    summary: '摘要',
    autoFindings,
    writtenAt: '2026-01-03T00:00:00.000Z',
  }
}

/** One ledger entry. */
function fact(id: string, supersedes: string | null, chapter: number): LedgerEntry {
  return {
    id,
    subject: '沈砚',
    predicate: '身份',
    value: `值${id}`,
    chapter,
    quote: '原文',
    supersedes,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

/** One character card. */
function card(name: string, role: CharacterCard['role'], goal = ''): CharacterCard {
  return { name, role, voice: '低沉', appearance: '', goal, secret: '', updatedAt: '2026-01-01T00:00:00.000Z' }
}

/** One world entry. */
function place(name: string, kind = '地点'): WorldEntry {
  return { name, kind, detail: '', updatedAt: '2026-01-01T00:00:00.000Z' }
}

/** One volume outline. */
function volume(number: number, title: string, approved = true): VolumeOutline {
  return { number, title, summary: '', approved }
}

/** One committed chapter. */
function written(number: number, title: string, words: number): ChapterMeta {
  return { number, title, words, summary: '', writtenAt: '2026-01-05T00:00:00.000Z' }
}

describe('panel tree', () => {
  const config = resolveConfig({})

  /** Project the book and index the drawers by id. */
  function drawers(snapshot: Snapshot, drafts: DraftRound[] = []): Map<string, { count: number; rows: unknown[] }> {
    const built = buildPanelSnapshot(
      snapshot,
      config,
      drafts.length > 0 ? [{ number: drafts[0]?.number ?? 1, rounds: drafts }] : [],
      '/nowhere',
    )
    return new Map(built.sections.map((section) => [section.id, section]))
  }

  it('counts the four drawers the panel shows', () => {
    const found = drawers(
      book({
        characters: [card('沈砚', 'protagonist'), card('阿鸢', 'supporting')],
        world: [place('雾港'), place('黑潮会', '势力')],
        volumes: [volume(1, '雾起')],
        plans: [{ ...plan(1, true, '裂缝'), beats: ['a', 'b'], hooks: ['h'] }],
        chapters: [written(1, '裂缝', 3000)],
      }),
    )
    expect(found.get('world')?.count).toBe(2)
    expect(found.get('cast')?.count).toBe(2)
    expect(found.get('plot')?.count).toBe(2 + 1 + 1) // beats + hooks + cards
    expect(found.get('text')?.count).toBe(1)
  })

  it('groups the cast by structural role, with an overview row first', () => {
    const sections = buildPanelSnapshot(
      book({ characters: [card('沈砚', 'protagonist'), card('阿鸢', 'supporting'), card('老周', 'supporting')] }),
      config,
      [],
      '/nowhere',
    ).sections
    const cast = sections.find((section) => section.id === 'cast')
    const overview = cast?.rows[0]
    expect(overview?.label).toBe('概览')
    const protagonist = cast?.rows.find((row) => row.label === '主角')
    const supporting = cast?.rows.find((row) => row.label === '配角')
    expect(protagonist?.count).toBe(1)
    expect(supporting?.count).toBe(2)
    expect(supporting?.children?.map((row) => row.label)).toEqual(['阿鸢', '老周'])
    // A role with nobody in it is still a row, muted, so the shape never jumps.
    expect(cast?.rows.find((row) => row.label === '反派')?.count).toBe(0)
  })

  it('builds the plot drawer from the spine, the beats, the hooks and the cards', () => {
    const sections = buildPanelSnapshot(
      book({
        volumes: [volume(1, '雾起'), volume(2, '潮落', false)],
        plans: [
          { ...plan(1, true, '裂缝'), beats: ['血从船舱渗出来', '他认出了妹妹'], hooks: ['谁改了航向'] },
          { ...plan(2, false, '金童玉女'), volume: 2, beats: ['码头空了'] },
        ],
      }),
      config,
      [],
      '/nowhere',
    ).sections
    const plot = sections.find((section) => section.id === 'plot')
    const spine = plot?.rows.find((row) => row.label === '全书故事线')
    expect(spine?.chip).toBe('故事线')
    expect(spine?.count).toBeUndefined()
    expect(spine?.children?.map((row) => row.count)).toEqual([1, 1])
    expect(spine?.children?.[0]?.children?.map((row) => row.label)).toEqual(['第1章 裂缝'])
    expect(spine?.children?.[1]?.children?.map((row) => row.chip)).toEqual(['待批准'])
    expect(plot?.rows.find((row) => row.label === '剧情点')?.count).toBe(3)
    expect(plot?.rows.find((row) => row.label === '伏笔总览')?.count).toBe(1)
    const cards = plot?.rows.find((row) => row.label === '章卡')
    expect(cards?.count).toBe(2)
    expect(cards?.children?.map((row) => row.chip)).toEqual(['已批准', '待批准'])
  })

  it('marks each manuscript row with its real state', () => {
    const sections = buildPanelSnapshot(
      book({
        volumes: [volume(1, '雾起')],
        plans: [{ ...plan(1, true, '裂缝') }, { ...plan(2, false, '金童玉女') }, { ...plan(3, true, '潮声') }],
        chapters: [written(1, '裂缝', 3200)],
      }),
      config,
      [{ number: 2, rounds: [round(2, 1, 0, 0)] }],
      '/nowhere',
    ).sections
    const text = sections.find((section) => section.id === 'text')
    const rows = text?.rows.find((row) => row.id === 'text.volume.1')?.children ?? []
    expect(rows.map((row) => row.chip)).toEqual(['已完成', '1 稿', '可写'])
    expect(rows[0]?.aside).toBe('3200 字')
    expect(rows[0]?.tone).toBe('done')
    expect(rows[1]?.tone).toBe('warn')
  })

  it('caps a long list instead of shipping every row', () => {
    const plans: ChapterPlan[] = Array.from({ length: 30 }, (_unused, index) => plan(index + 1, true, `第${index + 1}章`))
    const sections = buildPanelSnapshot(book({ plans }), config, [], '/nowhere').sections
    const cards = sections.find((section) => section.id === 'plot')?.rows.find((row) => row.label === '章卡')
    expect(cards?.children).toHaveLength(25)
    expect(cards?.children?.at(-1)?.label).toBe('还有 6 条')
  })

  it('describes an empty book with four empty drawers', () => {
    const sections = buildPanelSnapshot(book(), config, [], '/nowhere').sections
    expect(sections.map((section) => section.count)).toEqual([0, 0, 0, 0])
    expect(sections.map((section) => section.rows.length)).toEqual([0, 5, 4, 0])
  })
})

describe('buildPanelSnapshot', () => {
  const config = resolveConfig({})

  it('lists a planned-but-unwritten chapter as a row that is ready to write', () => {
    const snapshot = buildPanelSnapshot(book({ plans: [plan(1, true, '夜渡')] }), config, [], '/book')
    expect(snapshot.chapters).toHaveLength(1)
    expect(snapshot.chapters[0]).toMatchObject({
      number: 1,
      title: '夜渡',
      words: 0,
      written: false,
      approved: true,
      drafts: 0,
    })
    expect(snapshot.approved).toBe(1)
    expect(snapshot.planned).toBe(1)
    expect(snapshot.written).toBe(0)
  })

  it('still lists a written chapter whose outline is gone', () => {
    const snapshot = buildPanelSnapshot(
      book({ chapters: [{ number: 3, title: '旧章', words: 2100, summary: '', writtenAt: '2026-01-04T00:00:00.000Z' }] }),
      config,
      [],
      '/book',
    )
    expect(snapshot.chapters[0]).toMatchObject({ number: 3, title: '旧章', words: 2100, written: true, approved: false })
    expect(snapshot.words).toBe(2100)
    expect(snapshot.written).toBe(1)
  })

  it('merges plan and chapter for the same number into one row', () => {
    const snapshot = buildPanelSnapshot(
      book({
        plans: [plan(2, true, '入港')],
        chapters: [{ number: 2, title: '入港', words: 3000, summary: '', writtenAt: '2026-01-04T00:00:00.000Z' }],
      }),
      config,
      [],
      '/book',
    )
    expect(snapshot.chapters).toHaveLength(1)
    expect(snapshot.chapters[0]).toMatchObject({ number: 2, written: true, approved: true, words: 3000 })
  })

  it('counts the newest draft round findings', () => {
    const drafts = [{ number: 1, rounds: [round(1, 1, 9, 9), round(1, 2, 1, 2)] }]
    const snapshot = buildPanelSnapshot(book({ plans: [plan(1, true)] }), config, drafts, '/book')
    expect(snapshot.chapters[0]).toMatchObject({ drafts: 2, errors: 1, warnings: 2 })
  })

  it('shows only unsuperseded facts and counts the retired ones', () => {
    const ledger = [fact('f-0001', null, 0), fact('f-0002', 'f-0001', 1), fact('f-0003', null, 2)]
    const snapshot = buildPanelSnapshot(book({ ledger }), config, [], '/book')
    expect(snapshot.facts.map((entry) => entry.id)).toEqual(['f-0002', 'f-0003'])
    expect(snapshot.retired).toBe(1)
  })

  it('caps the facts strip at eight, newest last', () => {
    const ledger = Array.from({ length: 12 }, (_unused, index) => fact(`f-${index}`, null, index))
    const snapshot = buildPanelSnapshot(book({ ledger }), config, [], '/book')
    expect(snapshot.facts).toHaveLength(8)
    expect(snapshot.facts.at(-1)?.id).toBe('f-11')
  })

  it('reports what blocks the next phase, in the studio words', () => {
    const premise = book()
    premise.project = { ...premise.project, phase: 'premise', premise: '太短' }
    const snapshot = buildPanelSnapshot(premise, config, [], '/book')
    expect(snapshot.phase).toBe('premise')
    expect(snapshot.next).toBe('canon')
    expect(snapshot.blockers.join('\n')).toContain('80')
  })

  it('reports no next phase once the book is done', () => {
    const done = book()
    done.project = { ...done.project, phase: 'done' }
    const snapshot = buildPanelSnapshot(done, config, [], '/book')
    expect(snapshot.next).toBeNull()
    expect(snapshot.blockers).toEqual([])
  })

  it('counts canon, world and volumes', () => {
    const snapshot = buildPanelSnapshot(
      book({
        characters: [
          {
            name: '沈砚',
            role: 'protagonist',
            voice: '短句',
            appearance: '',
            goal: '',
            secret: '',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        world: [{ name: '雾港', kind: '地点', detail: '终年起雾', updatedAt: '2026-01-01T00:00:00.000Z' }],
        volumes: [{ number: 1, title: '入港', summary: '', approved: true }],
      }),
      config,
      [],
      '/book',
    )
    expect(snapshot.characterCount).toBe(1)
    expect(snapshot.worldCount).toBe(1)
    expect(snapshot.volumeCount).toBe(1)
  })
})

describe('emptyPanelSnapshot', () => {
  it('describes a directory with no book in it', () => {
    const empty = emptyPanelSnapshot('/nowhere')
    expect(empty).toMatchObject({ title: '', phase: null, next: null, chapters: [], root: '/nowhere', words: 0 })
  })
})

describe('readPanel', () => {
  const cleanups: Array<() => Promise<void>> = []
  let harness: Harness | undefined

  afterEach(async () => {
    if (harness) await harness.cleanup()
    harness = undefined
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  it('answers with the empty state instead of an error when no book exists', async () => {
    harness = await createHarness()
    const config = resolveConfig({ root: '.novel' })
    const answer = await readPanel({ config, baseStore: new ProjectStore(harness.root) }, undefined)
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ ok: true, data: { title: '', phase: null, root: harness.root } })
  })

  it('projects a real book once one exists', async () => {
    harness = await createHarness()
    await harness.call('novel_project', { action: 'init', title: '雾港' })
    await harness.call('novel_project', { action: 'premise', premise: PREMISE })

    const answer = await readPanel(
      { config: resolveConfig({ root: '.novel' }), baseStore: new ProjectStore(harness.root) },
      undefined,
    )
    expect(answer.status).toBe(200)
    const data = (answer.body as { data: { title: string; phase: string; premiseChars: number } }).data
    expect(data.title).toBe('雾港')
    expect(data.phase).toBe('premise')
    expect(data.premiseChars).toBe(PREMISE.length)
  })

  it('reads the book of the session that asked', async () => {
    harness = await createHarness({ root: '.novel' })
    const one = await mkdtemp(join(tmpdir(), 'inkwell-panel-a-'))
    const two = await mkdtemp(join(tmpdir(), 'inkwell-panel-b-'))
    cleanups.push(async () => {
      await rm(one, { recursive: true, force: true })
      await rm(two, { recursive: true, force: true })
    })
    await harness.call('novel_project', { action: 'init', title: '甲书' }, { cwd: one })
    await harness.call('novel_project', { action: 'init', title: '乙书' }, { cwd: two })

    const deps = {
      config: resolveConfig({ root: '.novel' }),
      baseStore: new ProjectStore(harness.root),
      cwdOf: (sessionId: string) => (sessionId === 's-one' ? one : sessionId === 's-two' ? two : undefined),
    }
    expect((await readPanel(deps, 's-one')).body).toMatchObject({ data: { title: '甲书' } })
    expect((await readPanel(deps, 's-two')).body).toMatchObject({ data: { title: '乙书' } })
    // A session the host does not know falls back to the shared book, not a guess.
    expect((await readPanel(deps, 's-unknown')).body).toMatchObject({ ok: true, data: { title: '' } })
  })
})

describe('panel route', () => {
  let server: Server | undefined
  let harness: Harness | undefined

  afterEach(async () => {
    if (server) {
      const open = server
      server = undefined
      await new Promise<void>((done) => open.close(() => done()))
    }
    if (harness) await harness.cleanup()
    harness = undefined
  })

  /** Serve the route the plugin registered on an ephemeral port; returns its base URL. */
  async function listen(): Promise<string> {
    harness ??= await createHarness()
    const routes = harness.routes.filter((route) => route.path === PANEL_PREFIX)
    expect(routes).toHaveLength(1)
    const route = routes[0]
    if (!route) throw new Error('the plugin registered no panel route')
    expect(route.kind).toBe('prefix')
    const created = createServer((req, res) => void route.handler(req, res))
    server = created
    await new Promise<void>((done) => created.listen(0, '127.0.0.1', () => done()))
    const address = created.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    return `http://127.0.0.1:${address.port}`
  }

  it('serves the snapshot as no-store JSON', async () => {
    const base = await listen()
    const response = await fetch(`${base}${PANEL_PREFIX}/snapshot`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = (await response.json()) as { ok: boolean; data: { root: string } }
    expect(body.ok).toBe(true)
    expect(body.data.root).toBe(harness?.root)
  })

  it('answers 404 for a path the panel does not own', async () => {
    const base = await listen()
    const response = await fetch(`${base}${PANEL_PREFIX}/nope`)
    expect(response.status).toBe(404)
  })

  it('refuses a write without the plugin header', async () => {
    const base = await listen()
    const response = await fetch(`${base}${PANEL_PREFIX}/snapshot`, { method: 'POST' })
    expect(response.status).toBe(403)
  })

  it('answers 405 to a write that does carry the header', async () => {
    const base = await listen()
    const response = await fetch(`${base}${PANEL_PREFIX}/snapshot`, {
      method: 'POST',
      headers: { [PANEL_HEADER]: PANEL_HEADER_VALUE },
    })
    expect(response.status).toBe(405)
  })
})

describe('panel create route', () => {
  // This harness pins a relative root, so `init` has somewhere to put the book
  // and the picker can report one that already exists.
  let server: Server | undefined
  let harness: Harness | undefined
  let space: string | undefined

  afterEach(async () => {
    if (server) {
      const open = server
      server = undefined
      await new Promise<void>((done) => open.close(() => done()))
    }
    if (harness) await harness.cleanup()
    harness = undefined
    if (space) await rm(space, { recursive: true, force: true })
    space = undefined
  })

  /** Mount the plugin over a relative root and serve its panel route. */
  async function serve(): Promise<{ base: string; space: string }> {
    harness ??= await createHarness({ root: '.novel' })
    space ??= await mkdtemp(join(tmpdir(), 'inkwell-create-'))
    const routes = harness.routes.filter((route) => route.path === PANEL_PREFIX)
    const route = routes[0]
    if (!route) throw new Error('the plugin registered no panel route')
    const created = createServer((req, res) => void route.handler(req, res))
    server = created
    await new Promise<void>((done) => created.listen(0, '127.0.0.1', () => done()))
    const address = created.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    return { base: `http://127.0.0.1:${address.port}`, space }
  }

  /** POST one create request with the plugin header. */
  async function postCreate(base: string, body: unknown): Promise<Response> {
    return fetch(`${base}${PANEL_PREFIX}/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
      body: JSON.stringify(body),
    })
  }

  it('refuses to create without the plugin header', async () => {
    const { base, space } = await serve()
    const response = await fetch(`${base}${PANEL_PREFIX}/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: space, title: '雾港' }),
    })
    expect(response.status).toBe(403)
  })

  it('lists the child directories of a path the picker names', async () => {
    const { base, space } = await serve()
    await mkdir(join(space, '雾港'))
    await mkdir(join(space, '旧稿'))
    const response = await fetch(`${base}${PANEL_PREFIX}/dirs?path=${encodeURIComponent(space)}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; data: { path: string; entries: Array<{ name: string }>; book: unknown } }
    expect(body.ok).toBe(true)
    expect(body.data.path).toBe(space)
    expect(body.data.entries.map((entry) => entry.name)).toEqual(['旧稿', '雾港'])
    expect(body.data.book).toBeNull()
  })

  it('refuses a relative directory instead of resolving it against the host', async () => {
    const { base } = await serve()
    const response = await fetch(`${base}${PANEL_PREFIX}/dirs?path=.novel`)
    expect(response.status).toBe(400)
    const body = (await response.json()) as { ok: boolean; error: { message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.message).toContain('绝对路径')
  })

  it('creates a book in the chosen directory', async () => {
    const { base, space } = await serve()
    const response = await postCreate(base, { dir: space, title: '雾港', targetWords: 120000 })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; data: { root: string; title: string; existing: boolean } }
    expect(body.data.title).toBe('雾港')
    expect(body.data.existing).toBe(false)
    expect(body.data.root).toBe(join(space, '.novel'))

    const store = new ProjectStore(body.data.root)
    expect(await store.exists()).toBe(true)
    expect((await store.readProject()).targetWords).toBe(120000)

    // The panel then reads that book through `?root=`, so a book outside the
    // session's own workspace is still reachable.
    const snapshot = await fetch(`${base}${PANEL_PREFIX}/snapshot?root=${encodeURIComponent(body.data.root)}`)
    expect(snapshot.status).toBe(200)
    expect((await snapshot.json())).toMatchObject({ ok: true, data: { title: '雾港', phase: 'premise' } })
  })

  it('reports an existing book instead of overwriting it', async () => {
    const { base, space } = await serve()
    await postCreate(base, { dir: space, title: '雾港' })
    const again = await postCreate(base, { dir: space, title: '另一本' })
    const body = (await again.json()) as { data: { title: string; existing: boolean } }
    expect(body.data.existing).toBe(true)
    expect(body.data.title).toBe('雾港')
  })

  it('names an untitled book so the panel never shows a blank shield', async () => {
    const { base, space } = await serve()
    const response = await postCreate(base, { dir: space, title: '   ' })
    const body = (await response.json()) as { data: { title: string } }
    expect(body.data.title).toBe('未命名')
  })

  it('refuses to create when the configured root is absolute', async () => {
    harness = await createHarness()
    space = await mkdtemp(join(tmpdir(), 'inkwell-create-'))
    const routes = harness.routes.filter((route) => route.path === PANEL_PREFIX)
    const route = routes[0]
    if (!route) throw new Error('the plugin registered no panel route')
    const created = createServer((req, res) => void route.handler(req, res))
    server = created
    await new Promise<void>((done) => created.listen(0, '127.0.0.1', () => done()))
    const address = created.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const response = await postCreate(`http://127.0.0.1:${address.port}`, { dir: space, title: '雾港' })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain('root 被固定')
  })

  it('accepts only POST on the create route', async () => {
    const { base } = await serve()
    const response = await fetch(`${base}${PANEL_PREFIX}/init`)
    expect(response.status).toBe(405)
  })

  it('lists the books on the shelf, newest door first', async () => {
    const { base, space } = await serve()
    const created = await postCreate(base, { dir: space, title: '雾港' })
    const book = (await created.json()) as { data: { root: string } }

    const response = await fetch(`${base}${PANEL_PREFIX}/books`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      data: { books: Array<{ root: string; title: string; phase: string; chapters: number; words: number }>; current: string }
    }
    expect(body.ok).toBe(true)
    const listed = body.data.books.find((entry) => entry.root === book.data.root)
    // A book created through the panel is on the shelf: that is what makes the
    // library page worth opening the second time.
    expect(listed).toBeDefined()
    expect(listed).toMatchObject({ title: '雾港', phase: 'premise', chapters: 0, words: 0 })
  })

  it('keeps a book off the shelf once its directory is gone', async () => {
    const { base, space } = await serve()
    const created = await postCreate(base, { dir: space, title: '雾港' })
    const book = (await created.json()) as { data: { root: string } }
    await rm(space, { recursive: true, force: true })

    const response = await fetch(`${base}${PANEL_PREFIX}/books`)
    const body = (await response.json()) as { data: { books: Array<{ root: string }> } }
    // The shelf remembers a path, not a promise: a deleted book must not appear.
    expect(body.data.books.some((entry) => entry.root === book.data.root)).toBe(false)
  })

  it('serves the shelf read-only', async () => {
    const { base } = await serve()
    const response = await fetch(`${base}${PANEL_PREFIX}/books`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
      body: '{}',
    })
    expect(response.status).toBe(405)
  })
})

describe('panel entry route', () => {
  let server: Server | undefined
  let harness: Harness | undefined
  let space: string | undefined

  afterEach(async () => {
    if (server) {
      const open = server
      server = undefined
      await new Promise<void>((done) => open.close(() => done()))
    }
    if (harness) await harness.cleanup()
    harness = undefined
    if (space) await rm(space, { recursive: true, force: true })
    space = undefined
  })

  /**
   * Serve a book that already has one character, one place, and one chapter.
   *
   * The route is exercised against a real store rather than a mocked snapshot:
   * the whole point of `/entry` is that it reads the same files the tools do.
   */
  async function serveBook(): Promise<{ base: string; root: string }> {
    harness = await createHarness({ root: '.novel' })
    space = await mkdtemp(join(tmpdir(), 'inkwell-entry-'))
    const root = join(space, '.novel')
    const store = new ProjectStore(root)
    await store.init('雾港', 120_000)
    // The book has an approved outline, so it is a drafting book: every chapter
    // write below has to clear the same phase gate the tools go through.
    await store.writeProject({ ...(await store.readProject()), phase: 'drafting' })
    await store.upsertCharacter({
      name: '沈砚',
      role: 'protagonist',
      voice: '短句，问句多',
      appearance: '',
      goal: '找到妹妹',
      secret: '',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await store.upsertWorld({ name: '雾港', kind: '地点', detail: '终年不散的雾', updatedAt: '2026-01-01T00:00:00.000Z' })
    await store.upsertVolume({ number: 1, title: '雾里的货单', summary: '', approved: true })
    await store.upsertPlan({
      number: 1,
      volume: 1,
      title: '裂缝',
      pov: '沈砚',
      characters: ['沈砚'],
      beats: ['发现尸体', '改航向'],
      hooks: ['岸上有人等他'],
      approved: true,
    })
    const text = '沈砚发现船底藏着尸体。'.repeat(80)
    await store.writeChapter({
      number: 1,
      title: '裂缝',
      text,
      words: text.length,
      summary: '第一章',
      writtenAt: '2026-01-05T00:00:00.000Z',
    })
    const route = harness.routes.filter((entry) => entry.path === PANEL_PREFIX)[0]
    if (!route) throw new Error('the plugin registered no panel route')
    const created = createServer((req, res) => void route.handler(req, res))
    server = created
    await new Promise<void>((done) => created.listen(0, '127.0.0.1', () => done()))
    const address = created.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    return { base: `http://127.0.0.1:${address.port}`, root }
  }

  it('serves a character page from the book on disk', async () => {
    const { base, root } = await serveBook()
    const response = await fetch(
      `${base}${PANEL_PREFIX}/entry?kind=character&key=${encodeURIComponent('沈砚')}&root=${encodeURIComponent(root)}`,
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      data: { title: string; subtitle: string; fields: Array<{ label: string; value: string }>; lists: Array<{ label: string; items: string[] }> }
    }
    expect(body.ok).toBe(true)
    expect(body.data.title).toBe('沈砚')
    expect(body.data.subtitle).toBe('主角 · 找到妹妹')
    expect(body.data.fields.find((field) => field.label === '说话方式')?.value).toBe('短句，问句多')
    expect(body.data.lists.find((list) => list.label === '出场章节')?.items).toEqual(['第1章 裂缝'])
  })

  it('serves a chapter page, drafts included', async () => {
    const { base, root } = await serveBook()
    const response = await fetch(`${base}${PANEL_PREFIX}/entry?kind=chapter&key=1&root=${encodeURIComponent(root)}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { title: string; chip: string; lists: Array<{ label: string; items: string[] }> } }
    expect(body.data.title).toBe('第1章 裂缝')
    expect(body.data.chip).toBe('已完成')
    expect(body.data.lists.find((list) => list.label === '必写节拍')?.items).toEqual(['发现尸体', '改航向'])
  })

  it('answers 404 for a row the book no longer has', async () => {
    const { base, root } = await serveBook()
    const response = await fetch(
      `${base}${PANEL_PREFIX}/entry?kind=character&key=${encodeURIComponent('闻莺')}&root=${encodeURIComponent(root)}`,
    )
    expect(response.status).toBe(404)
    const body = (await response.json()) as { ok: boolean; error: { message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.message).toContain('刷新')
  })

  it('rejects an unknown kind and a missing key with 400', async () => {
    const { base } = await serveBook()
    const unknown = await fetch(`${base}${PANEL_PREFIX}/entry?kind=creature&key=x`)
    expect(unknown.status).toBe(400)
    const missing = await fetch(`${base}${PANEL_PREFIX}/entry?kind=character`)
    expect(missing.status).toBe(400)
  })

  it('takes only GET and POST', async () => {
    const { base } = await serveBook()
    const response = await fetch(`${base}${PANEL_PREFIX}/entry?kind=character&key=x`, {
      method: 'PUT',
      headers: { [PANEL_HEADER]: PANEL_HEADER_VALUE },
    })
    expect(response.status).toBe(405)
  })

  it('writes a character back through the same store the tools use', async () => {
    const { base, root } = await serveBook()
    const response = await post(`${base}${PANEL_PREFIX}/entry?root=${encodeURIComponent(root)}`, {
      kind: 'character',
      key: '沈砚',
      fields: { voice: '长句，爱绕弯', goal: '把货单烧掉', role: 'antagonist' },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; data: { chip: string; fields: Array<{ label: string; value: string }> } }
    expect(body.ok).toBe(true)
    expect(body.data.chip).toBe('反派')
    expect(body.data.fields.find((field) => field.label === '说话方式')?.value).toBe('长句，爱绕弯')
    const stored = await new ProjectStore(root).characters()
    expect(stored[0]?.voice).toBe('长句，爱绕弯')
    expect(stored[0]?.role).toBe('antagonist')
    expect(stored[0]?.name).toBe('沈砚')
  })

  it('writes a world entry', async () => {
    const { base, root } = await serveBook()
    const response = await post(`${base}${PANEL_PREFIX}/entry?root=${encodeURIComponent(root)}`, {
      kind: 'world',
      key: '雾港',
      fields: { kind: '势力', detail: '整座港口只有一家还开着的秤房' },
    })
    expect(response.status).toBe(200)
    const stored = await new ProjectStore(root).world()
    expect(stored[0]?.kind).toBe('势力')
    expect(stored[0]?.detail).toBe('整座港口只有一家还开着的秤房')
  })

  it('writes a chapter body and re-derives its word count', async () => {
    const { base, root } = await serveBook()
    const text = '沈砚把货单折好塞回怀里，灯焰歪了一下。'
    const response = await post(`${base}${PANEL_PREFIX}/entry?root=${encodeURIComponent(root)}`, {
      kind: 'chapter',
      key: '1',
      fields: { title: '改过的标题', text },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { title: string; edit: { body: { value: string } } } }
    expect(body.data.title).toBe('第1章 改过的标题')
    // A chapter file keeps one trailing newline; the page shows the file as it is.
    expect(body.data.edit.body.value.trim()).toBe(text)
    const stored = await new ProjectStore(root).chapter(1)
    expect(stored?.text.trim()).toBe(text)
    expect(stored?.words).toBe(text.replace(/\s/g, '').length)
  })

  it('refuses a chapter body that breaks the chapter outline contract', async () => {
    const { base, root } = await serveBook()
    const store = new ProjectStore(root)
    const before = await store.chapter(1)
    const response = await post(`${base}${PANEL_PREFIX}/entry?root=${encodeURIComponent(root)}`, {
      kind: 'chapter',
      key: '1',
      fields: { text: '风很大。灯灭了。' },
    })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { ok: boolean; error: { message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.message).toContain('沈砚')
    const after = await store.chapter(1)
    expect(after?.text).toBe(before?.text)
  })

  it('refuses a chapter whose plan is not approved yet', async () => {
    const { base, root } = await serveBook()
    const store = new ProjectStore(root)
    await store.upsertPlan({
      number: 2,
      volume: 1,
      title: '过秤',
      pov: '沈砚',
      characters: ['沈砚'],
      beats: ['过秤', '发现缺口'],
      hooks: ['秤房的账'],
      approved: false,
    })
    const response = await post(`${base}${PANEL_PREFIX}/entry?root=${encodeURIComponent(root)}`, {
      kind: 'chapter',
      key: '2',
      fields: { text: '沈砚走进秤房。' },
    })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain('批准')
    expect(await store.chapter(2)).toBeUndefined()
  })

  it('rejects an unknown role and an empty body', async () => {
    const { base, root } = await serveBook()
    const badRole = await post(`${base}${PANEL_PREFIX}/entry?root=${encodeURIComponent(root)}`, {
      kind: 'character',
      key: '沈砚',
      fields: { role: 'narrator' },
    })
    expect(badRole.status).toBe(400)
    const empty = await post(`${base}${PANEL_PREFIX}/entry?root=${encodeURIComponent(root)}`, {
      kind: 'chapter',
      key: '1',
      fields: { text: '   ' },
    })
    expect(empty.status).toBe(400)
  })

  it('refuses an edit without the plugin header', async () => {
    const { base, root } = await serveBook()
    const response = await fetch(`${base}${PANEL_PREFIX}/entry?root=${encodeURIComponent(root)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'character', key: '沈砚', fields: { voice: 'x' } }),
    })
    expect(response.status).toBe(403)
    const stored = await new ProjectStore(root).characters()
    expect(stored[0]?.voice).toBe('短句，问句多')
  })

  /**
   * Post a JSON body the way the panel does, header included.
   *
   * @param url - the full route URL.
   * @param body - the JSON payload.
   * @returns the response, unread.
   */
  function post(url: string, body: unknown): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
      body: JSON.stringify(body),
    })
  }
})
