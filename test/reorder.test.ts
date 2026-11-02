/**
 * Moving a chapter, and everything that points at it.
 *
 * The chapter number is the book's primary key: the prose file, the draft folder,
 * the index, the card, and the `chapter` field buried inside every fact, place
 * state, character stage and thread. A move that renames the file and forgets the
 * ledger produces a book whose records describe a different chapter — silently,
 * because every file still parses.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/domain/store.ts'
import { mergeChapters, moveChapter } from '../src/domain/reorder.ts'

const roots: string[] = []

afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A book with six written chapters and records pointing at them. */
async function book(): Promise<ProjectStore> {
  const dir = await mkdtemp(join(tmpdir(), 'inkwell-reorder-'))
  roots.push(dir)
  const store = new ProjectStore(dir)
  await store.init('雾港', 800000)
  for (const number of [1, 2, 3, 4, 5, 6]) {
    await store.writeChapter(
      {
        number,
        title: `第${number}章标题`,
        text: `这是第${number}章的正文。`.repeat(6),
        words: 60,
        summary: '',
        writtenAt: '2026-01-01T00:00:00.000Z',
        revision: 1,
      },
      { baseRevision: undefined },
    )
    await store.upsertPlan({
      number,
      volume: 1,
      title: `第${number}章`,
      pov: '',
      characters: [`人物${number}`],
      beats: ['a', 'b'],
      hooks: ['钩子'],
      approved: true,
    })
  }
  await store.appendLedger({ subject: '沈砚', predicate: '状态', value: '在船上', chapter: 3, quote: '', supersedes: null })
  await store.writeThreads([
    { id: 't-0001', label: '那封信', planted: 2, quote: '', paid: 5, dropped: false, createdAt: '2026-01-01T00:00:00.000Z' },
  ])
  return store
}

async function titleAt(store: ProjectStore, number: number): Promise<string | undefined> {
  return (await store.chapters()).find((chapter) => chapter.number === number)?.title
}

describe('moveChapter', () => {
  it('swaps two neighbours, and the prose goes with the number', async () => {
    const store = await book()
    await moveChapter(store, 4, 3)
    expect(await titleAt(store, 3)).toBe('第4章标题')
    expect(await titleAt(store, 4)).toBe('第3章标题')
    expect((await store.chapter(3))?.text).toContain('这是第4章的正文')
  })

  it('shifts the whole run when a chapter moves several places', async () => {
    // 5 → 3: chapters 3 和 4 step down to 4 和 5.
    const store = await book()
    await moveChapter(store, 5, 3)
    expect(await titleAt(store, 3)).toBe('第5章标题')
    expect(await titleAt(store, 4)).toBe('第3章标题')
    expect(await titleAt(store, 5)).toBe('第4章标题')
    // And forwards: 2 → 4.
    const store2 = await book()
    await moveChapter(store2, 2, 4)
    expect(await titleAt(store2, 4)).toBe('第2章标题')
    expect(await titleAt(store2, 2)).toBe('第3章标题')
    expect(await titleAt(store2, 3)).toBe('第4章标题')
  })

  it('does not lose or duplicate a chapter', async () => {
    const store = await book()
    const before = (await store.chapters()).length
    await moveChapter(store, 6, 1)
    const after = (await store.chapters()).length
    expect(after).toBe(before)
    expect(new Set((await store.chapters()).map((chapter) => chapter.number)).size).toBe(before)
  })

  it('moves the facts so a record still describes its own chapter', async () => {
    // The ledger entry lives in chapter 3. After 4 moves up to 3, chapter 3 is
    // the old chapter 4 — so the fact must follow the old chapter 3 to 4.
    const store = await book()
    await moveChapter(store, 4, 3)
    const facts = await store.ledger()
    expect(facts[0]?.chapter).toBe(4)
  })

  it('moves both ends of a thread', async () => {
    // 2 → 6 pushes 3..6 down one, so the payoff at 5 lands on 4.
    const store = await book()
    await moveChapter(store, 2, 6)
    const [thread] = await store.threads()
    expect(thread?.planted).toBe(6)
    expect(thread?.paid).toBe(4)
  })

  it('moves the card with its chapter', async () => {
    const store = await book()
    await moveChapter(store, 1, 2)
    const plans = await store.plans()
    expect(plans.find((plan) => plan.number === 2)?.characters).toEqual(['人物1'])
    expect(plans.find((plan) => plan.number === 1)?.characters).toEqual(['人物2'])
  })

  it('backs up every file it touches, before touching it', async () => {
    const store = await book()
    const result = await moveChapter(store, 2, 1)
    const saved = await readFile(join(result.backup, 'ledger__facts.json'), 'utf8').catch(() => '')
    expect(saved).toContain('"chapter": 3')
    expect(result.touched.length).toBeGreaterThan(0)
  })

  it('refuses a chapter that is not there, before writing anything', async () => {
    const store = await book()
    const before = await readFile(join(store.root, 'chapters/index.json'), 'utf8')
    await expect(moveChapter(store, 99, 1)).rejects.toThrow(/不存在/)
    expect(await readFile(join(store.root, 'chapters/index.json'), 'utf8')).toBe(before)
  })

  it('refuses to move a chapter onto itself', async () => {
    const store = await book()
    await expect(moveChapter(store, 3, 3)).rejects.toThrow(/同一章/)
  })
})

describe('mergeChapters', () => {
  it('joins the two bodies and shortens the book by one', async () => {
    const store = await book()
    const result = await mergeChapters(store, 3)
    expect(result.dropped).toBe(4)
    // Both bodies are there, in order, and the word count is the sum.
    const merged = await store.chapter(3)
    expect(merged?.text).toContain('这是第3章的正文')
    expect(merged?.text).toContain('这是第4章的正文')
    expect(merged?.text.indexOf('这是第3章')).toBeLessThan(merged!.text.indexOf('这是第4章'))
    expect((await store.chapters()).length).toBe(5)
  })

  it('renumbers everything after the seam, so no number is missing', async () => {
    const store = await book()
    await mergeChapters(store, 3)
    expect(await titleAt(store, 4)).toBe('第5章标题')
    expect(await titleAt(store, 5)).toBe('第6章标题')
    expect((await store.chapters()).map((chapter) => chapter.number)).toEqual([1, 2, 3, 4, 5])
  })

  it('folds the swallowed chapter’s records into the chapter that kept it', async () => {
    // A fact from chapter 4 now belongs to chapter 3, because that is where the
    // sentence lives now.
    const store = await book()
    await store.appendLedger({ subject: '阿鸢', predicate: '状态', value: '在岸上', chapter: 4, quote: '', supersedes: null })
    await mergeChapters(store, 3)
    const facts = await store.ledger()
    expect(facts.find((fact) => fact.subject === '阿鸢')?.chapter).toBe(3)
  })

  it('keeps both cards’ beats and characters, and the later hook', async () => {
    const store = await book()
    await store.upsertPlan({
      number: 4, volume: 1, title: '第4章', pov: '', characters: ['新人物'],
      beats: ['c'], hooks: ['第二个钩子'], approved: true,
    })
    await mergeChapters(store, 3)
    const plan = (await store.plans()).find((item) => item.number === 3)
    expect(plan?.characters).toContain('人物3')
    expect(plan?.characters).toContain('新人物')
    expect(plan?.beats).toEqual(['a', 'b', 'c'])
    expect(plan?.hooks).toEqual(['第二个钩子'])
    // A recap of two chapters is a new recap; leaving the old one would describe
    // half the chapter.
    expect(plan?.summary).toBe('')
  })

  it('refuses when there is no next chapter to swallow', async () => {
    const store = await book()
    await expect(mergeChapters(store, 6)).rejects.toThrow(/没有正文/)
  })

  it('backs up the whole book before joining anything', async () => {
    const store = await book()
    const result = await mergeChapters(store, 2)
    expect(result.backup).toContain('merge-')
    const kept = await readFile(join(result.backup, 'chapters__002.md'), 'utf8').catch(() => '')
    expect(kept).toContain('这是第2章的正文')
  })
})

describe('a moved chapter says where it came from', () => {
  it('marks the chapter that moved, and only that one', async () => {
    // The others only shifted by one; claiming 「原来在第 4 章」 about a chapter
    // nobody chose to move would be noise on every row.
    const store = await book()
    await moveChapter(store, 5, 2)
    const index = await store.chapters()
    expect(index.find((chapter) => chapter.number === 2)?.origin).toMatchObject({ kind: 'moved', from: [5] })
    expect(index.find((chapter) => chapter.number === 5)?.origin).toBeUndefined()
  })

  it('marks a merge with both of its source numbers', async () => {
    const store = await book()
    await mergeChapters(store, 3)
    const merged = (await store.chapters()).find((chapter) => chapter.number === 3)
    expect(merged?.origin).toMatchObject({ kind: 'merged', from: [3, 4] })
  })

  it('survives a round trip through the index file', async () => {
    // The panel reads this from disk, not from memory — a field that only exists
    // in the return value would never reach the row.
    const store = await book()
    await moveChapter(store, 2, 4)
    const raw = JSON.parse(await readFile(join(store.root, 'chapters/index.json'), 'utf8')) as { number: number; origin?: unknown }[]
    expect(raw.find((chapter) => chapter.number === 4)?.origin).toBeTruthy()
  })
})

describe('a merged chapter is not a stale card', () => {
  it('moves the card revision forward with the prose', async () => {
    // Merging rewrites the card in the same breath (beats joined, characters
    // deduped, later hook kept), so the card describes the merged text. Leaving
    // `cardRevision` behind made the row say 「卡过期」 the instant the merge
    // finished — the author had not touched the chapter at all.
    const store = await book()
    await mergeChapters(store, 3)
    const chapter = (await store.chapters()).find((item) => item.number === 3)
    const plan = (await store.plans()).find((item) => item.number === 3)
    expect((chapter?.revision ?? 0)).toBeLessThanOrEqual(plan?.cardRevision ?? 0)
  })

  it('still leaves the recap empty, because two recaps are not one', async () => {
    const store = await book()
    await mergeChapters(store, 3)
    const plan = (await store.plans()).find((item) => item.number === 3)
    expect(plan?.summary).toBe('')
  })
})
