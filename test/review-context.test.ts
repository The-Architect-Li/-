/**
 * The reviewer's window: what a consistency reviewer can see of the chapters
 * before the one under review.
 *
 * Before v0.20 a reviewer saw only the chapter in front of it, so "cross-chapter
 * consistency" was a promise the prompt could not keep. The window is the fix:
 * the last few chapters in full, the ones before them as recaps, and an explicit
 * note about what it could not read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, fakeSubagents, valueOf } from './helpers.ts'
import { ROLES } from '../src/roles.ts'

const PREMISE = '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。'.repeat(4)

/** The prompt is structured content; flatten it to the text a reviewer reads. */
function promptText(call: { request: { prompt?: unknown } } | undefined): string {
  const parts = call?.request.prompt
  if (Array.isArray(parts)) {
    return parts.map((part) => (typeof part === 'string' ? part : String((part as { text?: string }).text ?? ''))).join('\n')
  }
  return String(parts ?? '')
}

function quiet(call: { request: { persona?: string } }): string {
  const persona = call.request.persona ?? ''
  if (persona === ROLES.writer.persona) return '沈砚把伞收在门外，雨还在下。'
  return JSON.stringify([])
}

/** A book already in drafting, with its volume and chapter approved. */
async function ready(h: Awaited<ReturnType<typeof createHarness>>, chapters: number): Promise<void> {
  await h.call('novel_project', { action: 'init', title: '雾港' })
  await h.call('novel_project', { action: 'premise', premise: PREMISE })
  await h.call('novel_project', { action: 'advance' })
  await h.call('novel_canon', { action: 'upsert_character', name: '沈砚', role: 'protagonist', voice: '短句' })
  await h.call('novel_canon', { action: 'upsert_character', name: '阿鸢', role: 'supporting', voice: '快' })
  await h.call('novel_canon', { action: 'upsert_world', name: '雾港', kind: '地点', detail: '终年起雾' })
  await h.call('novel_project', { action: 'advance' })
  await h.call('novel_outline', { action: 'add_volume', number: 1, title: '入港' })
  await h.call('novel_outline', { action: 'approve_volume', number: 1 })
  for (let number = 1; number <= chapters; number += 1) {
    await h.call('novel_outline', {
      action: 'add_chapter',
      number,
      title: `第${number}章`,
      pov: '沈砚',
      characters: ['沈砚'],
      beats: ['沈砚走了一趟码头', '账本上多了一笔'],
      hooks: ['雨没停'],
    })
    await h.call('novel_outline', { action: 'approve_chapter', number })
  }
  const advanced = await h.call('novel_project', { action: 'advance' })
  const phase = advanced.ok ? valueOf<{ phase: string; report: string }>(advanced).phase : ''
  if (phase !== 'drafting') {
    const report = advanced.ok ? valueOf<{ report: string }>(advanced).report : advanced.error
    throw new Error(`advance did not reach drafting: ${report}`)
  }
}

/** Write and commit one chapter's prose through the panel-free route. */
async function writeChapter(
  h: Awaited<ReturnType<typeof createHarness>>,
  number: number,
  text: string,
  revision?: number,
): Promise<void> {
  const result = await h.call('novel_chapter', {
    action: 'write',
    number,
    text,
    ...(revision === undefined ? {} : { revision }),
  })
  if (!result.ok) throw new Error(result.error)
}

describe('reviewer window in the prompt', () => {
  let h: Awaited<ReturnType<typeof createHarness>>

  beforeEach(async () => {
    h = await createHarness({}, fakeSubagents(quiet))
  })
  afterEach(async () => {
    await h.cleanup()
  })

  it('gives a reviewer the chapter before, and no more than that', async () => {
    await ready(h, 3)
    await writeChapter(h, 1, '第一章的正文：沈砚在码头等了一夜。')
    await writeChapter(h, 2, '第二章的正文：沈砚把账本合上了。')
    // Reviewers read a draft, so chapter 3 needs one before it can be reviewed.
    const proposed = await h.call('novel_chapter', {
      action: 'propose',
      number: 3,
      text: '第三章的正文：沈砚走进第三号仓，里面空着。',
    })
    expect(proposed.ok).toBe(true)

    const result = valueOf<{ findings: unknown[]; report: string }>(
      await h.call('novel_dispatch', { action: 'logic', number: 3 }),
    )
    expect(result.findings).toEqual([])

    const prompt = promptText(h.subagents.calls.at(-1))
    expect(prompt).toContain('## 前面几章的正文')
    expect(prompt).toContain('第二章的正文：沈砚把账本合上了。')
    // Continuity across many chapters is the chief's call, so a reviewer reads
    // only the seam: the chapter before, and nothing behind it.
    expect(prompt).not.toContain('第一章的正文：沈砚在码头等了一夜。')
    expect(prompt).not.toContain('## 更早几章的梗概')
    // The chapter under review is the draft itself, not a history entry.
    expect(prompt).not.toContain('### 第3章')
    // The dispatch report says what the window cost.
    expect(result.report).toContain('正文 第2章')
  })

  it('gives the chief the long window, because continuity is its job', async () => {
    await ready(h, 3)
    await writeChapter(h, 1, '第一章的正文：沈砚说那船货昨夜进的港。')
    await writeChapter(h, 2, '第二章的正文：沈砚翻到借方那栏，上面写着三个人的名字。')
    const proposed = await h.call('novel_chapter', {
      action: 'propose',
      number: 3,
      text: '第三章的正文：沈砚又问了一遍那船货是哪天到的。',
    })
    expect(proposed.ok).toBe(true)

    const result = valueOf<{ findings: unknown[]; report: string }>(
      await h.call('novel_dispatch', {
        action: 'chief',
        number: 3,
        findings: [{ role: 'logic', items: [{ severity: 'warn', code: 'logic/repeat', message: '同一件事问了两遍', evidence: '第三章' }] }],
      }),
    )
    expect(result.findings).toEqual([])

    const prompt = promptText(h.subagents.calls.at(-1))
    // The persona tells it to judge continuity, and the material is there to judge with.
    expect(prompt).toContain('和前面的章节对不上')
    expect(prompt).toContain('## 前面几章的正文')
    expect(prompt).toContain('第一章的正文：沈砚说那船货昨夜进的港。')
    expect(prompt).toContain('第二章的正文：沈砚翻到借方那栏，上面写着三个人的名字。')
    expect(prompt).toContain('## 各审核员意见')
    expect(prompt).toContain('同一件事问了两遍')
    expect(result.report).toContain('正文 第1–2章')
  })

  it('recaps the older chapters for the chief and states what it could not read', async () => {
    await ready(h, 13)
    for (let number = 1; number <= 12; number += 1) {
      await writeChapter(h, number, `第${number}章的正文，沈砚讲的是第${number}件小事。`)
      await h.call('novel_outline', { action: 'card', number, summary: `第${number}章：一件小事过去了` })
    }

    // Reviewing chapter 13: three chapters of prose, seven recaps, two unread.
    const proposed = await h.call('novel_chapter', {
      action: 'propose',
      number: 13,
      text: '第十三章的草稿：沈砚在雨里站到最后。',
    })
    expect(proposed.ok).toBe(true)
    await h.call('novel_dispatch', { action: 'chief', number: 13, findings: [] })
    const prompt = promptText(h.subagents.calls.at(-1))
    expect(prompt).toContain('## 前面几章的正文')
    expect(prompt).toContain('### 第10章')
    expect(prompt).toContain('第12章的正文，沈砚讲的是第12件小事。')
    expect(prompt).toContain('## 更早几章的梗概')
    expect(prompt).toContain('第3章：一件小事过去了')
    expect(prompt).toContain('更早的 2 章不在这次审稿范围内')
    // Recaps are cards, so no chapter 3 prose leaks into the prompt.
    expect(prompt).not.toContain('第3章的正文，沈砚讲的是第3件小事。')
  })
})

describe('stale chapter cards', () => {
  let h: Awaited<ReturnType<typeof createHarness>>

  beforeEach(async () => {
    h = await createHarness({}, fakeSubagents(quiet))
  })
  afterEach(async () => {
    await h.cleanup()
  })

  it('reports a card left behind by a later rewrite', async () => {
    await ready(h, 2)
    await writeChapter(h, 1, '沈砚看的是一张收不回来的放行单。')
    await h.call('novel_outline', { action: 'card', number: 1, summary: '第一版写的梗概' })

    // Rewriting the prose moves it to revision 2 while the card still says 1.
    await writeChapter(h, 1, '沈砚看的是一张收不回来的放行单，边角卷着，字迹晕开。', 1)

    const cards = valueOf<{ report: string }>(await h.call('novel_check', { action: 'cards' }))
    expect(cards.report).toContain('第1章')
    expect(cards.report).toContain('第 2 版')

    const all = valueOf<{ report: string }>(await h.call('novel_check', { action: 'all' }))
    expect(all.report).toContain('cards/stale')
    expect(all.report).toContain('第1章')

    // Re-saving the card from the current prose clears it.
    await h.call('novel_outline', { action: 'card', number: 1, summary: '第二版写的梗概' })
    const again = valueOf<{ report: string }>(await h.call('novel_check', { action: 'cards' }))
    expect(again.report).not.toContain('卡写在第')
  })
})

describe('a review round that proposes a turn', () => {
  let h: Awaited<ReturnType<typeof createHarness>>

  /** The character reviewer answers with one finding that carries a whole turn. */
  function answered(call: { request: { persona?: string } }): string {
    if ((call.request.persona ?? '') === ROLES.writer.persona) return '沈砚把账本合上了。'
    return JSON.stringify([
      {
        severity: 'warn',
        code: 'character/shift',
        message: '沈砚开始替人圆谎，这不是他的性格。',
        evidence: '「阿蘅的事，我不知道。」',
        shift: {
          name: '沈砚',
          chapter: 2,
          from: '认死理，不肯把话说圆',
          to: '开始替人圆谎',
          cause: '他撞见阿蘅半夜从账房出来，手里有父亲的账本',
        },
      },
    ])
  }

  beforeEach(async () => {
    h = await createHarness({}, fakeSubagents(answered))
  })
  afterEach(async () => {
    await h.cleanup()
  })

  it('hands the commander the call, arguments already filled', async () => {
    await ready(h, 2)
    await writeChapter(h, 1, '第一章：沈砚在码头等了一夜。')
    const proposed = await h.call('novel_chapter', {
      action: 'propose',
      number: 2,
      text: '第二章：沈砚把账本合上了，说不知道。',
    })
    expect(proposed.ok).toBe(true)

    const result = valueOf<{ shifts: { name: string }[]; report: string }>(
      await h.call('novel_dispatch', { action: 'character', number: 2 }),
    )
    expect(result.shifts).toHaveLength(1)
    expect(result.shifts[0]?.name).toBe('沈砚')
    expect(result.report).toContain('novel_canon action="shift"')
    expect(result.report).toContain('name="沈砚"')
    expect(result.report).toContain('参数已经填好了')
  })
})
