/**
 * `novel_archive` end to end, with a fake child standing in for the model.
 *
 * The report that prompted this file said "novel_archive 走不动，只能手工读手工写".
 * The tool was fine — the *spawning* was broken, and every reader in the plugin
 * goes through it. These tests call the tool the way a session does, so "the
 * tool itself is broken" and "the host cannot spawn" stop being the same
 * sentence.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, fakeSubagents, valueOf, type Harness } from './helpers.ts'
import { ROLES } from '../src/roles.ts'

let harness: Harness | undefined

afterEach(async () => {
  if (harness) {
    await harness.cleanup()
    harness = undefined
  }
})

/**
 * A book that has already started writing, with two chapters of prose.
 *
 * The gate refuses prose before `drafting`, so the setup walks the same path a
 * real book does instead of reaching around the gate.
 */
async function imported(h: Harness): Promise<void> {
  valueOf(await h.call('novel_project', { action: 'init', title: '雾港' }))
  valueOf(await h.call('novel_project', {
    action: 'premise',
    premise: '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。'.repeat(4),
  }))
  valueOf(await h.call('novel_project', { action: 'advance' }))
  valueOf(await h.call('novel_canon', { action: 'upsert_character', name: '沈砚', role: 'protagonist', voice: '短句' }))
  valueOf(await h.call('novel_canon', { action: 'upsert_character', name: '阿鸢', role: 'supporting', voice: '快' }))
  valueOf(await h.call('novel_canon', { action: 'upsert_world', name: '雾港', kind: '地点', detail: '终年起雾' }))
  valueOf(await h.call('novel_project', { action: 'advance' }))
  valueOf(await h.call('novel_outline', { action: 'add_volume', number: 1, title: '入港' }))
  valueOf(await h.call('novel_outline', { action: 'approve_volume', number: 1 }))
  valueOf(await h.call('novel_outline', {
    action: 'add_chapter', number: 1, pov: '沈砚', characters: ['沈砚'],
    beats: ['沈砚下到三号货舱', '舱底传来声音'],
  }))
  valueOf(await h.call('novel_outline', {
    action: 'add_chapter', number: 2, pov: '沈砚', characters: ['沈砚'],
    beats: ['沈砚再下一次舱', '箱子自己开了'],
  }))
  valueOf(await h.call('novel_outline', { action: 'approve_chapter', number: 1 }))
  valueOf(await h.call('novel_outline', { action: 'approve_chapter', number: 2 }))
  valueOf(await h.call('novel_project', { action: 'advance' }))
  for (const number of [1, 2]) {
    valueOf(await h.call('novel_chapter', {
      action: 'write',
      number,
      text: `沈砚在第${number}章走进三号货舱。${'雾从缝隙里渗进来。'.repeat(10)}`,
    }))
  }
}

/** What the archivist answers with. */
const CARDS = JSON.stringify([
  { number: 1, summary: '沈砚第一次下到三号货舱。', events: ['下舱'], scene: '三号货舱', characters: ['沈砚'], hook: '舱底有声音。' },
  { number: 2, summary: '沈砚第二次下舱，听见了动静。', events: ['再下舱'], scene: '三号货舱', characters: ['沈砚'], hook: '箱子开了。' },
])

/** What the lorekeeper answers with. */
const LORE = JSON.stringify({
  characters: [{ name: '沈砚', appearance: '左手少半截指节', goal: '找到妹妹', secret: '', personality: '', quote: '他左手少了半截指节。' }],
  places: [{ name: '三号货舱', kind: '室内', detail: '终年渗水', quote: '雾从缝隙里渗进来。' }],
  world: [{ name: '漕帮', kind: '势力', detail: '管着半个港口的货', quote: '漕帮的人不走夜路。' }],
  premise: '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。',
})

function answer(call: { request: { persona?: string } }): string {
  if (call.request.persona === ROLES.archivist.persona) return CARDS
  if (call.request.persona === ROLES.lorekeeper.persona) return LORE
  return '[]'
}

describe('the archivist, called the way a session calls it', () => {
  it('writes chapter cards for the batch it was asked for', async () => {
    harness = await createHarness({}, fakeSubagents(answer))
    await imported(harness)

    const planned = valueOf<{ missing: number; next: number }>(await harness.call('novel_archive', { action: 'plan' }))
    expect(planned.missing).toBe(2)
    expect(planned.next).toBe(1)

    const applied = valueOf<{ written: number; missing: number }>(
      await harness.call('novel_archive', { action: 'apply', limit: 2 }),
    )
    expect(applied.written).toBe(2)
    expect(applied.missing).toBe(0)

    // Read the plans off disk: the tool list view deliberately shows titles and
    // approval state, not every card field.
    const saved = JSON.parse(await readFile(join(harness.root, 'outline/chapters.json'), 'utf8')) as {
      number: number
      summary?: string
      scene?: string
    }[]
    expect(saved.find((plan) => plan.number === 1)?.summary).toContain('沈砚第一次下到三号货舱')
    expect(saved.find((plan) => plan.number === 1)?.scene).toBe('三号货舱')
  })

  it('does the second batch only when asked, and says what is left', async () => {
    harness = await createHarness({}, fakeSubagents(answer))
    await imported(harness)
    const first = valueOf<{ written: number; missing: number; next: number }>(
      await harness.call('novel_archive', { action: 'apply', limit: 1 }),
    )
    expect(first.written).toBe(1)
    expect(first.missing).toBe(1)
    expect(first.next).toBe(2)
  })
})

describe('the lorekeeper, called the way a session calls it', () => {
  it('creates the cast, the place and the premise out of the prose', async () => {
    harness = await createHarness({}, fakeSubagents(answer))
    await imported(harness)

    const result = valueOf<{ written: number; report: string }>(
      await harness.call('novel_archive', { action: 'lore', from: 1, limit: 2 }),
    )
    expect(result.written).toBeGreaterThan(0)

    const canon = valueOf<{ report: string }>(await harness.call('novel_canon', { action: 'list' }))
    expect(canon.report).toContain('沈砚')
    expect(canon.report).toContain('三号货舱')

    const project = valueOf<{ premiseChars?: number; report?: string }>(await harness.call('novel_project', { action: 'status' }))
    expect(JSON.stringify(project)).toContain('船工')
  })
})

describe('when the host cannot spawn at all', () => {
  it('says the host is the problem, not the tool', async () => {
    // A context with a subagent seam that has neither generation of the call —
    // the exact state that produced "novel_archive 走不动".
    harness = await createHarness({}, { calls: [], service: { registerProvider: () => undefined } } as never)
    await imported(harness)
    const answerOut = await harness.call('novel_archive', { action: 'apply', limit: 1 })
    expect(answerOut.ok).toBe(false)
    expect(String(answerOut.ok === false ? answerOut.error : '')).toContain('子智能体接口')
  })
})
