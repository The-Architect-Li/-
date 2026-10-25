/**
 * Story points and the book's clock, through the tools the model calls.
 *
 * The two tools encode one rule each, and both rules exist because a long book
 * breaks them silently: a new story point that was never opened mixes with the
 * old one, and a date nobody wrote down gets remembered wrong three chapters
 * later. So these tests are about the refusals as much as the happy path.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, valueOf, type Harness } from './helpers.ts'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

/** Mount the plugin over a temporary project and initialise a book. */
async function start(): Promise<Harness> {
  const created = await createHarness()
  harness = created
  valueOf(await created.call('novel_project', { action: 'init', title: '雾港', targetWords: 120000 }))
  return created
}

describe('novel_story', () => {
  it('opens a point at the chapter it starts in', async () => {
    const host = await start()
    const value = valueOf<{ report: string }>(
      await host.call('novel_story', { action: 'add', name: '翻身', number: 1, premise: '王上从码头混进上势', characters: ['王上'] }),
    )
    expect(value.report).toContain('sp-001')
    expect(value.report).toContain('翻身')

    const listed = valueOf<{ report: string }>(await host.call('novel_story', { action: 'list' }))
    expect(listed.report).toContain('第1章起')
  })

  it('refuses to open a second point while the first is still running', async () => {
    const host = await start()
    valueOf(await host.call('novel_story', { action: 'add', name: '翻身', number: 1, premise: '混进上势' }))
    const second = await host.call('novel_story', { action: 'add', name: '出事', number: 12, premise: '货单暴露' })
    expect(second.ok).toBe(false)
    if (second.ok) return
    // The refusal has to name the way out, or the model just retries blindly.
    expect(second.error).toContain('还没收尾')
    expect(second.error).toContain('close')
  })

  it('closes a point at the chapter it ends in and lets the next one open', async () => {
    const host = await start()
    valueOf(await host.call('novel_story', { action: 'add', name: '翻身', number: 1, premise: '混进上势' }))
    const closed = valueOf<{ report: string }>(await host.call('novel_story', { action: 'close', number: 11 }))
    expect(closed.report).toContain('第1–11章')
    const second = valueOf<{ report: string }>(
      await host.call('novel_story', { action: 'add', name: '塌方', number: 12, premise: '旧事翻上来' }),
    )
    expect(second.report).toContain('sp-002')
  })

  it('refuses a close that ends before the point began', async () => {
    const host = await start()
    valueOf(await host.call('novel_story', { action: 'add', name: '翻身', number: 11, premise: '混进上势' }))
    const bad = await host.call('novel_story', { action: 'close', number: 3 })
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error).toContain('还早')
  })

  it('answers which point a chapter belongs to', async () => {
    const host = await start()
    valueOf(await host.call('novel_story', { action: 'add', name: '翻身', number: 1, premise: '混进上势' }))
    const at = valueOf<{ report: string }>(await host.call('novel_story', { action: 'at', number: 9 }))
    expect(at.report).toContain('翻身')
    expect(at.report).toContain('第9章属于')
  })

  it('says nothing is assigned before the first point exists', async () => {
    const host = await start()
    const at = valueOf<{ report: string }>(await host.call('novel_story', { action: 'at', number: 1 }))
    expect(at.report).toContain('还不在任何故事点里')
  })
})

describe('novel_timeline', () => {
  it('pins the book start, and the rail counts from there', async () => {
    const host = await start()
    const pinned = valueOf<{ report: string; at: string }>(
      await host.call('novel_timeline', { action: 'start', when: '2020-10' }),
    )
    expect(pinned.at).toBe('2020-10')
    expect(pinned.report).toContain('起点定在 2020-10')
    const again = valueOf<{ report: string }>(await host.call('novel_timeline', { action: 'start', when: '' }))
    expect(again.report).toContain('起点清掉了')
  })

  it('rejects a start it cannot parse instead of pinning a guess', async () => {
    const host = await start()
    const bad = await host.call('novel_timeline', { action: 'start', when: '很久以前' })
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error).toContain('2019-01')
  })

  it('turns an anchor plus a span into a date for a later chapter', async () => {
    const host = await start()
    valueOf(await host.call('novel_timeline', { action: 'anchor', chapter: 1, when: '2019-03', label: '开局' }))
    const span = valueOf<{ report: string }>(
      await host.call('novel_timeline', { action: 'span', from: 1, to: 4, text: '过了两三个月' }),
    )
    expect(span.report).toContain('60–90 天')
    const at = valueOf<{ at: string }>(await host.call('novel_timeline', { action: 'at', chapter: 4 }))
    expect(at.at).toMatch(/^2019-0[45]/)
  })

  it('rejects a duration it cannot read instead of storing a guess', async () => {
    const host = await start()
    valueOf(await host.call('novel_timeline', { action: 'anchor', chapter: 1, when: '2019-03' }))
    const bad = await host.call('novel_timeline', { action: 'span', from: 1, to: 3, text: '过了一阵子' })
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error).toContain('读不出时长')
    expect(bad.error).toContain('过了两三个月')
  })

  it('rejects a date it cannot parse, quoting the accepted shapes', async () => {
    const host = await start()
    const bad = await host.call('novel_timeline', { action: 'anchor', chapter: 1, when: '去年' })
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error).toContain('2019-01')
  })

  it('catches a recall that says the wrong month', async () => {
    const host = await start()
    valueOf(await host.call('novel_timeline', { action: 'anchor', chapter: 1, when: '2019-03' }))
    const recall = valueOf<{ report: string; findings: number }>(
      await host.call('novel_timeline', { action: 'recall', chapter: 3, about: '那船货', eventChapter: 1, claimed: '2019-08' }),
    )
    expect(recall.findings).toBeGreaterThan(0)
    expect(recall.report).toContain('回忆')
  })

  it('accepts a recall that matches the clock', async () => {
    const host = await start()
    valueOf(await host.call('novel_timeline', { action: 'anchor', chapter: 1, when: '2019-03' }))
    const recall = valueOf<{ findings: number; report: string }>(
      await host.call('novel_timeline', { action: 'recall', chapter: 3, about: '那船货', eventChapter: 1, claimed: '2019-03' }),
    )
    expect(recall.findings).toBe(0)
    expect(recall.report).toContain('不矛盾')
  })

  it('keeps recalls on disk instead of dropping them on the next write', async () => {
    const host = await start()
    valueOf(await host.call('novel_timeline', { action: 'anchor', chapter: 1, when: '2019-03' }))
    valueOf(await host.call('novel_timeline', { action: 'recall', chapter: 3, about: '那船货', eventChapter: 1, claimed: '2019-03' }))
    const listed = valueOf<{ report: string }>(await host.call('novel_timeline', { action: 'list' }))
    expect(listed.report).toContain('回忆（1）')
    expect(listed.report).toContain('那船货')
  })

  it('says the time is unknown rather than inventing one', async () => {
    const host = await start()
    const at = valueOf<{ at: string; report: string }>(await host.call('novel_timeline', { action: 'at', chapter: 3 }))
    expect(at.at).toBe('')
    expect(at.report).toContain('还不知道')
  })
})
