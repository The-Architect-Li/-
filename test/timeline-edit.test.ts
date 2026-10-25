/**
 * The clock's three roads, and the rule they share.
 *
 * A person typing an anchor, a chapter naming its own date, and an imported
 * manuscript full of dates all end in the same file, written by the same
 * function. What is worth testing is not "did it write" but the judgement
 * around it: which statements are refused, which are flagged as contradicting
 * the computed window, and whether a second pass stays quiet.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/domain/store.ts'
import { addAnchor, addAnchors, adoptClock, seedClockFromProse } from '../src/domain/timeline-edit.ts'

let space = ''
let store: ProjectStore

beforeEach(async () => {
  space = await mkdtemp(join(tmpdir(), 'inkwell-clock-'))
  store = new ProjectStore(space)
  await store.init('雨书', 800_000)
})

afterEach(async () => {
  await rm(space, { recursive: true, force: true })
})

describe('addAnchor', () => {
  it('dates a whole stretch of chapters in one write, then lets one of them move', async () => {
    // The author's case: chapters 1–10 are one year, chapter 7 is a month of
    // that year. Two writes, not ten boxes.
    const written = await addAnchors(store, { chapters: [1, 2, 3], when: '2019' })
    expect(written.map((anchor) => anchor.chapter)).toEqual([1, 2, 3])
    expect(written.every((anchor) => anchor.source === 'manual')).toBe(true)

    const moved = await addAnchors(store, { chapters: [2], when: '2019-10' })
    expect(moved).toHaveLength(1)
    const file = await store.timeline()
    expect(file.anchors.map((item) => [item.chapter, item.when])).toEqual([
      [1, '2019'],
      [2, '2019-10'],
      [3, '2019'],
    ])
    // Ids stay put when a chapter is re-dated: the anchor is the same fact, said
    // again.
    expect(new Set(file.anchors.map((item) => item.id)).size).toBe(3)
  })

  it('keeps its label, drops duplicates, and writes nothing for a bad date', async () => {
    const written = await addAnchors(store, { chapters: [5, 5, 6], when: '2020-01', label: '搬进新楼' })
    expect(written.map((anchor) => [anchor.chapter, anchor.label])).toEqual([
      [5, '搬进新楼'],
      [6, '搬进新楼'],
    ])
    await expect(addAnchors(store, { chapters: [7], when: '那年冬天' })).rejects.toThrow()
    const file = await store.timeline()
    expect(file.anchors.map((item) => item.chapter)).toEqual([5, 6])
    await expect(addAnchors(store, { chapters: [], when: '2020-01' })).rejects.toThrow('没有选中任何章节')
  })

  it('writes one anchor per chapter, replacing the old date instead of adding a second', async () => {
    const first = await addAnchor(store, { chapter: 3, when: '2020-10', label: '开局' })
    expect(first.id).toBe('ta-001')
    expect(first.source).toBeUndefined()

    const second = await addAnchor(store, { chapter: 3, when: '2021-04', label: '改主意了', source: 'manual' })
    const file = await store.timeline()
    expect(file.anchors).toHaveLength(1)
    expect(second.id).toBe('ta-001')
    expect(file.anchors[0]?.when).toBe('2021-04')
    expect(file.anchors[0]?.source).toBe('manual')
  })

  it('refuses a date the clock cannot hold', async () => {
    await expect(addAnchor(store, { chapter: 1, when: '那年秋天', label: '' })).rejects.toThrow()
    expect((await store.timeline()).anchors).toHaveLength(0)
  })

  it('falls back to the chapter name when no label is given', async () => {
    const anchor = await addAnchor(store, { chapter: 7, when: '2019', label: '   ' })
    expect(anchor.label).toBe('第7章')
  })
})

describe('adoptClock', () => {
  it('pins the start at the first date the prose names, and marks the anchor as prose', async () => {
    const run = await adoptClock(store, 2, '那天是 2020年10月14日，雨下了一整夜。')
    expect(run.start).toBe('2020-10-14')
    expect(run.anchors.map((item) => [item.chapter, item.when, item.source])).toEqual([[2, '2020-10-14', 'prose']])
    const project = await store.readProject()
    expect(project.bookStart).toBe('2020-10-14')
  })

  it('does not touch a chapter that already has an anchor, and says so', async () => {
    await addAnchor(store, { chapter: 2, when: '2020-10', label: '人写的' })
    const run = await adoptClock(store, 2, '2021年1月1日，他回来了。')
    expect(run.anchors).toHaveLength(0)
    expect(run.skipped.join('')).toContain('已经有锚点')
    expect((await store.timeline()).anchors[0]?.when).toBe('2020-10')
  })

  it('flags a date that contradicts the computed window instead of writing it', async () => {
    await addAnchor(store, { chapter: 1, when: '2020-01', label: '开局' })
    await store.writeTimeline({
      ...(await store.timeline()),
      spans: [{ id: 'ts-001', fromChapter: 1, toChapter: 2, days: { min: 3, max: 3 }, text: '三天后' }],
    })
    const run = await adoptClock(store, 2, '转眼到了 2025年6月1日。')
    expect(run.anchors).toHaveLength(0)
    expect(run.conflicts.join('')).toContain('2025年6月1日')
    expect((await store.timeline()).anchors).toHaveLength(1)
  })

  it('turns a distance into a span when there is an earlier dated chapter', async () => {
    await addAnchor(store, { chapter: 1, when: '2020-01', label: '开局' })
    const run = await adoptClock(store, 2, '过了两三个月，他回来了。')
    expect(run.anchors).toHaveLength(0)
    expect(run.spans.map((item) => [item.fromChapter, item.toChapter, item.days])).toEqual([
      [1, 2, { min: 60, max: 93 }],
    ])
  })

  it('refuses to measure a distance from nothing', async () => {
    const run = await adoptClock(store, 2, '过了两三个月，他回来了。')
    expect(run.spans).toHaveLength(0)
    expect(run.skipped.join('')).toContain('前面还没有一章有日期')
  })

  it('stays silent on a chapter that says nothing about when it happens', async () => {
    const run = await adoptClock(store, 4, '那年秋天，风把门吹开了。')
    expect(run).toEqual({ anchors: [], spans: [], skipped: [], conflicts: [] })
  })
})

describe('seedClockFromProse', () => {
  it('reads a whole manuscript in order and anchors only the chapters that name a date', async () => {
    const run = await seedClockFromProse(store, [
      { number: 2, text: '三天后，2020年11月2日，他到了。' },
      { number: 1, text: '2020年10月14日，雨夜。' },
      { number: 3, text: '没有日期的一章。' },
    ])
    expect(run.start).toBe('2020-10-14')
    expect(run.anchors.map((item) => item.chapter)).toEqual([1, 2])
    expect((await store.timeline()).anchors.map((item) => item.when)).toEqual(['2020-10-14', '2020-11-02'])
  })
})
