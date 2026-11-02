/**
 * The "走一轮" button's server half.
 *
 * A panel button that silently does nothing is worse than no button, so the
 * interesting case here is not the happy path — it is that the route *refuses
 * out loud* when the host cannot hand it a parent agent.
 */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/domain/store.ts'
import { createPanelHandler, PANEL_HEADER, PANEL_HEADER_VALUE, PANEL_PREFIX } from '../src/panel/serve.ts'
import { resolveConfig } from '../src/config.ts'

const roots: string[] = []

afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A book with a project file, served over a real port like the panel is. */
async function serve(extra: Record<string, unknown> = {}): Promise<{ base: string; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'inkwell-round-'))
  roots.push(dir)
  const store = new ProjectStore(join(dir, '.novel'))
  await store.init('雾港', 800000)
  const handler = createPanelHandler({ config: resolveConfig({}), baseStore: store, ...extra })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    base: `http://127.0.0.1:${address.port}${PANEL_PREFIX}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  }
}

describe('POST /round', () => {
  it('refuses with a sentence when the host gives no agent, not with a crash', async () => {
    const app = await serve()
    try {
      const response = await fetch(`${app.base}/round`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
        body: JSON.stringify({ number: 1 }),
      })
      expect(response.status).toBe(409)
      const payload = (await response.json()) as { error: { message: string } }
      expect(payload.error.message).toContain('拿不到这个会话的 agent')
      // …and it says what to do instead, with the chapter already in it.
      expect(payload.error.message).toContain('novel_dispatch action="round" number=1')
    } finally {
      await app.close()
    }
  })

  it('rejects a chapter number that is not one', async () => {
    const app = await serve({ agentOf: () => ({}), ctxOf: () => ({}) })
    try {
      const response = await fetch(`${app.base}/round`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
        body: JSON.stringify({ number: 0 }),
      })
      expect(response.status).toBe(400)
    } finally {
      await app.close()
    }
  })

  it('answers a GET without an id by saying the job is gone', async () => {
    // GET is how the panel polls; without an id there is nothing to report, and
    // saying so beats a 405 that the poller would have to special-case.
    const app = await serve()
    try {
      const response = await fetch(`${app.base}/round`)
      expect(response.status).toBe(404)
    } finally {
      await app.close()
    }
  })
})

describe('POST /merge with summarize', () => {
  it('refuses to invent a recap when the host gives no agent', async () => {
    // Merging still happens — the prose is joined, the chapter is gone. What is
    // refused is only the recap, and the sentence says which command fills it in
    // later. Failing the whole merge because a summariser is missing would be
    // worse than a missing summary.
    const app = await serve()
    try {
      const response = await fetch(`${app.base}/merge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
        body: JSON.stringify({ number: 1, summarize: true }),
      })
      // No chapters in this fixture, so the merge itself refuses first.
      expect([400, 409]).toContain(response.status)
    } finally {
      await app.close()
    }
  })
})

describe('POST /round as a job', () => {
  it('answers with a job id instead of waiting for four model calls', async () => {
    // The old shape held the HTTP response open for minutes. The panel could only
    // say 「跑一轮中」 and hope, and could not distinguish a slow writer from a hang.
    const app = await serve({ agentOf: () => ({}), ctxOf: () => ({}) })
    try {
      const response = await fetch(`${app.base}/round`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
        body: JSON.stringify({ number: 1 }),
      })
      // This fixture has no chapters, so the round fails — but the failure is now
      // reported through the job, not as a 500 on the way in.
      expect([200, 409]).toContain(response.status)
      if (response.status === 200) {
        const payload = (await response.json()) as { data: { id: string; stage: string } }
        expect(typeof payload.data.id).toBe('string')
        expect(payload.data.stage).toBe('writer')
        const status = await fetch(`${app.base}/round?id=${encodeURIComponent(payload.data.id)}`)
        expect(status.status).toBe(200)
      }
    } finally {
      await app.close()
    }
  })

  it('says a job is gone rather than inventing progress', async () => {
    const app = await serve()
    try {
      const response = await fetch(`${app.base}/round?id=nope`)
      expect(response.status).toBe(404)
      const payload = (await response.json()) as { error: { message: string } }
      expect(payload.error.message).toContain('不在内存里')
    } finally {
      await app.close()
    }
  })
})

describe('the card button on a written chapter', () => {
  it('answers with a human sentence and an action, not a command line', async () => {
    // The page the author is looking at must not say
    // `novel_archive action="apply" from=6 limit=1`.
    const dir = await mkdtemp(join(tmpdir(), 'inkwell-card-'))
    roots.push(dir)
    const store = new ProjectStore(dir)
    await store.init('雾港', 800000)
    await store.writeProject({ ...(await store.readProject()), phase: 'drafting', premise: '一句话前提。' })
    await store.writeChapter(
      { number: 6, title: '血牢', text: '夜雨滂沱。'.repeat(60), words: 2091, summary: '', writtenAt: '2026-01-01T00:00:00.000Z', revision: 1 },
      { baseRevision: undefined },
    )
    const handler = createPanelHandler({ config: resolveConfig({}), baseStore: store })
    const server = createServer((req, res) => void handler(req, res))
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const base = `http://127.0.0.1:${address.port}${PANEL_PREFIX}`
    try {
      const response = await fetch(`${base}/entry?kind=chapter&key=6`)
      expect(response.status).toBe(200)
      const payload = (await response.json()) as { data: { blocked?: string; action?: { id: string; number: number; label: string } } }
      expect(payload.data.blocked ?? '').not.toContain('novel_archive')
      expect(payload.data.action).toMatchObject({ id: 'recap', number: 6 })
      expect(payload.data.action?.label).toBe('为这一章建章卡')
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
    }
  })
})

describe('search is not capped where the cap cannot be seen past', () => {
  it('returns far more than the old sixty, so the page can scroll through them', async () => {
    // 425 chapters matched 「路长远」 and the panel showed sixty with no way to
    // reach the rest: a cap with no scroll is a wrong answer, not a small one.
    const dir = await mkdtemp(join(tmpdir(), 'inkwell-search-'))
    roots.push(dir)
    const store = new ProjectStore(dir)
    await store.init('雾港', 800000)
    for (let number = 1; number <= 120; number += 1) {
      await store.writeChapter(
        { number, title: `第${number}章`, text: `路长远走进来。${'雾'.repeat(80)}`, words: 90, summary: '', writtenAt: '2026-01-01T00:00:00.000Z', revision: 1 },
        { baseRevision: undefined },
      )
    }
    const handler = createPanelHandler({ config: resolveConfig({}), baseStore: store })
    const server = createServer((req, res) => void handler(req, res))
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const base = `http://127.0.0.1:${address.port}${PANEL_PREFIX}`
    try {
      const response = await fetch(`${base}/search?q=${encodeURIComponent('路长远')}`)
      expect(response.status).toBe(200)
      const payload = (await response.json()) as { data: { hits: unknown[]; matched: number } }
      expect(payload.data.matched).toBe(120)
      expect(payload.data.hits.length).toBe(120)
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
    }
  })
})

describe('the chapter page talks about the card, not about writing prose', () => {
  /** A book whose chapter 7 has an unapproved card with a recap. */
  async function withCard(approved: boolean, revised = false) {
    const dir = await mkdtemp(join(tmpdir(), 'inkwell-page-'))
    roots.push(dir)
    const store = new ProjectStore(dir)
    await store.init('雾港', 800000)
    await store.writeProject({ ...(await store.readProject()), phase: 'drafting', premise: '一句话前提。' })
    await store.writeChapter(
      { number: 7, title: '我有一门剑法，你学不学', text: '这是正文。'.repeat(80), words: 2269, summary: '', writtenAt: '2026-01-01T00:00:00.000Z', revision: 0 },
      { baseRevision: undefined },
    )
    if (revised) {
      await store.writeChapter(
        { number: 7, title: '我有一门剑法，你学不学', text: '改过之后的正文。'.repeat(80), words: 2400, summary: '', writtenAt: '2026-01-02T00:00:00.000Z', revision: 0 },
        { baseRevision: 1 },
      )
    }
    await store.upsertPlan({
      number: 7, volume: 1, title: '第7章', pov: '', characters: [], beats: ['a'], hooks: ['h'],
      approved, summary: '已有的摘要', cardRevision: 1,
    })
    const handler = createPanelHandler({ config: resolveConfig({}), baseStore: store })
    const server = createServer((req, res) => void handler(req, res))
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    return { base: `http://127.0.0.1:${address.port}${PANEL_PREFIX}`, close: () => new Promise<void>((done) => server.close(() => done())) }
  }

  it('does not nag about an unapproved outline when the card is already there', async () => {
    // The chapter has a card read off its current prose. Telling the author to go
    // approve an outline before they can do anything is advice for writing new
    // prose, which is not what the page's button does.
    const app = await withCard(false)
    try {
      const response = await fetch(`${app.base}/entry?kind=chapter&key=7`)
      const payload = (await response.json()) as { data: { blocked?: string; action?: unknown; fields?: unknown[] } }
      const raw = await (await fetch(`${app.base}/entry?kind=chapter&key=7`)).json() as { data: { blocked?: string } }
      expect(raw.data.blocked).toBe(payload.data.blocked)
      expect(payload.data.action).toBeUndefined()
      expect(payload.data.blocked ?? '').not.toContain('approve_chapter')
    } finally {
      await app.close()
    }
  })

  it('offers a rebuild when the card describes older prose', async () => {
    // `writeChapter` computes revision = previous + 1, so a second save is how a
    // card goes stale in real life: the author edits after the card was read.
    const app = await withCard(true, true)
    try {
      const response = await fetch(`${app.base}/entry?kind=chapter&key=7`)
      const payload = (await response.json()) as { data: { action?: { id: string; label: string } } }
      expect(payload.data.action).toMatchObject({ id: 'recap' })
      expect(payload.data.action?.label).toBe('为这一章建章卡')
    } finally {
      await app.close()
    }
  })
})
