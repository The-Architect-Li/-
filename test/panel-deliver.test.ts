/**
 * The two shelf verbs that act on a book instead of opening it: export and delete.
 *
 * Both go through the HTTP routes, because the parts worth guarding are the ones
 * the route enforces: absolute paths only, a refusal to export a book with no
 * prose, and a delete that will not touch anything not ending in `.novel`.
 */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PANEL_HEADER, PANEL_HEADER_VALUE, PANEL_PREFIX } from '../src/panel/serve.ts'
import { createHarness, type Harness } from './helpers.ts'

describe('panel export and delete routes', () => {
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
    const space = await mkdtemp(join(tmpdir(), 'inkwell-deliver-'))
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

  /** A manuscript folder with two chapters and an outline. */
  async function manuscript(space: string): Promise<string> {
    const dir = join(space, '稿件')
    await mkdir(join(dir, '正文'), { recursive: true })
    await mkdir(join(dir, '大纲'), { recursive: true })
    await writeFile(join(dir, '正文', '第1章-裂缝.md'), '凌晨一点零七分，码头还亮着灯。\n', 'utf8')
    await writeFile(join(dir, '正文', '第2章-金童玉女.md'), '她当年那句话还在耳边。\n', 'utf8')
    await writeFile(join(dir, '大纲', '全书大纲.md'), '> 一句话立意：一个穷小子往上爬。\n', 'utf8')
    return dir
  }

  /** Create a book from a manuscript folder and return its root. */
  async function book(base: string, space: string): Promise<string> {
    const dir = await manuscript(space)
    const response = await post(base, '/import-book', { dir })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { root: string } }
    return body.data.root
  }

  it('writes a whole-book txt into the folder the writer picked', async () => {
    const { base, space } = await serve()
    const root = await book(base, space)
    const out = join(space, '导出')
    const response = await post(base, '/export', { root, dir: out, format: 'txt' })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: { dir: string; files: string[]; chapters: number; words: number }
    }
    expect(body.data.chapters).toBe(2)
    expect(body.data.files).toHaveLength(1)
    const text = await readFile(body.data.files[0] ?? '', 'utf8')
    expect(text).toContain('码头还亮着灯')
    expect(text).toContain('第1章')
    expect(body.data.words).toBeGreaterThan(0)
  })

  it('writes one markdown file per volume', async () => {
    const { base, space } = await serve()
    const root = await book(base, space)
    const out = join(space, '按卷')
    const response = await post(base, '/export', { root, dir: out, format: 'markdown' })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { files: string[] } }
    expect(body.data.files.length).toBeGreaterThan(0)
    expect(body.data.files.every((path) => path.endsWith('.md'))).toBe(true)
  })

  it('refuses a relative export folder', async () => {
    const { base, space } = await serve()
    const root = await book(base, space)
    const response = await post(base, '/export', { root, dir: '导出', format: 'txt' })
    expect(response.status).toBe(400)
  })

  it('refuses to export a book with no prose yet', async () => {
    const { base, space } = await serve()
    const empty = join(space, '空的')
    await mkdir(empty, { recursive: true })
    const created = await post(base, '/init', { dir: empty, title: '空书' })
    expect(created.status).toBe(200)
    const body = (await created.json()) as { data: { root: string } }
    const response = await post(base, '/export', { root: body.data.root, dir: join(space, '出'), format: 'txt' })
    expect(response.status).toBe(409)
  })

  it('deletes the book directory and drops it from the shelf', async () => {
    const { base, space } = await serve()
    const root = await book(base, space)
    const before = (await (await fetch(`${base}${PANEL_PREFIX}/books`)).json()) as {
      data: { books: { root: string }[] }
    }
    expect(before.data.books.some((entry) => entry.root === root)).toBe(true)
    const response = await post(base, '/delete-book', { root })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { root: string; title: string } }
    expect(body.data.root).toBe(root)
    await expect(access(root)).rejects.toThrow()
    const after = (await (await fetch(`${base}${PANEL_PREFIX}/books`)).json()) as {
      data: { books: { root: string }[] }
    }
    expect(after.data.books.some((entry) => entry.root === root)).toBe(false)
  })

  it('leaves the manuscript folder alone when it deletes the book', async () => {
    const { base, space } = await serve()
    const root = await book(base, space)
    const response = await post(base, '/delete-book', { root })
    expect(response.status).toBe(200)
    const manuscriptDir = join(space, '稿件')
    await expect(access(join(manuscriptDir, '正文', '第1章-裂缝.md'))).resolves.toBeUndefined()
  })

  it('refuses to delete a directory that is not a book', async () => {
    const { base, space } = await serve()
    const manuscriptDir = await manuscript(space)
    const response = await post(base, '/delete-book', { root: manuscriptDir })
    expect(response.status).toBe(400)
    await expect(access(join(manuscriptDir, '正文', '第1章-裂缝.md'))).resolves.toBeUndefined()
  })

  it('answers 404 for a book that is already gone', async () => {
    const { base, space } = await serve()
    const response = await post(base, '/delete-book', { root: join(space, '没这本书', '.novel') })
    expect(response.status).toBe(404)
  })
})
