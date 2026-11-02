/**
 * One chapter, one command.
 *
 * The pipeline used to be six commands in a document. This is the test that the
 * six are actually called, in order, and that the last step is left to the
 * author — a round produces a draft, never a chapter.
 */
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

const PREMISE = '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。'.repeat(4)
const PROSE = '沈砚把伞收在门外。第三号仓的锁是新的，铜还亮着。他伸手推了一下，门开了。'

/** A book in drafting with one approved chapter and no prose yet. */
async function ready(h: Harness): Promise<void> {
  const steps: [string, Record<string, unknown>][] = [
    ['novel_project', { action: 'init', title: '雾港' }],
    ['novel_project', { action: 'premise', premise: PREMISE }],
    ['novel_project', { action: 'advance' }],
    ['novel_canon', { action: 'upsert_character', name: '沈砚', role: 'protagonist', voice: '短句' }],
    ['novel_canon', { action: 'upsert_character', name: '阿鸢', role: 'supporting', voice: '快' }],
    ['novel_canon', { action: 'upsert_world', name: '雾港', kind: '地点', detail: '终年起雾' }],
    ['novel_project', { action: 'advance' }],
    ['novel_outline', { action: 'add_volume', number: 1, title: '入港' }],
    ['novel_outline', { action: 'approve_volume', number: 1 }],
    ['novel_outline', {
      action: 'add_chapter', number: 1, pov: '沈砚', characters: ['沈砚'],
      beats: ['沈砚走了一趟码头', '账本上多了一笔'],
    }],
    ['novel_outline', { action: 'approve_chapter', number: 1 }],
    ['novel_project', { action: 'advance' }],
  ]
  for (const [tool, args] of steps) {
    const result = await h.call(tool, args)
    if (!result.ok) throw new Error(`${tool} failed: ${result.error}`)
  }
}

/** One finding from a reviewer, so the chief has something to rule on. */
function finding(severity: string, code: string, message: string) {
  return { severity, code, message, evidence: '原文一句' }
}

function answer(call: { request: { persona?: string } }): string {
  if (call.request.persona === ROLES.writer.persona) return PROSE
  if (call.request.persona === ROLES.logic.persona) return JSON.stringify([finding('warn', 'logic/gap', '雨从天降，没有交代')])
  if (call.request.persona === ROLES.character.persona) return JSON.stringify([finding('info', 'character/ok', '口吻一致')])
  if (call.request.persona === ROLES.chief.persona) {
    return JSON.stringify([finding('warn', 'logic/gap', '雨从天降，没有交代')])
  }
  return JSON.stringify([])
}

describe('novel_dispatch action="round"', () => {
  it('writes, files, reviews and adjudicates in one call', async () => {
    harness = await createHarness({}, fakeSubagents(answer))
    await ready(harness)

    const result = valueOf<{ report: string; words: number }>(
      await harness.call('novel_dispatch', { action: 'round', number: 1 }),
    )
    // The writer's own prose comes back, so a caller can show it without
    // reading the chapter file again.
    expect(result.words).toBeGreaterThan(20)
    expect(result.report).toContain('走完一轮')
    expect(result.report).toContain('第 1 轮草稿')
    expect(result.report).toContain('自动体检')
    expect(result.report).toContain('逻辑审核')
    expect(result.report).toContain('人物审核')
    expect(result.report).toContain('总裁决')
    // It says the one next thing, with the chapter number already in it.
    expect(result.report).toContain('novel_chapter action="commit" number=1')

    // Five spawns: writer, logic, character, chief — four roles, and no keeper.
    expect(harness.subagents.calls).toHaveLength(4)
  })

  it('leaves the prose as a draft, never as a chapter', async () => {
    // This is the whole product decision: the studio has an opinion, the author
    // has the file. A round that committed its own draft would be a tool that
    // publishes without asking.
    harness = await createHarness({}, fakeSubagents(answer))
    await ready(harness)
    await harness.call('novel_dispatch', { action: 'round', number: 1 })

    // Reading the chapter itself must fail: there is prose on disk, but it is
    // a draft, and `read` only ever reads committed chapters.
    const read = await harness.call('novel_chapter', { action: 'read', number: 1 })
    expect(read.ok).toBe(false)
    expect(String(read.ok === false ? read.error : '')).toContain('还没写')
  })

  it('tells the author what to fix when the chief blocks', async () => {
    harness = await createHarness({}, fakeSubagents((call) =>
      call.request.persona === ROLES.chief.persona
        ? JSON.stringify([finding('error', 'logic/contradiction', '锁是新的，但他昨天刚换过')])
        : answer(call),
    ))
    await ready(harness)
    const result = valueOf<{ report: string }>(await harness.call('novel_dispatch', { action: 'round', number: 1 }))
    expect(result.report).toContain('必改')
    expect(result.report).toContain('action="round" number=1')
  })

  it('says where the model failed rather than filing empty prose', async () => {
    harness = await createHarness({}, fakeSubagents((call) =>
      call.request.persona === ROLES.writer.persona ? '' : answer(call),
    ))
    await ready(harness)
    const result = await harness.call('novel_dispatch', { action: 'round', number: 1 })
    expect(result.ok).toBe(false)
    expect(String(result.ok === false ? result.error : '')).toContain('没有交回正文')
  })
})
