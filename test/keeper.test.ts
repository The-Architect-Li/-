/**
 * The keeper: the role whose job is to move the record forward.
 *
 * It reads the chapter and the *state* — never the earlier prose — and answers
 * with a list of proposals that each map onto one existing write door. The
 * point of the role is the economics: if maintaining the state cost a re-read of
 * the book, the state would cost more than the reviewers it exists to replace.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, fakeSubagents, valueOf } from './helpers.ts'
import { ROLES, parseKeeperOutput } from '../src/roles.ts'

const PREMISE = '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。'.repeat(4)

/** The prompt is structured content; flatten it to the text the keeper reads. */
function promptText(call: { request: { prompt?: unknown } } | undefined): string {
  const parts = call?.request.prompt
  if (Array.isArray(parts)) {
    return parts.map((part) => (typeof part === 'string' ? part : String((part as { text?: string }).text ?? ''))).join('\n')
  }
  return String(parts ?? '')
}

/** What the keeper answers with: one fact, one place, and one unusable entry. */
const PROPOSALS = JSON.stringify([
  {
    kind: 'ledger',
    subject: '沈砚',
    key: '左手',
    value: '左手裹着布，写不了字',
    chapter: 1,
    quote: '他用左手压着账本，力气使不上',
  },
  {
    kind: 'place',
    subject: '雾港旧码头',
    key: '模样',
    value: '第三号仓的锁被换了',
    chapter: 1,
    quote: '锁是新的，铜还亮',
  },
  { kind: 'nonsense', subject: '阿鸢', key: '', value: '没有类型', chapter: 1, quote: '' },
  { kind: 'stage', subject: '阿鸢', key: '', value: '', chapter: 1, quote: '' },
])

function keeperAnswer(call: { request: { persona?: string } }): string {
  if (call.request.persona === ROLES.writer.persona) return '沈砚把伞收在门外，第三号仓的锁是新的。'
  if (call.request.persona === ROLES.keeper.persona) return PROPOSALS
  return JSON.stringify([])
}

/** A book already in drafting, with its volume and first chapter approved. */
async function ready(h: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
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
    [
      'novel_outline',
      {
        action: 'add_chapter',
        number: 1,
        title: '裂缝',
        pov: '沈砚',
        characters: ['沈砚'],
        beats: ['沈砚走了一趟码头', '账本上多了一笔'],
        hooks: ['雨没停'],
      },
    ],
    ['novel_outline', { action: 'approve_chapter', number: 1 }],
    ['novel_project', { action: 'advance' }],
    ['novel_chapter', { action: 'write', number: 1, text: '沈砚把伞收在门外，第三号仓的锁是新的。' }],
    ['novel_chapter', { action: 'propose', number: 1, text: '沈砚把伞收在门外，第三号仓的锁是新的。' }],
  ]
  for (const [tool, args] of steps) {
    const result = await h.call(tool, args)
    if (!result.ok) throw new Error(`${tool} ${JSON.stringify(args)} failed: ${result.error}`)
  }
}

describe('parseKeeperOutput', () => {
  it('keeps only the entries that could become a tool call', () => {
    const { items, parsed } = parseKeeperOutput(PROPOSALS)
    expect(parsed).toBe(true)
    // A kind nobody can write, and a proposal with no value, are both dropped:
    // a proposal the commander has to interpret is not a proposal.
    expect(items.map((item) => item.kind)).toEqual(['ledger', 'place'])
    expect(items[0]?.subject).toBe('沈砚')
  })

  it('says so when the answer is not a list at all', () => {
    expect(parseKeeperOutput('它觉得这一章挺好，没什么要记的。')).toEqual({ items: [], parsed: false })
  })
})

describe('dispatching the keeper', () => {
  let h: Awaited<ReturnType<typeof createHarness>>

  beforeEach(async () => {
    h = await createHarness({}, fakeSubagents(keeperAnswer))
    await ready(h)
  })

  afterEach(async () => {
    await h.cleanup()
  })

  it('proposes records and never writes them', async () => {
    const answer = await h.call('novel_dispatch', { action: 'keeper', number: 1 })
    const result = valueOf<{ proposals: { kind: string }[]; report: string }>(answer)
    expect(result.proposals.map((item) => item.kind)).toEqual(['ledger', 'place'])
    expect(result.report).toContain('[ledger] 沈砚·左手')
    expect(result.report).toContain('它只提案，写不写由你')
    // Nothing landed in the ledger as a side effect of asking.
    const facts = await h.call('novel_ledger', { action: 'query', subject: '沈砚' })
    expect(facts.ok).toBe(true)
    expect(valueOf<{ report: string }>(facts).report).not.toContain('写不了字')
  })

  it('reads the state, not the earlier prose', async () => {
    await h.call('novel_chapter', { action: 'write', number: 1, text: '沈砚把伞收在门外，第三号仓的锁是新的。' })
    await h.call('novel_dispatch', { action: 'keeper', number: 1, directive: '只看这一章' })
    const keeperPrompt = promptText(h.subagents.calls.at(-1))
    expect(keeperPrompt).toContain('## 这一章')
    expect(keeperPrompt).toContain('## 指挥官的特别要求')
    // No review window: the keeper costs one chapter, not a re-read.
    expect(keeperPrompt).not.toContain('## 前面几章的正文')
  })
})
