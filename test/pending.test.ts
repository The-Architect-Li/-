/**
 * The queue between a proposal and the book.
 *
 * The rules under test are the ones that make "approve" safe to press in bulk:
 * reading never writes, duplicates do not pile up, an approval writes exactly
 * what was shown, and a write that fails leaves its item in the queue instead of
 * vanishing.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/domain/store.ts'
import {
  PENDING_DIR,
  clearPending,
  describePending,
  pushPending,
  readPending,
  removePending,
} from '../src/domain/pending.ts'
import { applyPending, applyPendingBatch } from '../src/domain/approve.ts'
import type { KeeperProposal } from '../src/roles.ts'

let root: string | undefined

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

async function book(): Promise<ProjectStore> {
  root = await mkdtemp(join(tmpdir(), 'inkwell-pending-'))
  const store = new ProjectStore(root)
  await store.init('雾港', 800000)
  return store
}

function proposal(over: Partial<KeeperProposal> = {}): KeeperProposal {
  return {
    kind: 'ledger',
    subject: '沈砚',
    key: '左手',
    value: '少了半截指节',
    chapter: 3,
    quote: '他左手少了半截指节。',
    ...over,
  }
}

describe('the queue itself', () => {
  it('starts empty, including when the file is missing', async () => {
    const store = await book()
    expect(await readPending(store.root)).toEqual([])
  })

  it('hands out ids and keeps what it was told', async () => {
    const store = await book()
    const { added } = await pushPending(store.root, [proposal()], 3, 'keeper')
    expect(added).toHaveLength(1)
    expect(added[0]?.id).toBe('p-0001')
    expect(added[0]?.sourceChapter).toBe(3)
    const again = await readPending(store.root)
    expect(again[0]?.value).toBe('少了半截指节')
  })

  it('does not pile up the same proposal filed twice', async () => {
    // Re-running a chapter's keeper is normal; a queue with every line twice is
    // a queue nobody reads.
    const store = await book()
    await pushPending(store.root, [proposal()], 3, 'keeper')
    const second = await pushPending(store.root, [proposal()], 3, 'keeper')
    expect(second.added).toEqual([])
    expect(second.duplicates).toBe(1)
    expect(await readPending(store.root)).toHaveLength(1)
  })

  it('treats a changed value as a new proposal', async () => {
    const store = await book()
    await pushPending(store.root, [proposal()], 3, 'keeper')
    const second = await pushPending(store.root, [proposal({ value: '少了整只手掌' })], 9, 'keeper')
    expect(second.added).toHaveLength(1)
    expect(await readPending(store.root)).toHaveLength(2)
  })

  it('drops by id and reports how many were really there', async () => {
    const store = await book()
    const { added } = await pushPending(store.root, [proposal(), proposal({ subject: '阿鸢' })], 3, 'keeper')
    expect(await removePending(store.root, [added[0]!.id, 'p-9999'])).toBe(1)
    expect((await readPending(store.root)).map((item) => item.subject)).toEqual(['阿鸢'])
  })

  it('clears everything', async () => {
    const store = await book()
    await pushPending(store.root, [proposal(), proposal({ subject: '阿鸢' })], 3, 'keeper')
    expect(await clearPending(store.root)).toBe(2)
    expect(await readPending(store.root)).toEqual([])
  })

  it('survives a queue file that someone edited by hand', async () => {
    const store = await book()
    await pushPending(store.root, [proposal()], 3, 'keeper')
    const file = join(store.root, PENDING_DIR, 'queue.json')
    const raw = JSON.parse(await readFile(file, 'utf8')) as { items: unknown[] }
    raw.items.push({ nonsense: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, JSON.stringify(raw), 'utf8')
    expect(await readPending(store.root)).toHaveLength(1)
  })

  it('describes a proposal with the line that justifies it', () => {
    const line = describePending({
      ...proposal(),
      id: 'p-0001',
      at: '2026-01-01T00:00:00.000Z',
      sourceChapter: 3,
      role: 'keeper',
    })
    expect(line).toContain('事实')
    expect(line).toContain('沈砚·左手')
    expect(line).toContain('少了半截指节')
    expect(line).toContain('他左手少了半截指节')
  })
})

describe('approving a proposal', () => {
  function queued(store: ProjectStore, over: Partial<KeeperProposal> = {}) {
    return {
      ...proposal(over),
      id: 'p-0001',
      at: '2026-01-01T00:00:00.000Z',
      sourceChapter: 3,
      role: 'keeper',
    }
  }

  it('records a fact in the ledger with its evidence', async () => {
    const store = await book()
    const result = await applyPending(store, queued(store))
    expect('kind' in result).toBe(true)
    const facts = await store.ledger()
    expect(facts).toHaveLength(1)
    expect(facts[0]?.quote).toBe('他左手少了半截指节。')
    expect(facts[0]?.chapter).toBe(3)
  })

  it('does not record the same fact twice', async () => {
    const store = await book()
    await applyPending(store, queued(store))
    const again = await applyPending(store, queued(store))
    expect('line' in again && 'kind' in again ? again.kind : '').toBe('')
    expect(await store.ledger()).toHaveLength(1)
  })

  it('creates a place it has never seen, with the chapter it appeared in', async () => {
    const store = await book()
    await applyPending(store, queued(store, { kind: 'place', subject: '三号货舱', key: '', value: '舱底有血迹' }))
    const places = await store.places()
    expect(places[0]?.name).toBe('三号货舱')
    expect(places[0]?.firstChapter).toBe(3)
    expect(places[0]?.states[0]?.detail).toBe('舱底有血迹')
  })

  it('keeps the old state when a place changes', async () => {
    // The courtyard in chapter 1 and the flat in chapter 100 are the same
    // address; a card that only held the newest description would "remember"
    // a room that no longer exists.
    const store = await book()
    await applyPending(store, queued(store, { kind: 'place', subject: '三号货舱', key: '', value: '舱底有血迹', chapter: 3 }))
    await applyPending(store, queued(store, { kind: 'place', subject: '三号货舱', key: '', value: '血迹拖到舱门', chapter: 9 }))
    const places = await store.places()
    expect(places[0]?.detail).toBe('血迹拖到舱门')
    expect(places[0]?.states.map((state) => state.detail)).toEqual(['舱底有血迹', '血迹拖到舱门'])
  })

  it('adds a stage to a card that exists, without touching the voice', async () => {
    const store = await book()
    await store.upsertCharacter({
      name: '阿鸢',
      role: 'supporting',
      voice: '语速快，爱用反问',
      appearance: '',
      goal: '',
      secret: '',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await applyPending(store, queued(store, { kind: 'stage', subject: '阿鸢', key: '当前', value: '不再躲着' }))
    const card = (await store.characters())[0]!
    expect(card.stages?.[0]?.text).toBe('不再躲着')
    expect(card.stages?.[0]?.chapter).toBe(3)
    expect(card.voice).toBe('语速快，爱用反问')
  })

  it('makes a stub card when the person has none, and says so', async () => {
    // Refusing would put the manual step back: the author would have to create
    // the card first, which is what the queue exists to avoid.
    const store = await book()
    const result = await applyPending(store, queued(store, { kind: 'stage', subject: '陆九', key: '当前', value: '把伞递了过来' }))
    expect('created' in result && result.created).toBe(true)
    const card = (await store.characters())[0]!
    expect(card.name).toBe('陆九')
    expect(card.voice).toBe('')
    expect(card.role).toBe('supporting')
  })

  it('writes a card field onto the chapter plan', async () => {
    const store = await book()
    await applyPending(store, queued(store, { kind: 'card', subject: '', key: 'scene', value: '三号货舱', chapter: 3 }))
    const plans = await store.plans()
    expect(plans[0]?.scene).toBe('三号货舱')
    expect(plans[0]?.number).toBe(3)
    // A card written from prose is not an approved outline.
    expect(plans[0]?.approved).toBe(false)
  })

  it('refuses a date it cannot parse, and says why', async () => {
    const store = await book()
    const result = await applyPending(store, queued(store, { kind: 'anchor', key: '', value: '某天早上' }))
    expect('line' in result && 'kind' in result).toBe(false)
    expect('line' in result ? result.line : '').toContain('日期没钉上')
  })
})

describe('approving a batch', () => {
  it('applies what it can and keeps the rest out of the book', async () => {
    const store = await book()
    const items = [
      { ...proposal(), id: 'p-0001', at: '2026-01-01T00:00:00.000Z', sourceChapter: 1, role: 'keeper' },
      { ...proposal({ kind: 'anchor', subject: '本章', key: '', value: '看不懂的日期' }), id: 'p-0002', at: '2026-01-01T00:00:00.000Z', sourceChapter: 1, role: 'keeper' },
      { ...proposal({ subject: '阿鸢', key: '航向' }), id: 'p-0003', at: '2026-01-01T00:00:00.000Z', sourceChapter: 1, role: 'keeper' },
    ]
    const result = await applyPendingBatch(store, items)
    expect(result.applied.map((item) => item.id)).toEqual(['p-0001', 'p-0003'])
    expect(result.skipped.map((item) => item.id)).toEqual(['p-0002'])
    expect(await store.ledger()).toHaveLength(2)
  })
})
