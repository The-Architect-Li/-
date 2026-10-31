/**
 * Renaming and merging a world category.
 *
 * The categories are the author's own words, so they drift — and the drawer
 * that groups by them makes the drift visible: two 宗门 rows, a 规则 row holding
 * things that are really 境界. This is the way back.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/domain/store.ts'
import { UNFILED_KIND, kindOf, renameWorldKind } from '../src/domain/kinds.ts'
import type { WorldEntry } from '../src/domain/types.ts'

let root: string | undefined

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

function entry(name: string, kind: string): WorldEntry {
  return { name, kind, detail: '', updatedAt: '2026-01-01T00:00:00.000Z' }
}

async function book(entries: WorldEntry[]): Promise<ProjectStore> {
  root = await mkdtemp(join(tmpdir(), 'inkwell-kinds-'))
  const store = new ProjectStore(root)
  await store.init('雾港', 800000)
  for (const item of entries) await store.upsertWorld(item)
  return store
}

describe('kindOf', () => {
  it('reads a blank kind as 未分类', () => {
    expect(kindOf(entry('雾港', ''))).toBe(UNFILED_KIND)
    expect(kindOf(entry('雾港', '   '))).toBe(UNFILED_KIND)
    expect(kindOf(entry('雾港', '宗门'))).toBe('宗门')
  })
})

describe('renameWorldKind', () => {
  it('renames every entry of one category, and nothing else', async () => {
    const store = await book([entry('妙玉宫', '宗门'), entry('食佛门', '宗门'), entry('补天丹', '物品')])
    const result = await renameWorldKind(store, '宗门', '门派')
    expect(result.moved).toBe(2)
    const kinds = (await store.world()).map((item) => `${item.name}:${item.kind}`)
    expect(kinds.sort()).toEqual(['妙玉宫:门派', '补天丹:物品', '食佛门:门派'].sort())
  })

  it('merges when the target already exists', async () => {
    // The same write: rename and merge differ only in whether someone else is
    // already standing at the destination.
    const store = await book([entry('妙玉宫', '宗门'), entry('食佛门', '门派')])
    await renameWorldKind(store, '门派', '宗门')
    const kinds = (await store.world()).map((item) => item.kind)
    expect(new Set(kinds)).toEqual(new Set(['宗门']))
  })

  it('writes the canon file once, not once per entry', async () => {
    // One decision should leave one history entry, not twelve.
    const store = await book([entry('甲', '宗门'), entry('乙', '宗门'), entry('丙', '宗门')])
    await renameWorldKind(store, '宗门', '门派')
    const raw = JSON.parse(await readFile(join(store.root, 'canon/world.json'), 'utf8')) as WorldEntry[]
    expect(raw.every((item) => item.kind === '门派')).toBe(true)
  })

  it('clears the field when renamed to 未分类 instead of storing the word', async () => {
    const store = await book([entry('雾港', '地点')])
    await renameWorldKind(store, '地点', UNFILED_KIND)
    const [saved] = await store.world()
    expect(saved?.kind).toBe('')
    expect(kindOf(saved!)).toBe(UNFILED_KIND)
  })

  it('does nothing when the category is not there, and says zero', async () => {
    const store = await book([entry('妙玉宫', '宗门')])
    const result = await renameWorldKind(store, '不存在的类别', '门派')
    expect(result.moved).toBe(0)
    expect((await store.world())[0]?.kind).toBe('宗门')
  })

  it('refuses an empty target', async () => {
    const store = await book([entry('妙玉宫', '宗门')])
    await expect(renameWorldKind(store, '宗门', '   ')).rejects.toThrow(/不能为空/)
  })
})
