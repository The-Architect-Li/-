/**
 * Per-file history: the copy that makes "world.json was fine an hour ago" a
 * recoverable sentence rather than a regret.
 *
 * The cases that matter are the ones a backup cannot answer: one file out of
 * ninety-nine, and a restore that must not break the file it restores.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HISTORY_KEEP, listHistory, parseTarget, readHistory, recordHistory } from '../src/domain/history.ts'
import { ProjectStore } from '../src/domain/store.ts'

const roots: string[] = []

async function project(): Promise<ProjectStore> {
  const root = await mkdtemp(join(tmpdir(), 'inkwell-history-'))
  roots.push(root)
  const store = new ProjectStore(root)
  await store.init('雾港', 120_000)
  return store
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('recordHistory', () => {
  it('keeps what was there before the overwrite, not the new text', async () => {
    const store = await project()
    await recordHistory(store.root, 'canon', 'characters', '第一版')
    const entries = await listHistory(store.root, 'canon', 'characters')
    expect(entries).toHaveLength(1)
    expect(await readHistory(store.root, 'canon', 'characters', entries[0]!.rev)).toBe('第一版')
  })

  it('refuses to record emptiness — a new book would otherwise bury the good version', async () => {
    const store = await project()
    expect(await recordHistory(store.root, 'canon', 'characters', '')).toBeUndefined()
    expect(await recordHistory(store.root, 'canon', 'characters', '  \n ')).toBeUndefined()
    expect(await listHistory(store.root, 'canon', 'characters')).toHaveLength(0)
  })

  it('keeps only the newest versions', async () => {
    const store = await project()
    for (let index = 0; index < 9; index += 1) {
      await recordHistory(store.root, 'chapter', 'ch001', `第 ${index} 版`, { keep: 3 })
    }
    const entries = await listHistory(store.root, 'chapter', 'ch001')
    expect(entries).toHaveLength(3)
    const bodies = await Promise.all(entries.map((entry) => readHistory(store.root, 'chapter', 'ch001', entry.rev)))
    expect(bodies).toContain('第 8 版')
    expect(bodies).not.toContain('第 0 版')
  })

  it('defaults chapters to fewer versions than canon, because chapters are big', () => {
    expect(HISTORY_KEEP.chapter).toBeLessThan(HISTORY_KEEP.canon)
  })
})

describe('the store records history on every overwrite', () => {
  it('keeps the previous chapter body', async () => {
    const store = await project()
    const base = { number: 1, title: '入港', words: 3, summary: '', writtenAt: new Date().toISOString(), revision: 1 }
    await store.writeChapter({ ...base, text: '第一稿。' })
    await store.writeChapter({ ...base, text: '第二稿。' })

    const entries = await listHistory(store.root, 'chapter', 'ch001')
    expect(entries).toHaveLength(1)
    expect(await readHistory(store.root, 'chapter', 'ch001', entries[0]!.rev)).toContain('第一稿')
  })

  it('keeps the previous canon file', async () => {
    const store = await project()
    await store.upsertCharacter({ name: '沈砚', role: 'protagonist', voice: '短句' } as never)
    await store.upsertCharacter({ name: '沈砚', role: 'protagonist', voice: '长句' } as never)

    const entries = await listHistory(store.root, 'canon', 'characters')
    expect(entries).toHaveLength(1)
    const before = await readHistory(store.root, 'canon', 'characters', entries[0]!.rev)
    expect(before).toContain('短句')
    expect(before).not.toContain('长句')
  })

  it('does not record the empty list a fresh book starts with', async () => {
    const store = await project()
    await store.upsertWorld({ name: '雾港', kind: '地点', detail: '终年起雾' } as never)
    expect(await listHistory(store.root, 'canon', 'world')).toHaveLength(0)
  })
})

describe('restoring one file', () => {
  it('puts a chapter back and bumps the revision', async () => {
    const store = await project()
    const base = { number: 2, title: '起雾', words: 3, summary: '', writtenAt: new Date().toISOString(), revision: 1 }
    await store.writeChapter({ ...base, text: '好的一版。' })
    await store.writeChapter({ ...base, text: '写坏的一版。' })

    const entries = await listHistory(store.root, 'chapter', 'ch002')
    const good = await readHistory(store.root, 'chapter', 'ch002', entries[0]!.rev)
    const meta = await store.restoreChapterText(2, good)

    expect((await store.chapter(2))?.text).toContain('好的一版')
    expect(meta.revision).toBe(3)
  })

  it('puts a canon file back, and refuses text that is not JSON', async () => {
    const store = await project()
    await store.upsertCharacter({ name: '沈砚', role: 'protagonist', voice: '短句' } as never)
    await store.upsertCharacter({ name: '阿鸢', role: 'supporting', voice: '快' } as never)

    const entries = await listHistory(store.root, 'canon', 'characters')
    const before = await readHistory(store.root, 'canon', 'characters', entries[0]!.rev)
    await store.writeCanonRaw('characters', before)
    expect((await store.characters()).map((card) => card.name)).toEqual(['沈砚'])

    await expect(store.writeCanonRaw('characters', 'not json')).rejects.toThrow()
    expect((await store.characters()).map((card) => card.name)).toEqual(['沈砚'])
  })
})

describe('parseTarget', () => {
  it('reads the three kinds', () => {
    expect(parseTarget('chapter:7')).toEqual({ kind: 'chapter', name: '7' })
    expect(parseTarget('canon:characters')).toEqual({ kind: 'canon', name: 'characters' })
    expect(parseTarget('skill:开篇钩子')).toEqual({ kind: 'skill', name: '开篇钩子' })
  })

  it('says what a malformed target should look like', () => {
    expect(() => parseTarget('')).toThrow(/类别:名字/)
    expect(() => parseTarget('chapter')).toThrow(/类别:名字/)
    expect(() => parseTarget('chapter:七')).toThrow(/章号/)
    expect(() => parseTarget('outline:volumes')).toThrow(/不认识的类别/)
  })
})

describe('history files stay inside the book', () => {
  it('writes under .history and nowhere else', async () => {
    const store = await project()
    await recordHistory(store.root, 'skill', '开篇钩子', '# 开篇钩子\n\n第一句要有问题。')
    const entries = await listHistory(store.root, 'skill', '开篇钩子')
    const text = await readFile(join(store.root, '.history', 'skill', '开篇钩子', `${entries[0]!.rev}.md`), 'utf8')
    expect(text).toContain('第一句要有问题')
  })
})
