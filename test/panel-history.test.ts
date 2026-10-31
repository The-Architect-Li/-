/**
 * The panel's recovery and briefing routes: one file's versions, and the
 * writer's brief as text.
 *
 * These are the three things the author asked for in the panel and could only
 * get from the conversation before: see a note, go back to a version, read the
 * card the writer would receive.
 */
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { PANEL_HEADER, PANEL_HEADER_VALUE, PANEL_PREFIX } from '../src/panel/serve.ts'
import { createHarness, valueOf, type Harness } from './helpers.ts'

let server: Server | undefined
let harness: Harness | undefined

afterEach(async () => {
  server?.close()
  server = undefined
  if (harness) {
    await harness.cleanup()
    harness = undefined
  }
})

async function book(): Promise<string> {
  harness = await createHarness()
  valueOf(await harness.call('novel_project', { action: 'init', title: '雾港' }))
  const route = harness.routes.find((entry) => entry.path === PANEL_PREFIX)
  if (route === undefined) throw new Error('no panel route')
  const created = createServer((req, res) => void route.handler(req, res))
  server = created
  await new Promise<void>((done) => created.listen(0, '127.0.0.1', () => done()))
  const address = created.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}${PANEL_PREFIX}`
}

function write(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
    body: JSON.stringify(body),
  })
}

describe('a skill note as a page', () => {
  it('is written and read back through the panel routes', async () => {
    const base = await book()
    const saved = await write(base, '/entry', { kind: 'skill', key: '开篇钩子', text: '# 开篇钩子\n\n第一句要有问题。' })
    expect(saved.status).toBe(200)
    const payload = (await saved.json()) as { data: { title: string; edit: { body: { value: string } } } }
    expect(payload.data.title).toBe('开篇钩子')
    expect(payload.data.edit.body.value).toContain('第一句要有问题')

    const read = await fetch(`${base}/entry?kind=skill&key=${encodeURIComponent('开篇钩子')}`)
    const again = (await read.json()) as { data: { title: string } }
    expect(again.data.title).toBe('开篇钩子')
  })

  it('shows up in the tree as its own drawer', async () => {
    const base = await book()
    await write(base, '/entry', { kind: 'skill', key: '节奏', text: '# 节奏\n\n三段一个转折。' })
    const snapshot = (await (await fetch(`${base}/snapshot`)).json()) as {
      data: { sections: Array<{ id: string; count: number }>; skillCount: number }
    }
    expect(snapshot.data.skillCount).toBe(1)
    const skills = snapshot.data.sections.find((section) => section.id === 'skills')
    expect(skills?.count).toBe(1)
  })
})

describe('one file history', () => {
  it('lists versions and puts one back', async () => {
    const base = await book()
    await write(base, '/entry', { kind: 'skill', key: '对话', text: '# 对话\n\n不写「说道」。' })
    await write(base, '/entry', { kind: 'skill', key: '对话', text: '# 对话\n\n长短句交替。' })

    const listed = (await (await fetch(`${base}/history?target=${encodeURIComponent('skill:对话')}`)).json()) as {
      data: { entries: Array<{ rev: string }> }
    }
    expect(listed.data.entries).toHaveLength(1)

    const reverted = await write(base, '/revert', { target: 'skill:对话', rev: listed.data.entries[0]!.rev })
    expect(reverted.status).toBe(200)
    const page = (await (await fetch(`${base}/entry?kind=skill&key=${encodeURIComponent('对话')}`)).json()) as {
      data: { edit: { body: { value: string } } }
    }
    expect(page.data.edit.body.value).toContain('不写「说道」')
  })

  it('says why it cannot answer for a target it does not understand', async () => {
    const base = await book()
    const response = await fetch(`${base}/history?target=outline:volumes`)
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error: { message: string } }
    expect(payload.error.message).toContain('不认识的类别')
  })
})

describe('the writer brief', () => {
  it('refuses before there is an outline, with the reason', async () => {
    const base = await book()
    const response = await write(base, '/card', { number: 1 })
    expect(response.status).toBe(409)
    const payload = (await response.json()) as { error: { message: string } }
    expect(payload.error.message).toContain('还没有章纲')
  })
})

describe('creating a chapter by hand', () => {
  /** Walk a book to drafting, the shortest legal path the gate accepts. */
  async function drafting(harness: Harness): Promise<void> {
    valueOf(await harness.call('novel_project', { action: 'init', title: '雾港' }))
    valueOf(await harness.call('novel_project', {
      action: 'premise',
      premise: '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。'.repeat(4),
    }))
    valueOf(await harness.call('novel_project', { action: 'advance' }))
    valueOf(await harness.call('novel_canon', { action: 'upsert_character', name: '沈砚', role: 'protagonist', voice: '短句' }))
    valueOf(await harness.call('novel_canon', { action: 'upsert_character', name: '阿鸢', role: 'supporting', voice: '快' }))
    valueOf(await harness.call('novel_canon', { action: 'upsert_world', name: '雾港', kind: '地点', detail: '终年起雾' }))
    valueOf(await harness.call('novel_project', { action: 'advance' }))
    valueOf(await harness.call('novel_outline', { action: 'add_volume', number: 1, title: '入港' }))
    valueOf(await harness.call('novel_outline', { action: 'approve_volume', number: 1 }))
    valueOf(await harness.call('novel_outline', {
      action: 'add_chapter', number: 1, pov: '沈砚', characters: ['沈砚'],
      beats: ['沈砚发现船底藏着尸体', '阿鸢承认改过航向'],
    }))
    valueOf(await harness.call('novel_outline', { action: 'approve_chapter', number: 1 }))
    valueOf(await harness.call('novel_project', { action: 'advance' }))
  }

  it('refuses before drafting, naming what is missing', async () => {
    const base = await book()
    const response = await write(base, '/chapter-plan', {})
    expect(response.status).toBe(409)
    const payload = (await response.json()) as { error: { message: string } }
    expect(payload.error.message).toContain('还不能建章节')
    expect(payload.error.message).toContain('要进入 drafting')
  })

  it('adds the next chapter once the book is drafting, and it shows up as writable', async () => {
    const base = await book()
    await drafting(harness!)

    const created = await write(base, '/chapter-plan', {})
    expect(created.status).toBe(200)
    const payload = (await created.json()) as { data: { number: number } }
    expect(payload.data.number).toBe(2)

    const snapshot = (await (await fetch(`${base}/snapshot`)).json()) as {
      data: { sections: Array<{ id: string; rows: Array<{ key?: string; chip?: string }> }> }
    }
    const text = snapshot.data.sections.find((section) => section.id === 'text')
    // Loose chapters live under a 「未分卷」 group rather than at the top level.
    const keys = (text?.rows ?? []).flatMap((row) =>
      row.key === undefined ? (row as { children?: Array<{ key?: string }> }).children ?? [] : [row],
    )
    expect(keys.some((row) => row.key === '2')).toBe(true)

    const again = await write(base, '/chapter-plan', { number: 2 })
    expect(again.status).toBe(409)
  })
})

describe('creating canon by hand', () => {
  it('adds a character from the cast drawer', async () => {
    const base = await book()
    const created = await write(base, '/new', {
      kind: 'character',
      fields: { name: '沈砚', role: 'protagonist', voice: '短句，回答前先停顿' },
    })
    expect(created.status).toBe(200)
    const payload = (await created.json()) as { data: { kind: string; key: string } }
    expect(payload.data).toEqual({ kind: 'character', key: '沈砚' })

    const page = (await (await fetch(`${base}/entry?kind=character&key=${encodeURIComponent('沈砚')}`)).json()) as {
      data: { title: string; subtitle: string }
    }
    expect(page.data.title).toBe('沈砚')
  })

  it('adds a world entry, and a name is required', async () => {
    const base = await book()
    const ok = await write(base, '/new', { kind: 'world', fields: { name: '雾港', category: '地点' } })
    expect(ok.status).toBe(200)

    const missing = await write(base, '/new', { kind: 'world', fields: {} })
    expect(missing.status).toBe(400)
    const payload = (await missing.json()) as { error: { message: string } }
    expect(payload.error.message).toContain('要有名字')
  })

  it('refuses a volume before the book reaches the outline phase', async () => {
    const base = await book()
    const response = await write(base, '/new', { kind: 'volume', fields: { title: '入港' } })
    expect(response.status).toBe(409)
    const payload = (await response.json()) as { error: { message: string } }
    expect(payload.error.message).toContain('还不能建分卷')
  })

  it('adds a writing note from the notes drawer', async () => {
    const base = await book()
    const created = await write(base, '/new', { kind: 'skill', fields: { name: '开篇钩子' } })
    expect(created.status).toBe(200)
    const page = (await (await fetch(`${base}/entry?kind=skill&key=${encodeURIComponent('开篇钩子')}`)).json()) as {
      data: { title: string }
    }
    expect(page.data.title).toBe('开篇钩子')
  })

  it('rejects a role the card cannot hold', async () => {
    const base = await book()
    const response = await write(base, '/new', { kind: 'character', fields: { name: '阿鸢', role: '神仙' } })
    expect(response.status).toBe(400)
  })
})
