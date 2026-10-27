/**
 * The panel's backup route: a button that can only ever be an undo.
 *
 * What matters here is that the browser cannot reach past the domain rules — no
 * action outside list/make/restore, no copy that belongs to another book, and a
 * restore that leaves a copy of what it overwrote.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PANEL_HEADER, PANEL_HEADER_VALUE, PANEL_PREFIX } from '../src/panel/serve.ts'
import { listBackups } from '../src/domain/backup.ts'
import { createHarness, type Harness } from './helpers.ts'

describe('panel backup route', () => {
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
    harness ??= await createHarness({ root: '.novel' })
    const space = await mkdtemp(join(tmpdir(), 'inkwell-backup-'))
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

  /** POST a JSON body to one panel path. */
  async function post(base: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${PANEL_PREFIX}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
      body: JSON.stringify(body),
    })
  }

  /** A book with one written chapter, and its root. */
  async function book(base: string, space: string): Promise<string> {
    const dir = join(space, '稿件')
    await mkdir(join(dir, '正文'), { recursive: true })
    await mkdir(join(dir, '大纲'), { recursive: true })
    await writeFile(join(dir, '正文', '第1章-裂缝.md'), '凌晨一点零七分，码头还亮着灯。\n', 'utf8')
    await writeFile(join(dir, '正文', '第2章-金童玉女.md'), '她当年那句话还在耳边。\n', 'utf8')
    await writeFile(join(dir, '大纲', '全书大纲.md'), '> 一句话立意：一个穷小子往上爬。\n', 'utf8')
    const response = await post(base, '/import-book', { dir })
    expect(response.status).toBe(200)
    return ((await response.json()) as { data: { root: string } }).data.root
  }

  it('makes a copy and lists it', async () => {
    const { base, space } = await serve()
    const root = await book(base, space)

    const empty = (await (await post(base, '/backup', { root, action: 'list' })).json()) as {
      data: { backups: unknown[]; dir: string }
    }
    expect(empty.data.backups).toEqual([])
    // Copies live under dsh's own state, never inside the book: a copy inside
    // the book would be carried into the next copy.
    expect(empty.data.dir.startsWith(root)).toBe(false)
    expect(empty.data.dir).toContain('稿件')

    const made = await post(base, '/backup', { root, action: 'make' })
    expect(made.status).toBe(200)
    const body = (await made.json()) as { data: { made: { name: string; files: number } } }
    expect(body.data.made.name).toMatch(/\.zip$/)
    expect(body.data.made.files).toBeGreaterThan(0)

    const listed = (await (await post(base, '/backup', { root, action: 'list' })).json()) as {
      data: { backups: { name: string; line: string }[] }
    }
    expect(listed.data.backups.map((entry) => entry.name)).toContain(body.data.made.name)
    expect(listed.data.backups[0]!.line).toContain('个文件')
  })

  it('restores a copy, and keeps what the copy never knew about', async () => {
    const { base, space } = await serve()
    const root = await book(base, space)
    const made = (await (await post(base, '/backup', { root, action: 'make' })).json()) as {
      data: { made: { name: string } }
    }

    // The writer keeps going: chapter one is rewritten, chapter three is new.
    await writeFile(join(root, 'chapters', '001.md'), '完全改掉的正文。', 'utf8')
    await writeFile(join(root, 'chapters', '003.md'), '新加的一章。', 'utf8')

    const restored = await post(base, '/backup', { root, action: 'restore', name: made.data.made.name })
    expect(restored.status).toBe(200)
    const body = (await restored.json()) as {
      data: { written: string[]; extra: string[]; safety: string }
    }
    expect(body.data.written).toContain('chapters/001.md')
    expect(body.data.extra).toContain('chapters/003.md')
    expect(body.data.safety).toContain('pre-restore-')
    expect((await readFile(join(root, 'chapters', '001.md'), 'utf8')).includes('码头还亮着灯')).toBe(true)
    // The undo copy really exists, next to the history.
    const names = (await listBackups(root)).map((entry) => entry.name)
    expect(names).toContain(body.data.safety)
  })

  it('refuses an action it does not have, and a book that is not there', async () => {
    const { base, space } = await serve()
    const root = await book(base, space)

    const wrong = await post(base, '/backup', { root, action: 'delete-everything' })
    expect(wrong.status).toBe(400)
    expect(((await wrong.json()) as { error: { message: string } }).error.message).toContain('list／make／restore')

    const missing = await post(base, '/backup', { root: join(space, 'nope', '.novel'), action: 'list' })
    expect(missing.status).toBe(404)

    const unnamed = await post(base, '/backup', { root, action: 'restore' })
    expect(unnamed.status).toBe(400)
  })
})
