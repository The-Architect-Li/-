/**
 * The promises a book has made and not kept.
 *
 * What is worth guarding here is the difference between the three states: a
 * thread that was paid off, one the author gave up on, and one everybody
 * forgot. Collapsing the last two would let an abandoned line haunt the report
 * forever, and treating "paid" as the only way out would make dropping a line
 * impossible to record.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/domain/store.ts'
import {
  ageInChapters,
  describeThreads,
  dropThread,
  nextThreadId,
  openThreads,
  payThread,
  plantThread,
  staleThreads,
  stateOf,
  type Thread,
} from '../src/domain/threads.ts'

let root: string | undefined

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

async function book(): Promise<ProjectStore> {
  root = await mkdtemp(join(tmpdir(), 'inkwell-threads-'))
  const store = new ProjectStore(root)
  await store.init('雾港', 800000)
  return store
}

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: 't-0001',
    label: '那封没拆的信',
    planted: 38,
    quote: '她把信塞进袖子，没有拆。',
    paid: 0,
    dropped: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

describe('the three states', () => {
  it('tells open from paid from dropped', () => {
    expect(stateOf(thread())).toBe('open')
    expect(stateOf(thread({ paid: 200 }))).toBe('paid')
    expect(stateOf(thread({ dropped: true }))).toBe('dropped')
  })

  it('does not let a dropped thread claim to be paid', () => {
    // An abandoned line that also carries a payoff chapter would count as
    // settled business in one report and open in another.
    expect(stateOf(thread({ dropped: true, paid: 200 }))).toBe('dropped')
  })
})

describe('ageInChapters', () => {
  it('counts from the planting while open', () => {
    expect(ageInChapters(thread({ planted: 38 }), 300)).toBe(262)
  })

  it('counts from the payoff once settled', () => {
    expect(ageInChapters(thread({ planted: 38, paid: 200 }), 300)).toBe(100)
  })

  it('never goes negative on a book that has not reached the chapter yet', () => {
    expect(ageInChapters(thread({ planted: 400 }), 300)).toBe(0)
  })
})

describe('planting, paying, dropping', () => {
  it('stores a planted thread with the line it came from', async () => {
    const store = await book()
    const saved = await plantThread(store, { label: '那封没拆的信', chapter: 38, quote: '她把信塞进袖子，没有拆。' })
    expect(saved.id).toBe('t-0001')
    expect(saved.paid).toBe(0)
    expect((await store.threads())[0]?.quote).toContain('没有拆')
  })

  it('refuses a thread with no label or no chapter', async () => {
    const store = await book()
    await expect(plantThread(store, { label: '  ', chapter: 3 })).rejects.toThrow(/一句话/)
    await expect(plantThread(store, { label: 'x', chapter: 0 })).rejects.toThrow(/第几章/)
  })

  it('pays a thread off, keeping where it started', async () => {
    const store = await book()
    const saved = await plantThread(store, { label: '那封没拆的信', chapter: 38 })
    const paid = await payThread(store, saved.id, 200, '沈砚终于拆了信')
    expect(paid.planted).toBe(38)
    expect(paid.paid).toBe(200)
    expect(paid.payoff).toBe('沈砚终于拆了信')
    expect(stateOf(paid)).toBe('paid')
  })

  it('refuses a payoff chapter that is not a chapter', async () => {
    const store = await book()
    const saved = await plantThread(store, { label: 'x', chapter: 1 })
    await expect(payThread(store, saved.id, 0)).rejects.toThrow(/第几章/)
  })

  it('says so when the id is not there', async () => {
    const store = await book()
    await expect(payThread(store, 't-9999', 5)).rejects.toThrow(/没有这条伏笔/)
    await expect(dropThread(store, 't-9999')).rejects.toThrow(/没有这条伏笔/)
  })

  it('drops a thread and stops counting it as owed', async () => {
    const store = await book()
    const saved = await plantThread(store, { label: '掌门提到的第三个人', chapter: 91 })
    const dropped = await dropThread(store, saved.id, '这条线不打算写了')
    expect(stateOf(dropped)).toBe('dropped')
    expect(openThreads(await store.threads())).toEqual([])
    // Dropped is not paid: the difference is what a later reader would think.
    expect(dropped.paid).toBe(0)
    expect(dropped.notes).toContain('不打算写')
  })

  it('hands out ids that keep climbing', async () => {
    expect(nextThreadId([])).toBe('t-0001')
    expect(nextThreadId([thread({ id: 't-0012' }), thread({ id: 't-0003' })])).toBe('t-0013')
  })
})

describe('what the checker reports', () => {
  it('says nothing about a thread that is still fresh', () => {
    expect(staleThreads([thread({ planted: 290 })], 300)).toEqual([])
  })

  it('reports one that has been sitting past the threshold', () => {
    const findings = staleThreads([thread({ planted: 38 })], 300)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.code).toBe('thread/stale')
    expect(findings[0]?.message).toContain('262 章没动过')
    expect(findings[0]?.evidence).toContain('没有拆')
  })

  it('leaves settled threads out entirely', () => {
    const many = [
      thread({ id: 't-0001', paid: 100 }),
      thread({ id: 't-0002', dropped: true }),
      thread({ id: 't-0003', planted: 299 }),
    ]
    expect(staleThreads(many, 300)).toEqual([])
  })

  it('puts the longest-hanging first', () => {
    const many = [
      thread({ id: 't-0001', planted: 100, label: '较新' }),
      thread({ id: 't-0002', planted: 10, label: '更旧' }),
    ]
    expect(staleThreads(many, 300).map((finding) => finding.message.split('「')[1]?.split('」')[0])).toEqual(['更旧', '较新'])
  })

  it('uses the payoff chapter once a thread closed late', () => {
    // Paid at 295 means it stopped hanging at 295, whatever it was planted in.
    const findings = staleThreads([thread({ planted: 10, paid: 295 })], 300)
    expect(findings).toEqual([])
  })

  it('honours a custom threshold', () => {
    expect(staleThreads([thread({ planted: 290 })], 300, 5)).toHaveLength(1)
  })
})

describe('describeThreads', () => {
  it('explains how to plant one when the book has none', async () => {
    expect(describeThreads([], 0)).toContain('novel_ledger action="plant"')
  })

  it('lists what is owed before what is settled', () => {
    const report = describeThreads(
      [thread({ id: 't-0001', planted: 38 }), thread({ id: 't-0002', label: '旧约', planted: 10, paid: 90 })],
      300,
    )
    const open = report.indexOf('还欠着的')
    const settled = report.indexOf('已经有结果的')
    expect(open).toBeGreaterThan(-1)
    expect(settled).toBeGreaterThan(open)
    expect(report).toContain('还欠着 1 条')
    expect(report).toContain('章没动')
  })
})

describe('as a tool', () => {
  it('plants, lists, pays and drops through novel_ledger', async () => {
    const { createHarness, valueOf } = await import('./helpers.ts')
    const harness = await createHarness({})
    try {
      valueOf(await harness.call('novel_project', { action: 'init', title: '雾港' }))
      const planted = valueOf<{ id: string; report: string }>(
        await harness.call('novel_ledger', {
          action: 'plant',
          label: '那封没拆的信',
          chapter: 3,
          quote: '她把信塞进袖子。',
        }),
      )
      expect(planted.id).toBe('t-0001')
      expect(planted.report).toContain('第3章')

      const listed = valueOf<{ report: string; count: number }>(await harness.call('novel_ledger', { action: 'threads' }))
      expect(listed.count).toBe(1)
      expect(listed.report).toContain('那封没拆的信')

      const paid = valueOf<{ report: string }>(
        await harness.call('novel_ledger', { action: 'pay', id: 't-0001', chapter: 9, value: '拆了' }),
      )
      expect(paid.report).toContain('第3章埋')
      expect(paid.report).toContain('第9章收')

      const dropped = valueOf<{ report: string }>(
        await harness.call('novel_ledger', { action: 'drop', id: 't-0001', value: '不写了' }),
      )
      // The wording must not pretend dropping is the same as paying off.
      expect(dropped.report).toContain('不再提醒')
      expect(dropped.report).toContain('不是"收掉了"')
    } finally {
      await harness.cleanup()
    }
  })

  it('reports overdue threads from novel_check', async () => {
    const { createHarness, valueOf } = await import('./helpers.ts')
    const harness = await createHarness({})
    try {
      valueOf(await harness.call('novel_project', { action: 'init', title: '雾港' }))
      valueOf(await harness.call('novel_ledger', { action: 'plant', label: '旧约', chapter: 1 }))
      const checked = valueOf<{ report: string; warnings: number }>(await harness.call('novel_check', { action: 'threads' }))
      // No prose yet, so the book has not "gone by" any chapter: nothing is late.
      expect(checked.report).toContain('伏笔 1 条')
      expect(checked.warnings).toBe(0)
    } finally {
      await harness.cleanup()
    }
  })
})
