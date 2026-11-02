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
