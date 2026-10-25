/**
 * Reviewer notes and chapter versions.
 *
 * Two failures this guards against, both found by using the thing:
 * - a review round existed only in the chat log, so "five notes, three fixed"
 *   was unanswerable a week later;
 * - two editors saving the same chapter silently ate each other's work.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/domain/store.ts'
import { createHarness, fakeSubagents, valueOf, type Harness } from './helpers.ts'

const NOW = '2026-10-25T00:00:00.000Z'

/** A reviewer's answer, in the shape the reviewer contract asks for. */
const TWO_NOTES = JSON.stringify([
  { severity: 'error', code: 'logic/time', message: '第三节天已经黑了，第四节又写成正午。', evidence: '第三节' },
  { severity: 'warn', code: 'character/voice', message: '阿鸢这一句太文了，不像她。', evidence: '阿鸢：……' },
])

const GOOD_TEXT =
  '沈砚发现船底藏着尸体。他回头看阿鸢，阿鸢承认自己改过航向，声音很轻，只说了一句短话。风从舱口灌进来，灯焰歪了一下。岸上果然有人在等他。'

let stateHome: string
let harness: Harness

beforeAll(async () => {
  stateHome = await mkdtemp(join(tmpdir(), 'inkwell-reviews-home-'))
  process.env.DSH_HOME = stateHome
  harness = await createHarness({}, fakeSubagents(() => TWO_NOTES))
})

afterAll(async () => {
  delete process.env.DSH_HOME
  await harness.cleanup()
  await rm(stateHome, { recursive: true, force: true })
})

/**
 * Put the book straight into a writable state.
 *
 * The phase gates have their own tests (`phase.test.ts`, `e2e.test.ts`); this
 * file is about what happens after a chapter is already being written, so the
 * fixture cuts to that instead of walking five `advance` calls.
 */
async function readyBook(title: string): Promise<void> {
  const store = new ProjectStore(harness.root)
  await store.init(title, 120000)
  const project = await store.readProject()
  await store.writeProject({
    ...project,
    phase: 'drafting',
    premise: '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。'.repeat(3),
  })
  await store.upsertCharacter({ name: '沈砚', role: 'protagonist', voice: '短句', appearance: '', goal: '找到妹妹', secret: '', updatedAt: NOW })
  await store.upsertCharacter({ name: '阿鸢', role: 'supporting', voice: '半句话', appearance: '', goal: '', secret: '', updatedAt: NOW })
  await store.upsertWorld({ name: '雾港', kind: '地点', detail: '终年不散', updatedAt: NOW })
  await store.upsertVolume({ number: 1, title: '雾里的货单', summary: '', approved: true })
  await store.upsertPlan({
    number: 1,
    volume: 1,
    title: '裂缝',
    pov: '沈砚',
    characters: ['沈砚', '阿鸢'],
    beats: ['发现尸体', '阿鸢承认'],
    hooks: ['岸上有人在等'],
    approved: true,
  })
}

describe('review rounds on disk', () => {
  it('records what a reviewer said, who said it, and against which draft', async () => {
    await readyBook('审稿书')
    await valueOf(await harness.call('novel_chapter', { action: 'propose', number: 1, text: GOOD_TEXT }))
    const dispatch = await valueOf<{ report: string }>(
      await harness.call('novel_dispatch', { action: 'logic', number: 1 }),
    )
    expect(dispatch.report).toContain('第 1 轮）已记账')
    expect(dispatch.report).toContain('001-r1-1')

    const board = await valueOf<{ report: string }>(
      await harness.call('novel_chapter', { action: 'review', number: 1 }),
    )
    expect(board.report).toContain('第 1 轮')
    expect(board.report).toContain('第三节天已经黑了')
    expect(board.report).toContain('阿鸢这一句太文了')
  })

  it('lists the open notes with their ids so a writer can answer them', async () => {
    const board = await valueOf<{ report: string }>(
      await harness.call('novel_chapter', { action: 'review', number: 1 }),
    )
    expect(board.report).toContain('logic')
    expect(board.report).toContain('第三节天已经黑了')
    expect(board.report).toContain('001-r1-1')
  })

  it('marks a note fixed, and the board follows', async () => {
    const fixed = await valueOf<{ report: string }>(
      await harness.call('novel_chapter', {
        action: 'review',
        number: 1,
        id: '001-r1-1',
        state: 'fixed',
        note: '改成傍晚了',
      }),
    )
    expect(fixed.report).toContain('已改')
    expect(fixed.report).toContain('备注：改成傍晚了')
  })

  it('refuses to waive a note without a reason', async () => {
    const result = await harness.call('novel_chapter', {
      action: 'review',
      number: 1,
      id: '001-r1-2',
      state: 'waived',
    })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('waived 要在 note 里写清楚')
  })

  it('refuses an id nobody has, and says which ones exist', async () => {
    const result = await harness.call('novel_chapter', {
      action: 'review',
      number: 1,
      id: 'nope-r9-9',
      state: 'fixed',
    })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('没有 id 为「nope-r9-9」的审稿条目')
  })
})

describe('chapter versions', () => {
  it('stamps a revision on the first write', async () => {
    const write = await valueOf<{ report: string }>(
      await harness.call('novel_chapter', { action: 'write', number: 1, text: GOOD_TEXT }),
    )
    expect(write.report).toContain('第 1 版')
  })

  it('accepts a write that names the current version', async () => {
    const value = await valueOf<{ report: string }>(
      await harness.call('novel_chapter', { action: 'write', number: 1, text: `${GOOD_TEXT}我改的。`, revision: 1 }),
    )
    expect(value.report).toContain('第 2 版')
  })

  it('refuses a write based on a version that is gone', async () => {
    const result = await harness.call('novel_chapter', {
      action: 'write',
      number: 1,
      text: `${GOOD_TEXT}别人改的。`,
      revision: 1,
    })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('第 2 版')
    expect(result.ok ? '' : result.error).toContain('第 1 版')
  })

  it('lets a deliberate overwrite through force', async () => {
    const value = await valueOf<{ report: string }>(
      await harness.call('novel_chapter', { action: 'write', number: 1, text: `${GOOD_TEXT}强行覆盖。`, force: true }),
    )
    expect(value.report).toContain('第 3 版')
  })

  it('rolls a chapter back to an earlier draft round', async () => {
    await valueOf(await harness.call('novel_chapter', { action: 'propose', number: 1, text: `${GOOD_TEXT}第五稿。` }))
    const restore = await valueOf<{ report: string }>(
      await harness.call('novel_chapter', { action: 'restore', number: 1, round: 1, revision: 3 }),
    )
    expect(restore.report).toContain('第 1 轮草稿')
    expect(restore.report).toContain('第 4 版')
    const read = await valueOf<{ report: string }>(await harness.call('novel_chapter', { action: 'read', number: 1 }))
    // Round 1 was the first propose, so the chapter is back to that prose.
    expect(read.report).toContain('沈砚发现船底藏着尸体')
    expect(read.report).not.toContain('第五稿')
  })

  it('refuses to restore a round that does not exist', async () => {
    const result = await harness.call('novel_chapter', { action: 'restore', number: 1, round: 99, force: true })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('没有第 99 轮草稿')
  })

  it('reads a chapter written before revisions existed as version 1, and lets it be edited', async () => {
    // A book from v0.9 has chapter rows with no `revision` field at all. Handing
    // the panel a revision of 0 would make every edit of an old book fail the
    // "positive integer" check, so the legacy value has to be a usable one.
    const store = new ProjectStore(harness.root)
    const legacy = harness.root
    const index = JSON.parse(await readFile(join(legacy, 'chapters', 'index.json'), 'utf8')) as {
      number: number
      revision?: number
    }[]
    for (const row of index) delete row.revision
    await writeFile(join(legacy, 'chapters', 'index.json'), JSON.stringify(index, null, 2), 'utf8')

    const metas = await store.chapters()
    expect(metas[0]?.revision).toBe(1)

    const write = await valueOf<{ report: string }>(
      await harness.call('novel_chapter', { action: 'write', number: 1, text: `${GOOD_TEXT}旧书重写。`, revision: 1 }),
    )
    expect(write.report).toContain('第 2 版')
  })
})
