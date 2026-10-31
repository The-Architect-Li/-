/**
 * Skill notes: the book's own craft rules, and the way back when one gets ruined.
 *
 * These go through the real tool surface on purpose — the gate, the store and
 * the history hook all have to agree, and a domain-only test would not notice if
 * `novel_skill` were registered but unreachable.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, valueOf, type Harness } from './helpers.ts'

const harnesses: Harness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
})

async function book(): Promise<Harness> {
  const harness = await createHarness()
  harnesses.push(harness)
  valueOf(await harness.call('novel_project', { action: 'init', title: '雾港' }))
  return harness
}

describe('novel_skill', () => {
  it('lists nothing until the first note exists, and says how to make one', async () => {
    const harness = await book()
    const report = valueOf<{ report: string }>(await harness.call('novel_skill', { action: 'list' })).report
    expect(report).toContain('还没有写作笔记')
  })

  it('writes, lists and reads one note', async () => {
    const harness = await book()
    valueOf(await harness.call('novel_skill', {
      action: 'write',
      name: '开篇钩子',
      text: '# 开篇钩子\n\n第一句必须留一个问题。\n',
    }))

    const listed = valueOf<{ skills: string[] }>(await harness.call('novel_skill', { action: 'list' }))
    expect(listed.skills).toEqual(['开篇钩子'])

    const read = valueOf<{ text: string }>(await harness.call('novel_skill', { action: 'read', name: '开篇钩子' }))
    expect(read.text).toContain('第一句必须留一个问题')
  })

  it('keeps the previous version when a note is overwritten', async () => {
    const harness = await book()
    await harness.call('novel_skill', { action: 'write', name: '对话', text: '# 对话\n\n不写「说道」。' })
    await harness.call('novel_skill', { action: 'write', name: '对话', text: '# 对话\n\n长短句交替。' })

    const history = valueOf<{ history: string[] }>(await harness.call('novel_backup', {
      action: 'history',
      target: 'skill:对话',
    }))
    expect(history.history).toHaveLength(1)
  })

  it('reverts one note without touching anything else', async () => {
    const harness = await book()
    await harness.call('novel_skill', { action: 'write', name: '对话', text: '# 对话\n\n不写「说道」。' })
    await harness.call('novel_skill', { action: 'write', name: '对话', text: '# 对话\n\n长短句交替。' })
    await harness.call('novel_skill', { action: 'write', name: '打斗', text: '# 打斗\n\n三招之内结束。' })

    const history = valueOf<{ history: string[] }>(await harness.call('novel_backup', {
      action: 'history',
      target: 'skill:对话',
    }))
    valueOf(await harness.call('novel_backup', {
      action: 'revert',
      target: 'skill:对话',
      rev: history.history[0],
    }))

    const read = valueOf<{ text: string }>(await harness.call('novel_skill', { action: 'read', name: '对话' }))
    expect(read.text).toContain('不写「说道」')

    const other = valueOf<{ text: string }>(await harness.call('novel_skill', { action: 'read', name: '打斗' }))
    expect(other.text).toContain('三招之内结束')
  })

  it('deletes a note but keeps its last version in history', async () => {
    const harness = await book()
    await harness.call('novel_skill', { action: 'write', name: '节奏', text: '# 节奏\n\n每三段一个转折。' })
    valueOf(await harness.call('novel_skill', { action: 'delete', name: '节奏' }))

    const listed = valueOf<{ skills: string[] }>(await harness.call('novel_skill', { action: 'list' }))
    expect(listed.skills).toEqual([])

    const history = valueOf<{ history: string[] }>(await harness.call('novel_backup', {
      action: 'history',
      target: 'skill:节奏',
    }))
    expect(history.history).toHaveLength(1)
  })

  it('will not let a name escape the skills folder', async () => {
    const harness = await book()
    await harness.call('novel_skill', { action: 'write', name: '../../pwned', text: '# x' })

    const files = await readdir(join(harness.root, 'skills'))
    expect(files).toHaveLength(1)
    expect(files[0]!.includes('/')).toBe(false)
    expect(files[0]!.includes('\\')).toBe(false)
    const escaped = await readFile(join(harness.root, 'pwned.md'), 'utf8').catch(() => undefined)
    expect(escaped).toBeUndefined()
  })

  it('refuses an empty write and an unknown read', async () => {
    const harness = await book()
    const empty = await harness.call('novel_skill', { action: 'write', name: '空', text: '   ' })
    expect(empty.ok).toBe(false)

    const missing = await harness.call('novel_skill', { action: 'read', name: '不存在' })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toContain('还没有任何笔记')
  })
})

describe('novel_dispatch action="card"', () => {
  it('returns the writer brief instead of spawning anyone', async () => {
    const harness = await book()
    valueOf(await harness.call('novel_project', {
      action: 'premise',
      premise: '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。'.repeat(4),
    }))
    valueOf(await harness.call('novel_project', { action: 'advance' }))
    valueOf(await harness.call('novel_canon', { action: 'upsert_character', name: '沈砚', role: 'protagonist', voice: '短句' }))
    valueOf(await harness.call('novel_canon', { action: 'upsert_character', name: '阿鸢', role: 'supporting', voice: '快' }))
    valueOf(await harness.call('novel_canon', { action: 'upsert_world', name: '雾港', kind: '地点', detail: '终年起雾' }))
    valueOf(await harness.call('novel_project', { action: 'advance' }))
    valueOf(await harness.call('novel_outline', { action: 'add_volume', number: 1, title: '入港' }))
    valueOf(await harness.call('novel_outline', { action: 'approve_volume', number: 1 }))
    valueOf(await harness.call('novel_outline', {
      action: 'add_chapter',
      number: 1,
      pov: '沈砚',
      characters: ['沈砚', '阿鸢'],
      beats: ['沈砚发现船底藏着尸体', '阿鸢承认改过航向'],
    }))
    valueOf(await harness.call('novel_outline', { action: 'approve_chapter', number: 1 }))
    valueOf(await harness.call('novel_project', { action: 'advance' }))

    const card = valueOf<{ report: string }>(await harness.call('novel_dispatch', {
      action: 'card',
      number: 1,
    }))
    expect(card.report).toContain('派单书')
    expect(card.report).toContain('沈砚')
    expect(harness.subagents.calls).toHaveLength(0)
  })
})
