/**
 * The pin route: bind one chat session to one book.
 *
 * `POST /api/inkwell/pin` is what the create flow calls after it opens a chat
 * session in the folder the writer picked. It writes the same binding
 * `novel_project action="open"` writes, so the two paths cannot disagree.
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/domain/store.ts'
import { pinnedRoot, sessionsFile } from '../src/domain/session-books.ts'
import { PANEL_HEADER, PANEL_HEADER_VALUE, PANEL_PREFIX } from '../src/panel/serve.ts'
import { createHarness, type Harness } from './helpers.ts'

describe('panel pin route', () => {
  let server: Server | undefined
  let harness: Harness | undefined
  let space: string | undefined
  let stateHome: string | undefined
  const savedHome = process.env.DSH_HOME

  afterAll(() => {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
  })

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
    if (stateHome) await rm(stateHome, { recursive: true, force: true })
    stateHome = undefined
  })

  /** Mount the panel over a temporary book and a temporary state directory. */
  async function serve(): Promise<{ base: string; root: string; dir: string }> {
    stateHome ??= await mkdtemp(join(tmpdir(), 'inkwell-pin-home-'))
    process.env.DSH_HOME = stateHome
    space ??= await mkdtemp(join(tmpdir(), 'inkwell-pin-'))
    const root = join(space, '.novel')
    await new ProjectStore(root).init('雾港', 0)
    harness ??= await createHarness({ root })
    const route = harness.routes.find((candidate) => candidate.path === PANEL_PREFIX)
    if (!route) throw new Error('the plugin registered no panel route')
    const created = createServer((req, res) => void route.handler(req, res))
    server = created
    await new Promise<void>((done) => created.listen(0, '127.0.0.1', () => done()))
    const address = created.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    return { base: `http://127.0.0.1:${address.port}`, root, dir: space }
  }

  it('refuses a pin without the plugin header', async () => {
    const { base, root } = await serve()
    const response = await fetch(`${base}${PANEL_PREFIX}/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: 's-1', root }),
    })
    expect(response.status).toBe(403)
  })

  it('binds the session it is given', async () => {
    const { base, root } = await serve()
    const response = await fetch(`${base}${PANEL_PREFIX}/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
      body: JSON.stringify({ session: 's-new', root }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; data: { session: string; root: string } }
    expect(body.data.session).toBe('s-new')
    expect(pinnedRoot(sessionsFile(), 's-new')).toBe(root)
  })

  it('rejects a relative root rather than resolving it host-side', async () => {
    const { base } = await serve()
    const response = await fetch(`${base}${PANEL_PREFIX}/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
      body: JSON.stringify({ session: 's-1', root: '.novel' }),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain('绝对路径')
  })

  it('rejects a directory that holds no book', async () => {
    const { base, dir } = await serve()
    const response = await fetch(`${base}${PANEL_PREFIX}/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
      body: JSON.stringify({ session: 's-1', root: dir }),
    })
    expect(response.status).toBe(404)
  })

  it('makes the panel read the pinned book for that session', async () => {
    const { base, root } = await serve()
    const pin = await fetch(`${base}${PANEL_PREFIX}/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
      body: JSON.stringify({ session: 's-pinned', root }),
    })
    expect(pin.status).toBe(200)
    // No `root` query parameter: the session alone has to find the book, which is
    // the half the create flow relies on when the new tab mounts.
    const snapshot = await fetch(`${base}${PANEL_PREFIX}/snapshot?session=s-pinned`)
    expect(snapshot.status).toBe(200)
    const body = (await snapshot.json()) as { ok: boolean; data: { root: string; title: string } }
    expect(body.data.root).toBe(root)
    expect(body.data.title).toBe('雾港')
  })

  it('rejects a pin with no session id', async () => {    const { base, root } = await serve()
    const response = await fetch(`${base}${PANEL_PREFIX}/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
      body: JSON.stringify({ root }),
    })
    expect(response.status).toBe(400)
  })

  it('answers 405 to a GET', async () => {
    const { base } = await serve()
    const response = await fetch(`${base}${PANEL_PREFIX}/pin`)
    expect(response.status).toBe(405)
  })
})
