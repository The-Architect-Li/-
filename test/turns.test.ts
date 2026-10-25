/**
 * A person turning, not a person being overwritten.
 *
 * The card is written in the present tense: `personality` says who he is now and
 * keeps no memory of who he was. Rewriting it is how a character's growth gets
 * lost — three chapters later, 「他一直这么冷」 and 「他本来不这样，是第 40 章
 * 那件事之后才这样的」 look identical on the page.
 *
 * `recordTurn` is the difference: it writes the stage (before, where, why) first
 * and only then moves the card forward, so the history survives the rewrite.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { buildBriefing } from '../src/domain/briefing.ts'
import { currentStage, recordTurn } from '../src/domain/characters.ts'
import { resolveConfig } from '../src/config.ts'
import { ProjectStore } from '../src/domain/store.ts'
import { createHarness, valueOf, type Harness } from './helpers.ts'

const stateHome = await mkdtemp(join(tmpdir(), 'inkwell-turns-home-'))
process.env.DSH_HOME = stateHome
afterAll(async () => {
  delete process.env.DSH_HOME
  await rm(stateHome, { recursive: true, force: true })
})

let harness: Harness | undefined

afterEach(async () => {
  if (harness) await harness.cleanup()
  harness = undefined
})

/** A book with one card on it. */
async function book(): Promise<{ store: ProjectStore; host: Harness }> {
  harness = await createHarness()
  const store = new ProjectStore(harness.root)
  await store.init('雨书', 800_000)
  await store.upsertCharacter({
    name: '沈砚',
    role: 'protagonist',
    voice: '句子短。',
    appearance: '旧长衫。',
    goal: '查清那批货。',
    secret: '放行单是他签的。',
    personality: '认死理，不肯把话说圆。',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  return { store, host: harness }
}

describe('recordTurn', () => {
  it('writes the stage before it moves the card forward', async () => {
    const { store } = await book()
    const card = await recordTurn(store, {
      name: '沈砚',
      chapter: 40,
      before: '认死理，不肯把话说圆',
      after: '开始替人圆谎',
      cause: '他把阿蘅送走以后',
    })

    expect(card.personality).toBe('开始替人圆谎')
    expect(card.stages).toHaveLength(1)
    expect(card.stages?.[0]?.label).toBe('第40章 · 开始替人圆谎')
    expect(card.stages?.[0]?.chapter).toBe(40)
    expect(card.stages?.[0]?.cause).toBe('他把阿蘅送走以后')
    // The before has to survive somewhere: the card no longer says it.
    expect(card.stages?.[0]?.text).toContain('原来是认死理')
  })

  it('keeps the older stages and orders turns by chapter', async () => {
    const { store } = await book()
    await store.upsertCharacter({
      ...(await store.characters())[0]!,
      stages: [{ label: '码头少年', text: '替人扛包。' }],
    })
    await recordTurn(store, { name: '沈砚', chapter: 40, before: '冷', after: '软', cause: '那封信' })
    const card = await recordTurn(store, { name: '沈砚', chapter: 12, before: '硬', after: '冷', cause: '第一次收钱' })

    expect(card.stages?.map((stage) => stage.chapter)).toEqual([undefined, 12, 40])
    expect(currentStage(card)?.chapter).toBe(40)
  })

  it('treats a second record of the same chapter as a correction', async () => {
    const { store } = await book()
    await recordTurn(store, { name: '沈砚', chapter: 40, before: '冷', after: '软', cause: '那封信' })
    const card = await recordTurn(store, { name: '沈砚', chapter: 40, before: '冷', after: '彻底软了', cause: '那封信，以及她的死' })

    expect(card.stages).toHaveLength(1)
    expect(card.personality).toBe('彻底软了')
  })

  it('refuses a turn into nothing, and a turn with no cause', async () => {
    const { store } = await book()
    await expect(recordTurn(store, { name: '沈砚', chapter: 40, before: '冷', after: '', cause: '那封信' }))
      .rejects.toThrow('转变要写清')
    await expect(recordTurn(store, { name: '沈砚', chapter: 40, before: '冷', after: '软', cause: '   ' }))
      .rejects.toThrow('没有原因的变化只是偏离')
    await expect(recordTurn(store, { name: '沈砚', chapter: 0, before: '冷', after: '软', cause: '那封信' }))
      .rejects.toThrow('chapter 必须是正整数')
  })

  it('says which door makes the card first', async () => {
    const { store } = await book()
    await expect(recordTurn(store, { name: '阿蘅', chapter: 3, before: '纯', after: '不纯', cause: '那件事' }))
      .rejects.toThrow('先用 novel_canon action="upsert_character" 建卡')
  })
})

describe('novel_canon action="shift"', () => {
  it('records the turn and reports the before', async () => {
    const { store, host } = await book()
    const result = await host.call('novel_canon', {
      action: 'shift',
      name: '沈砚',
      chapter: 40,
      from: '认死理，不肯把话说圆',
      to: '开始替人圆谎',
      cause: '他把阿蘅送走以后',
    })
    const report = valueOf<{ report: string }>(result).report
    expect(report).toContain('第40章')
    expect(report).toContain('原来是认死理')
    expect((await store.characters())[0]?.personality).toBe('开始替人圆谎')
  })
})

describe('the briefing carries who he is now', () => {
  it('adds the current personality and the turn that produced it', async () => {
    const { store } = await book()
    await recordTurn(store, {
      name: '沈砚',
      chapter: 40,
      before: '认死理',
      after: '开始替人圆谎',
      cause: '他把阿蘅送走以后',
    })
    const snapshot = await store.snapshot()
    const markdown = buildBriefing(snapshot, await store.allChapters(), 41, resolveConfig()).markdown
    expect(markdown).toContain('现在：开始替人圆谎')
    expect(markdown).toContain('转折：第40章')
  })
})
