/**
 * Staleness is one rule, not three special cases.
 *
 * A chapter card has been checked against its prose since v0.20. But a place's
 * state and a character's stage are the same kind of thing: a reading of a
 * chapter, stored as if it were a fact. Rewrite the chapter and all three go
 * stale; only the card used to say so.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, fakeSubagents, valueOf, type Harness } from './helpers.ts'

const PREMISE = '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。'.repeat(4)

let h: Harness

afterEach(async () => {
  await h.cleanup()
})

/** A book in drafting with one approved chapter. */
async function ready(): Promise<void> {
  await h.call('novel_project', { action: 'init', title: '雾港' })
  await h.call('novel_project', { action: 'premise', premise: PREMISE })
  await h.call('novel_project', { action: 'advance' })
  await h.call('novel_canon', { action: 'upsert_character', name: '沈砚', role: 'protagonist', voice: '短句' })
  await h.call('novel_canon', { action: 'upsert_character', name: '阿鸢', role: 'supporting', voice: '快' })
  await h.call('novel_canon', { action: 'upsert_world', name: '雾港', kind: '地点', detail: '终年起雾' })
  const canon = await h.call('novel_project', { action: 'advance' })
  if (!canon.ok) throw new Error(`advance to outline failed: ${canon.error}`)
  await h.call('novel_outline', { action: 'add_volume', number: 1, title: '入港' })
  await h.call('novel_outline', { action: 'approve_volume', number: 1 })
  await h.call('novel_outline', {
    action: 'add_chapter',
    number: 1,
    title: '裂缝',
    pov: '沈砚',
    characters: ['沈砚'],
    beats: ['沈砚走了一趟码头', '账本上多了一笔'],
    hooks: ['雨没停'],
  })
  await h.call('novel_outline', { action: 'approve_chapter', number: 1 })
  const advanced = await h.call('novel_project', { action: 'advance' })
  if (!advanced.ok) throw new Error(`advance to drafting failed: ${advanced.error}`)
}

/** Write chapter one, optionally over an earlier version. */
async function write(text: string, revision?: number): Promise<void> {
  const result = await h.call('novel_chapter', {
    action: 'write',
    number: 1,
    text,
    ...(revision === undefined ? {} : { revision }),
  })
  if (!result.ok) throw new Error(result.error)
}

describe('records read off a rewritten chapter', () => {
  beforeEach(async () => {
    h = await createHarness({}, fakeSubagents(() => '沈砚把伞收在门外。'))
  })

  it('says nothing while the prose has not moved', async () => {
    await ready()
    await write('沈砚把伞收在门外，码头还亮着灯。')
    await h.call('novel_canon', { action: 'upsert_place', name: '码头', detail: '湿的，灯一直亮着', chapter: 1 })
    await h.call('novel_canon', {
      action: 'shift',
      name: '沈砚',
      chapter: 1,
      from: '认死理',
      to: '开始替人圆谎',
      cause: '他把阿鸢送走以后',
    })

    const report = valueOf<{ report: string }>(await h.call('novel_check', { action: 'stale' })).report
    expect(report).toContain('都对得上')
  })

  it('reports the place state and the stage once the chapter is rewritten', async () => {
    await ready()
    await write('沈砚把伞收在门外，码头还亮着灯。')
    await h.call('novel_canon', { action: 'upsert_place', name: '码头', detail: '湿的，灯一直亮着', chapter: 1 })
    await h.call('novel_canon', {
      action: 'shift',
      name: '沈砚',
      chapter: 1,
      from: '认死理',
      to: '开始替人圆谎',
      cause: '他把阿鸢送走以后',
    })

    // The prose moves to revision 2; the records were read off revision 1.
    await write('沈砚把伞收在门外，码头一片漆黑，灯早灭了。', 1)

    const report = valueOf<{ report: string }>(await h.call('novel_check', { action: 'stale' })).report
    expect(report).toContain('地点：码头')
    expect(report).toContain('阶段：沈砚')
    expect(report).toContain('第 2 版')
  })

  it('surfaces in the full sweep as its own finding', async () => {
    await ready()
    await write('沈砚把伞收在门外，码头还亮着灯。')
    await h.call('novel_canon', { action: 'upsert_place', name: '码头', detail: '湿的，灯一直亮着', chapter: 1 })
    await write('沈砚把伞收在门外，码头一片漆黑，灯早灭了。', 1)

    const all = valueOf<{ report: string }>(await h.call('novel_check', { action: 'all' })).report
    expect(all).toContain('records/stale')
  })

  it('clears when the record is written again from the current prose', async () => {
    await ready()
    await write('沈砚把伞收在门外，码头还亮着灯。')
    await h.call('novel_canon', { action: 'upsert_place', name: '码头', detail: '湿的，灯一直亮着', chapter: 1 })
    await write('沈砚把伞收在门外，码头一片漆黑，灯早灭了。', 1)
    await h.call('novel_canon', { action: 'upsert_place', name: '码头', detail: '湿的，灯全灭了', chapter: 1 })

    const report = valueOf<{ report: string }>(await h.call('novel_check', { action: 'stale' })).report
    expect(report).toContain('都对得上')
  })
})
