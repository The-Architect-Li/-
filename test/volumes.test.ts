/**
 * Volumes: which chapters belong to one, and the two ways to say so.
 *
 * The pure half (the arithmetic) is tested without a book; the route half goes
 * through HTTP because the parts worth guarding are the ones the route enforces
 * — a positive volume number, a real `perVolume`, and an unconditional "no
 * chapter is ever deleted by resplitting".
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/domain/store.ts'
import { membershipOf, shellPlan, splitRuns } from '../src/domain/volumes.ts'
import { PANEL_HEADER, PANEL_HEADER_VALUE, PANEL_PREFIX } from '../src/panel/serve.ts'
import { createHarness, type Harness } from './helpers.ts'

describe('volume arithmetic', () => {
  it('cuts a run into fixed-size volumes and leaves the last one short', () => {
    expect(splitRuns([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7],
    ])
  })

  it('refuses a size that is not a positive whole number', () => {
    expect(() => splitRuns([1, 2], 0)).toThrow(RangeError)
    expect(() => splitRuns([1, 2], 1.5)).toThrow(RangeError)
  })

  it('treats volume zero as no volume at all', () => {
    const plans = [
      shellPlan(1, 1, undefined),
      shellPlan(2, 0, undefined),
      shellPlan(3, 1, undefined),
    ]
    const membership = membershipOf(plans, [1, 2, 3])
    expect(membership.byVolume.get(1)).toEqual([1, 3])
    expect(membership.unassigned).toEqual([2])
  })

  it('puts a chapter with no outline in no volume', () => {
    expect(membershipOf([], [7, 8]).unassigned).toEqual([7, 8])
  })

  it('builds a plan that claims nothing but the volume', () => {
    const plan = shellPlan(9, 4, { number: 9, title: '裂缝', words: 10, summary: '', writtenAt: '2026-01-01T00:00:00.000Z' })
    expect(plan.volume).toBe(4)
    expect(plan.title).toBe('裂缝')
    expect(plan.beats).toEqual([])
    expect(plan.approved).toBe(false)
  })
})

describe('panel volume routes', () => {
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
    for (const space of spaces.splice(0)) await rm(space, { recursive: true, force: true })
  })

  /** Mount the plugin and serve its panel route. */
  async function serve(): Promise<{ base: string; space: string }> {
    harness ??= await createHarness({})
    const space = await mkdtemp(join(tmpdir(), 'inkwell-volumes-'))
    spaces.push(space)
    const route = harness.routes.find((candidate) => candidate.path === PANEL_PREFIX)
    if (!route) throw new Error('the plugin registered no panel route')
    const created = createServer((req, res) => void route.handler(req, res))
    server = created
    await new Promise<void>((done) => created.listen(0, '127.0.0.1', () => done()))
    const address = created.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    return { base: `http://127.0.0.1:${address.port}`, space }
  }

  /** GET one panel path. */
  async function get(base: string, path: string): Promise<Response> {
    return fetch(`${base}${PANEL_PREFIX}${path}`)
  }

  /** POST a JSON body to one panel path. */
  async function post(base: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${PANEL_PREFIX}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
      body: JSON.stringify(body),
    })
  }

  /**
   * A book with five written chapters, made through the store.
   *
   * Not through `/import-book`: that route creates a book *inside* the
   * configured root, and a relative root would drop the book next to the
   * repository. A store pointed at a temp directory keeps this test's disk
   * entirely inside its own `mkdtemp`.
   */
  async function book(space: string): Promise<string> {
    const root = join(space, '五章稿', '.novel')
    const store = new ProjectStore(root)
    await store.init('五章稿', 80_000)
    for (const number of [1, 2, 3, 4, 5]) {
      const text = `第${number}章的正文，写了一点东西。`
      await store.writeChapter({ number, title: '测试', words: text.length, summary: '', writtenAt: new Date().toISOString(), text })
    }
    return root
  }

  it('starts with every chapter in no volume', async () => {
    const { base, space } = await serve()
    const root = await book(space)
    const response = await get(base, `/volumes?root=${encodeURIComponent(root)}`)
    const payload = (await response.json()) as {
      data: { volumes: unknown[]; unassigned: number[]; noBook: boolean; report: string }
    }
    expect(payload.data.noBook).toBe(false)
    expect(payload.data.volumes).toEqual([])
    expect(payload.data.unassigned).toEqual([1, 2, 3, 4, 5])
    expect(payload.data.report).toContain('未分卷')
  })

  it('puts the chapters the writer ticked into a new volume', async () => {
    const { base, space } = await serve()
    const root = await book(space)
    const response = await post(base, `/volumes?root=${encodeURIComponent(root)}`, {
      action: 'assign',
      chapters: [1, 2],
      volume: 1,
    })
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      data: { volumes: { number: number; chapters: number[] }[]; created: number[]; report: string }
    }
    expect(payload.data.created).toEqual([1])
    expect(payload.data.volumes).toEqual([{ number: 1, title: '', chapters: [1, 2] }])
    expect(payload.data.report).toContain('第1–2章')
  })

  it('reads the book named in the body, not only the query', async () => {
    const { base, space } = await serve()
    const root = await book(space)
    const response = await post(base, '/volumes', { root, action: 'assign', chapters: [3], volume: 2 })
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { data: { volumes: { number: number; chapters: number[] }[] } }
    expect(payload.data.volumes).toEqual([{ number: 2, title: '', chapters: [3] }])
  })

  it('takes chapters back out of a volume when asked for none', async () => {
    const { base, space } = await serve()
    const root = await book(space)
    await post(base, `/volumes?root=${encodeURIComponent(root)}`, { action: 'assign', chapters: [1, 2], volume: 1 })
    const response = await post(base, `/volumes?root=${encodeURIComponent(root)}`, {
      action: 'assign',
      chapters: [1, 2],
      volume: null,
    })
    const payload = (await response.json()) as { data: { volumes: { chapters: number[] }[]; unassigned: number[] } }
    expect(payload.data.volumes[0]?.chapters).toEqual([])
    expect(payload.data.unassigned).toEqual([1, 2, 3, 4, 5])
  })

  it('resplits the whole book without losing a chapter', async () => {
    const { base, space } = await serve()
    const root = await book(space)
    const response = await post(base, `/volumes?root=${encodeURIComponent(root)}`, { action: 'split', perVolume: 2 })
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      data: { volumes: { number: number; chapters: number[] }[]; unassigned: number[] }
    }
    expect(payload.data.volumes.map((volume) => volume.chapters)).toEqual([[1, 2], [3, 4], [5]])
    expect(payload.data.unassigned).toEqual([])

    const again = await post(base, `/volumes?root=${encodeURIComponent(root)}`, { action: 'split', perVolume: 5 })
    const after = (await again.json()) as { data: { volumes: { chapters: number[] }[] } }
    expect(after.data.volumes[0]?.chapters).toEqual([1, 2, 3, 4, 5])
    // The volumes the first split made are still there: resplitting assigns, it
    // does not delete an outline somebody may have written a summary into.
    expect(after.data.volumes.length).toBe(3)
  })

  it('rejects a volume that is not a positive whole number', async () => {
    const { base, space } = await serve()
    const root = await book(space)
    const response = await post(base, `/volumes?root=${encodeURIComponent(root)}`, {
      action: 'assign',
      chapters: [1],
      volume: 0,
    })
    expect(response.status).toBe(400)
  })

  it('rejects a split size of zero and an unknown action', async () => {
    const { base, space } = await serve()
    const root = await book(space)
    const zero = await post(base, `/volumes?root=${encodeURIComponent(root)}`, { action: 'split', perVolume: 0 })
    expect(zero.status).toBe(400)
    const unknown = await post(base, `/volumes?root=${encodeURIComponent(root)}`, { action: 'whatever' })
    expect(unknown.status).toBe(400)
  })

  it('says so when there is no book yet', async () => {
    const { base } = await serve()
    const root = join(tmpdir(), 'inkwell-volumes-nothing', '.novel')
    const read = await get(base, `/volumes?root=${encodeURIComponent(root)}`)
    const payload = (await read.json()) as { data: { noBook: boolean } }
    expect(payload.data.noBook).toBe(true)
    const write = await post(base, `/volumes?root=${encodeURIComponent(root)}`, { action: 'split', perVolume: 3 })
    expect(write.status).toBe(409)
  })
})
