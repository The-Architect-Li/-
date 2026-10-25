/**
 * The material a card carries but nobody typed in.
 *
 * `notes` exists because an imported character sheet has a relationship web and
 * growth lines that fit none of the five card fields. Two places can write a
 * card — the panel editor and `novel_canon` — and both rebuild it from what
 * they were told. A rebuild that forgets `notes` deletes the author's material
 * on the first edit, silently, which is the worst shape for this bug: it looks
 * like the edit worked.
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/domain/store.ts'
import type { CharacterCard } from '../src/domain/types.ts'
import { PANEL_HEADER, PANEL_HEADER_VALUE, PANEL_PREFIX } from '../src/panel/serve.ts'
import { createHarness, type Harness } from './helpers.ts'

// The shelf lives under dsh's state directory: a test run must not append to
// the developer's real book list.
const stateHome = await mkdtemp(join(tmpdir(), 'inkwell-notes-home-'))
process.env.DSH_HOME = stateHome
afterAll(async () => {
  delete process.env.DSH_HOME
  await rm(stateHome, { recursive: true, force: true })
})

let harness: Harness | undefined
let server: Server | undefined
let base = ''

afterEach(async () => {
  if (server) {
    const open = server
    server = undefined
    await new Promise<void>((done) => open.close(() => done()))
  }
  if (harness) await harness.cleanup()
  harness = undefined
})

/** Start a book with a panel route reachable over HTTP. */
async function start(): Promise<void> {
  // No `root` override: the harness hands the plugin its own temp directory, so
  // the book lands where `ProjectStore(harness.root)` will find it and nowhere
  // near the repository.
  harness = await createHarness()
  await harness.call('novel_project', { action: 'init', title: '雾港' })
  const route = harness.routes.find((candidate) => candidate.path === PANEL_PREFIX)
  if (!route) throw new Error('the plugin registered no panel route')
  const created = createServer((req, res) => void route.handler(req, res))
  server = created
  await new Promise<void>((done) => created.listen(0, '127.0.0.1', () => done()))
  const address = created.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${address.port}${PANEL_PREFIX}`
}

/** GET a panel route and unwrap the envelope. */
async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`)
  const body = (await response.json()) as { ok: boolean; data: T; error?: { message: string } }
  if (!body.ok) throw new Error(body.error?.message ?? 'panel refused')
  return body.data
}

/** POST an edit to one entry and return the refreshed page. */
async function edit<T>(kind: string, key: string, patch: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${base}/entry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [PANEL_HEADER]: PANEL_HEADER_VALUE },
    body: JSON.stringify({ kind, key, fields: patch }),
  })
  const body = (await response.json()) as { ok: boolean; data: T }
  if (!body.ok) throw new Error(`edit refused with ${response.status}`)
  return body.data
}

/** The card as stored, so an assertion cannot be satisfied by a projection. */
async function cardOf(name: string): Promise<CharacterCard | undefined> {
  if (harness === undefined) throw new Error('no harness yet')
  const store = new ProjectStore(harness.root)
  return (await store.characters()).find((card) => card.name === name)
}

const NOTES = '关系网：刘紫灵——旧识\n成长线：从写字楼底层爬到上势老板'

describe('notes on a character card', () => {
  it('keeps them when the tool rewrites the same card without them', async () => {
    await start()
    await harness?.call('novel_canon', {
      action: 'upsert_character',
      name: '王上',
      role: 'protagonist',
      voice: '短句',
      notes: NOTES,
    })
    await harness?.call('novel_canon', { action: 'upsert_character', name: '王上', voice: '短句，爱用反问' })
    const card = await cardOf('王上')
    expect(card?.voice).toBe('短句，爱用反问')
    expect(card?.notes).toContain('关系网：刘紫灵')
  })

  it('replaces them when they are given on purpose', async () => {
    await start()
    await harness?.call('novel_canon', { action: 'upsert_character', name: '王上', voice: '短句', notes: NOTES })
    await harness?.call('novel_canon', { action: 'upsert_character', name: '王上', notes: '只留一句' })
    expect((await cardOf('王上'))?.notes).toBe('只留一句')
  })

  it('shows them on the character page and in its editor', async () => {
    await start()
    await harness?.call('novel_canon', { action: 'upsert_character', name: '王上', voice: '短句', notes: NOTES })
    const page = await get<{
      fields: { label: string; value?: string }[]
      edit: { inputs: { key: string; value?: string }[] }
    }>(`/entry?kind=character&key=${encodeURIComponent('王上')}`)
    expect(page.fields.find((field) => field.label === '其他材料')?.value).toContain('成长线')
    expect(page.edit.inputs.find((input) => input.key === 'notes')?.value).toContain('关系网')
  })

  it('hides the row when a card has none, so a hand-written card looks unchanged', async () => {
    await start()
    await harness?.call('novel_canon', { action: 'upsert_character', name: '阿鸢', voice: '快' })
    const page = await get<{ fields: { label: string }[] }>(
      `/entry?kind=character&key=${encodeURIComponent('阿鸢')}`,
    )
    expect(page.fields.map((field) => field.label)).not.toContain('其他材料')
  })

  it('lets the panel clear them, because an import can be wrong', async () => {
    await start()
    await harness?.call('novel_canon', { action: 'upsert_character', name: '王上', voice: '短句', notes: NOTES })
    await edit('character', '王上', { notes: '' })
    expect((await cardOf('王上'))?.notes ?? '').toBe('')
  })

  it('keeps them when the panel edits some other field', async () => {
    await start()
    await harness?.call('novel_canon', { action: 'upsert_character', name: '王上', voice: '短句', notes: NOTES })
    await edit('character', '王上', { voice: '低，句子短' })
    const card = await cardOf('王上')
    expect(card?.voice).toBe('低，句子短')
    expect(card?.notes).toContain('成长线')
  })
})
