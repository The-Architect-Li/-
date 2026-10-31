/**
 * Search as a tool call and as a panel route.
 *
 * The domain walk is tested on its own; this is the part that proves the tool
 * takes the query from the right argument and that the panel can draw the
 * answer without a chat round trip.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, valueOf, type Harness } from './helpers.ts'

let harness: Harness | undefined

afterEach(async () => {
  if (harness) {
    await harness.cleanup()
    harness = undefined
  }
})

/** A book in drafting with three chapters of prose. */
async function written(h: Harness): Promise<void> {
  valueOf(await h.call('novel_project', { action: 'init', title: '雾港' }))
  valueOf(await h.call('novel_project', { action: 'premise', premise: '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。'.repeat(4) }))
  valueOf(await h.call('novel_project', { action: 'advance' }))
  valueOf(await h.call('novel_canon', { action: 'upsert_character', name: '沈砚', role: 'protagonist', voice: '短句' }))
  valueOf(await h.call('novel_canon', { action: 'upsert_character', name: '阿鸢', role: 'supporting', voice: '快' }))
  valueOf(await h.call('novel_canon', { action: 'upsert_world', name: '雾港', kind: '地点', detail: '终年起雾' }))
  valueOf(await h.call('novel_project', { action: 'advance' }))
  valueOf(await h.call('novel_outline', { action: 'add_volume', number: 1, title: '入港' }))
  valueOf(await h.call('novel_outline', { action: 'approve_volume', number: 1 }))
  // Each chapter's plan must name who actually walks on, or the contract refuses
  // the prose — chapter 2 belongs to 阿鸢 alone.
  for (const [number, cast] of [[1, ['沈砚']], [2, ['阿鸢']], [3, ['沈砚']]] as [number, string[]][]) {
    valueOf(await h.call('novel_outline', {
      action: 'add_chapter', number, pov: '沈砚', characters: cast,
      beats: ['下舱', '听见声音'],
    }))
    valueOf(await h.call('novel_outline', { action: 'approve_chapter', number }))
  }
  valueOf(await h.call('novel_project', { action: 'advance' }))
  valueOf(await h.call('novel_chapter', { action: 'write', number: 1, text: '沈砚走进瑶光境。雾很大。' }))
  valueOf(await h.call('novel_chapter', { action: 'write', number: 2, text: '阿鸢在码头等他。' }))
  valueOf(await h.call('novel_chapter', { action: 'write', number: 3, text: '沈砚又提起瑶光境，说那封信没拆。' }))
}

describe('novel_chapter action="search"', () => {
  it('takes the query from text and reports the chapters', async () => {
    harness = await createHarness({})
    await written(harness)
    const result = valueOf<{ report: string; chapters: string[] }>(
      await harness.call('novel_chapter', { action: 'search', text: '瑶光境' }),
    )
    expect(result.chapters).toEqual(['1', '3'])
    expect(result.report).toContain('第1章')
    expect(result.report).toContain('2 章命中')
  })

  it('reports nothing found rather than failing', async () => {
    harness = await createHarness({})
    await written(harness)
    const result = valueOf<{ report: string; chapters: string[] }>(
      await harness.call('novel_chapter', { action: 'search', text: '从未出现过的词' }),
    )
    expect(result.chapters).toEqual([])
    expect(result.report).toContain('没有找到')
  })

  it('refuses an empty query with something useful to say', async () => {
    harness = await createHarness({})
    await written(harness)
    const result = await harness.call('novel_chapter', { action: 'search', text: '  ' })
    expect(result.ok).toBe(false)
    expect(String(result.ok === false ? result.error : '')).toContain('要搜什么')
  })
})
