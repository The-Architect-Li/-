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
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { ProjectStore } from '../src/domain/store.ts'
import type { ChapterPlan, DraftRound, LedgerEntry, Snapshot } from '../src/domain/types.ts'
import { buildPanelSnapshot, emptyPanelSnapshot } from '../src/panel/model.ts'
import { PANEL_HEADER, PANEL_HEADER_VALUE, PANEL_PREFIX, readPanel } from '../src/panel/serve.ts'
import { createHarness, type Harness } from './helpers.ts'

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
