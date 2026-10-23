import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, fakeSubagents, valueOf, type SubagentCall } from './helpers.ts'
import { ROLES } from '../src/roles.ts'

const PREMISE = '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。'.repeat(4)
const GOOD_TEXT = '沈砚发现船底藏着尸体。他回头看阿鸢，阿鸢承认自己改过航向，声音很轻。风从舱口灌进来，灯焰歪了一下。岸上果然有人在等他。'

/** Script each role's reply by matching its persona. */
function responder(call: SubagentCall): string {
  const persona = call.request.persona ?? ''
  if (persona.includes(ROLES.writer.persona.slice(0, 6))) return GOOD_TEXT
  if (persona.includes('逻辑审核员')) {
    return JSON.stringify([{ severity: 'error', code: 'logic/time', message: '本章地点与账本不一致', evidence: '第1章' }])
  }
  if (persona.includes('角色一致性')) return JSON.stringify([])
  if (persona.includes('总审核')) {
    return JSON.stringify([{ severity: 'warn', code: 'chief/merged', message: '采纳逻辑审核的地点意见', evidence: '第1章' }])
  }
  return ''
}

describe('studio pipeline', () => {
  let h: Awaited<ReturnType<typeof createHarness>>

  beforeEach(async () => {
    h = await createHarness({}, fakeSubagents(responder))
  })
  afterEach(async () => {
    await h.cleanup()
  })

  async function setUpToDrafting(): Promise<void> {
    await h.call('novel_project', { action: 'init', title: '雾港' })
    await h.call('novel_project', { action: 'premise', premise: PREMISE })
    await h.call('novel_project', { action: 'advance' })
    await h.call('novel_canon', { action: 'upsert_character', name: '沈砚', role: 'protagonist', voice: '短句' })
    await h.call('novel_canon', { action: 'upsert_character', name: '阿鸢', role: 'supporting', voice: '快' })
    await h.call('novel_canon', { action: 'upsert_world', name: '雾港', kind: '地点', detail: '终年起雾' })
    await h.call('novel_project', { action: 'advance' })
    await h.call('novel_outline', { action: 'add_volume', number: 1, title: '入港' })
    await h.call('novel_outline', { action: 'approve_volume', number: 1 })
    await h.call('novel_outline', {
      action: 'add_chapter', number: 1, title: '夜渡', pov: '沈砚',
      characters: ['沈砚', '阿鸢'], beats: ['沈砚发现船底藏着尸体', '阿鸢承认改过航向'], hooks: ['岸上有人'],
    })
    await h.call('novel_outline', { action: 'approve_chapter', number: 1 })
    expect(valueOf<{ phase: string }>(await h.call('novel_project', { action: 'advance' })).phase).toBe('drafting')
  }

  it('runs writer → propose → reviewers → chief → commit end to end', async () => {
    await setUpToDrafting()

    // Set the writer's model per book; reviewers stay inherited.
    await h.call('novel_roles', { action: 'set', role: 'writer', provider: 'zai', model: 'glm-test' })

    // A reviewer before any draft is refused at the gate.
    const tooEarly = await h.call('novel_dispatch', { action: 'logic', number: 1 })
    expect(tooEarly.ok).toBe(false)
    if (!tooEarly.ok) expect(tooEarly.error).toContain('还没有草稿')

    // Writer produces the draft.
    const writer = valueOf<{ text: string; words: number }>(
      await h.call('novel_dispatch', { action: 'writer', number: 1, directive: '结尾留个反问' }),
    )
    expect(writer.text).toBe(GOOD_TEXT)
    expect(writer.words).toBeGreaterThan(0)

    // The writer call carried the per-book model route and an empty tool allow.
    const writerCall = h.subagents.calls[0]
    expect(writerCall?.request.agentOptions).toEqual({ provider: 'zai', model: 'glm-test' })
    expect(writerCall?.request.toolFilter).toEqual({ allow: [] })
    expect(writerCall?.request.persona).toBe(ROLES.writer.persona)

    // Save the draft and run the deterministic pre-check.
    const propose = valueOf<{ words: number; report: string }>(
      await h.call('novel_chapter', { action: 'propose', number: 1, text: writer.text }),
    )
    expect(propose.words).toBe(writer.words)
    expect(propose.report).toContain('草稿')

    // The two reviewers and the chief read the draft and return findings.
    const logic = valueOf<{ findings: unknown[] }>(await h.call('novel_dispatch', { action: 'logic', number: 1 }))
    expect(logic.findings).toHaveLength(1)
    const character = valueOf<{ findings: unknown[] }>(await h.call('novel_dispatch', { action: 'character', number: 1 }))
    expect(character.findings).toHaveLength(0)

    // Reviewers inherit the session model (no per-book route set).
    expect(h.subagents.calls[1]?.request.agentOptions).toBeUndefined()

    const chief = valueOf<{ findings: unknown[] }>(
      await h.call('novel_dispatch', {
        action: 'chief', number: 1,
        findings: [
          { role: 'logic', items: logic.findings },
          { role: 'character', items: character.findings },
        ],
      }),
    )
    expect(chief.findings).toHaveLength(1)

    // User nods: the draft becomes a chapter.
    const commit = valueOf<{ report: string }>(await h.call('novel_chapter', { action: 'commit', number: 1 }))
    expect(commit.report).toContain('定稿')

    const read = valueOf<{ report: string }>(await h.call('novel_chapter', { action: 'read', number: 1 }))
    expect(read.report).toContain(GOOD_TEXT)

    // Four dispatches in total, in pipeline order.
    expect(h.subagents.calls.map((call) => call.request.persona)).toEqual([
      ROLES.writer.persona, ROLES.logic.persona, ROLES.character.persona, ROLES.chief.persona,
    ])
  })

  it('keeps drafts out of the manuscript until commit', async () => {
    await setUpToDrafting()
    const writer = valueOf<{ text: string }>(await h.call('novel_dispatch', { action: 'writer', number: 1 }))
    await h.call('novel_chapter', { action: 'propose', number: 1, text: writer.text })

    // Before commit, reading the chapter says it does not exist.
    const preCommit = await h.call('novel_chapter', { action: 'read', number: 1 })
    expect(preCommit.ok).toBe(false)

    await h.call('novel_chapter', { action: 'commit', number: 1 })
    const postCommit = await h.call('novel_chapter', { action: 'read', number: 1 })
    expect(postCommit.ok).toBe(true)
  })
})
