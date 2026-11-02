import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gateToolCall } from '../src/gate.ts'
import { ProjectStore } from '../src/domain/store.ts'
import { resolveConfig } from '../src/config.ts'

const roots: string[] = []
const config = resolveConfig({})

afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('the advice when a chapter has no plan', () => {
  /** A book in drafting, with one written chapter and no card for it. */
  async function drafted() {
    const dir = await mkdtemp(join(tmpdir(), 'inkwell-gate-'))
    roots.push(dir)
    const store = new ProjectStore(dir)
    await store.init('雾港', 800000)
    await store.writeProject({ ...(await store.readProject()), phase: 'drafting', premise: '一个替人销赃的船工，在货舱里找到了失踪的妹妹。' })
    await store.writeChapter(
      { number: 10, title: '仙子小奴婢', text: '路长远闭着眼，仔细听着那花魁的唱词。'.repeat(40), words: 2091, summary: '', writtenAt: '2026-01-01T00:00:00.000Z', revision: 1 },
      { baseRevision: undefined },
    )
    return store
  }

  it('points at the archive, not at an outline, for a chapter that is already written', async () => {
    // 「先写章纲」 about a chapter with 2091 words in it is advice that cannot be
    // followed: the prose is the source, the card is read off it.
    const store = await drafted()
    const reason = await gateToolCall('novel_chapter', { action: 'write', number: 10, text: 'x', title: 'y' }, store, config)
    expect(reason).toContain('已经有正文')
    expect(reason).toContain('novel_archive action="apply" from=10')
    expect(reason).not.toContain('add_chapter')
  })

  it('still asks for an outline when the chapter does not exist at all', async () => {
    const store = await drafted()
    const reason = await gateToolCall('novel_chapter', { action: 'write', number: 11, text: 'x', title: 'y' }, store, config)
    expect(reason).toContain('先调用 novel_outline')
    expect(reason).toContain('add_chapter')
  })
})
