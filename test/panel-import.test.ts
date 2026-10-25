/**
 * The import routes: what the create dialog asks, and what it does.
 *
 * These go through the real HTTP route rather than the handler function, because
 * the parts worth guarding are the ones the route enforces: the CSRF header on a
 * write, absolute paths only, and a 409 when there is no book to import into.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PANEL_HEADER, PANEL_HEADER_VALUE, PANEL_PREFIX } from '../src/panel/serve.ts'
import { createHarness, type Harness } from './helpers.ts'

describe('panel import routes', () => {
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

  /** Mount the plugin over a relative root and serve its panel route. */
  async function serve(): Promise<{ base: string; space: string }> {
    harness ??= await createHarness({ root: '.novel' })
    const space = await mkdtemp(join(tmpdir(), 'inkwell-import-'))
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

  /** A manuscript folder with two chapters, one character file, and an outline. */
  async function manuscript(space: string): Promise<string> {
    const dir = join(space, '稿件')
    await mkdir(join(dir, '正文'), { recursive: true })
    await mkdir(join(dir, '人物'), { recursive: true })
    await mkdir(join(dir, '大纲'), { recursive: true })
    await writeFile(join(dir, '正文', '第1章-裂缝.md'), '凌晨一点零七分，码头还亮着灯。\n', 'utf8')
    await writeFile(join(dir, '正文', '第2章-金童玉女.md'), '她当年那句话还在耳边。\n', 'utf8')
    await writeFile(join(dir, '人物', '王上.md'), '# 王上\n\n## 外在底色\n- 外形：微胖\n', 'utf8')
    await writeFile(join(dir, '大纲', '全书大纲.md'), '> 一句话立意：一个穷小子往上爬。\n', 'utf8')
    return dir
  }

  it('scans a folder and writes nothing', async () => {
    const { base, space } = await serve()
    const dir = await manuscript(space)
    const response = await fetch(`${base}${PANEL_PREFIX}/scan?dir=${encodeURIComponent(dir)}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      data: { chapters: number; cast: number; words: number; premise: string; report: string; bookRoot: string | null; conflicts: number[] }
    }
    expect(body.ok).toBe(true)
    expect(body.data.chapters).toBe(2)
    expect(body.data.cast).toBe(1)
    expect(body.data.words).toBeGreaterThan(0)
    expect(body.data.premise).toBe('一个穷小子往上爬。')
    expect(body.data.report).toContain('还没写任何文件')
    // Whether a book was found depends on the machine the checkout runs on, so
    // only the shape is asserted: the field is a path or null, never absent.
    expect(body.data.bookRoot === null || typeof body.data.bookRoot === 'string').toBe(true)
  })

  it('refuses a relative or missing directory', async () => {
    const { base } = await serve()
    const relative = await fetch(`${base}${PANEL_PREFIX}/scan?dir=../somewhere`)
    expect(relative.status).toBe(400)
    const missing = await fetch(`${base}${PANEL_PREFIX}/scan`)
    expect(missing.status).toBe(400)
  })

  it('needs the plugin header to import', async () => {
    const { base, space } = await serve()
    const dir = await manuscript(space)
    const response = await fetch(`${base}${PANEL_PREFIX}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir }),
    })
    expect(response.status).toBe(403)
  })

  it('imports into the book the create route made', async () => {
    const { base, space } = await serve()
    const dir = await manuscript(space)
    const created = await fetch(`${base}${PANEL_PREFIX}/init`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
      body: JSON.stringify({ dir: space, title: '待定' }),
    })
    const book = (await created.json()) as { data: { root: string } }

    const response = await fetch(
      `${base}${PANEL_PREFIX}/import?root=${encodeURIComponent(book.data.root)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
        body: JSON.stringify({ dir }),
      },
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: { written: number; skipped: number; cast: number; words: number }
    }
    expect(body.data).toMatchObject({ written: 2, skipped: 0, cast: 1 })

    const first = await readFile(join(book.data.root, 'chapters', '001.md'), 'utf8')
    expect(first).toContain('凌晨一点零七分')
    const project = JSON.parse(await readFile(join(book.data.root, 'project.json'), 'utf8'))
    expect(project.premise).toBe('一个穷小子往上爬。')

    // Importing again is the safe, expected way to pick up new chapters.
    const again = await fetch(
      `${base}${PANEL_PREFIX}/import?root=${encodeURIComponent(book.data.root)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
        body: JSON.stringify({ dir }),
      },
    )
    const repeated = (await again.json()) as { data: { written: number; skipped: number } }
    expect(repeated.data).toMatchObject({ written: 0, skipped: 2 })
  })

  it('answers 409 when there is no book to import into', async () => {
    const { base, space } = await serve()
    const dir = await manuscript(space)
    const empty = join(space, '没有书')
    await mkdir(empty)
    const response = await fetch(
      `${base}${PANEL_PREFIX}/import?root=${encodeURIComponent(join(empty, '.novel'))}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
        body: JSON.stringify({ dir }),
      },
    )
    expect(response.status).toBe(409)
  })

  /** A folder holding one long txt instead of one file per chapter. */
  async function singleFile(space: string): Promise<string> {
    const dir = join(space, '单文件')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, '待定.txt'),
      ['第一章 裂缝', '', '雨落了一夜。', '', '第二章 金童玉女', '', '她当年那句话还在耳边。'].join('\n'),
      'utf8',
    )
    return dir
  }

  it('creates the book from the folder in one call, txt included', async () => {
    const { base, space } = await serve()
    const dir = await singleFile(space)
    const response = await fetch(`${base}${PANEL_PREFIX}/import-book`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
      body: JSON.stringify({ dir }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: {
        root: string
        title: string
        existing: boolean
        written: number
        phase?: string
        report: string
      }
    }
    expect(body.data.existing).toBe(false)
    expect(body.data.title).toBe('单文件')
    expect(body.data.written).toBe(2)
    expect(body.data.phase).toBe('drafting')
    const first = await readFile(join(body.data.root, 'chapters', '001.md'), 'utf8')
    expect(first).toContain('雨落了一夜。')
    expect(body.data.report).toContain('还没写任何文件')
  })

  it('refuses a folder with no numbered prose', async () => {
    const { base, space } = await serve()
    const dir = join(space, '空稿')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '随手记.md'), '这里没有章号。', 'utf8')
    const response = await fetch(`${base}${PANEL_PREFIX}/import-book`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
      body: JSON.stringify({ dir }),
    })
    expect(response.status).toBe(422)
  })
})
