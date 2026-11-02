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

  it('is not reachable by GET', async () => {
    const app = await serve()
    try {
      const response = await fetch(`${app.base}/round?number=1`)
      expect(response.status).toBe(405)
    } finally {
      await app.close()
    }
  })
})
