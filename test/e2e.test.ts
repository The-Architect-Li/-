import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, valueOf, type Harness } from './helpers.ts'

const PREMISE = '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。'.repeat(4)
const GOOD_TEXT = '沈砚发现船底藏着尸体。他回头看阿鸢，阿鸢承认自己改过航向。风从舱口灌进来，灯焰歪了一下。'

let harness: Harness

beforeEach(async () => {
  harness = await createHarness()
})

afterEach(async () => {
  await harness.cleanup()
})

describe('before a project exists', () => {
  it('refuses every tool except init', async () => {
    const status = await harness.call('novel_project', { action: 'status' })
    expect(status.ok).toBe(false)
    if (!status.ok) expect(status.error).toContain('novel_project')
  })

  it('allows init', async () => {
    const result = await harness.call('novel_project', { action: 'init', title: '雾港' })
    expect(result.ok).toBe(true)
  })
})

describe('phase gates', () => {
  beforeEach(async () => {
    await harness.call('novel_project', { action: 'init', title: '雾港' })
  })

  it('blocks writing before the draft phase', async () => {
    const result = await harness.call('novel_chapter', { action: 'write', number: 1, text: GOOD_TEXT })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('不能写正文')
      expect(result.error).toContain('premise')
    }
  })

  it('blocks a short premise from advancing', async () => {
    await harness.call('novel_project', { action: 'premise', premise: '一个船工' })
    const result = await harness.call('novel_project', { action: 'advance' })
    expect(result.ok).toBe(true)
    const value = valueOf<{ phase: string; report: string }>(result)
    expect(value.phase).toBe('premise')
    expect(value.report).toContain('至少 80 字')
  })

  it('advances once the premise is long enough', async () => {
    await harness.call('novel_project', { action: 'premise', premise: PREMISE })
    const result = await harness.call('novel_project', { action: 'advance' })
    expect(valueOf<{ phase: string }>(result).phase).toBe('canon')
  })

  it('refuses a chapter outline that names an unknown character', async () => {
    await harness.call('novel_project', { action: 'premise', premise: PREMISE })
    await harness.call('novel_project', { action: 'advance' })
    await harness.call('novel_canon', { action: 'upsert_character', name: '沈砚', role: 'protagonist', voice: '短句' })
    await harness.call('novel_canon', { action: 'upsert_character', name: '阿鸢', role: 'supporting', voice: '快' })
    await harness.call('novel_canon', { action: 'upsert_world', name: '雾港', kind: '地点', detail: '终年起雾' })
    await harness.call('novel_project', { action: 'advance' })

    const result = await harness.call('novel_outline', {
      action: 'add_chapter',
      number: 1,
      title: '入港',
      pov: '沈砚',
      characters: ['查无此人'],
      beats: ['甲', '乙'],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('查无此人')
  })

  it('refuses a chapter outline with fewer than two beats', async () => {
    await harness.call('novel_project', { action: 'premise', premise: PREMISE })
    await harness.call('novel_project', { action: 'advance' })
    await harness.call('novel_canon', { action: 'upsert_character', name: '沈砚', role: 'protagonist', voice: '短句' })
    await harness.call('novel_canon', { action: 'upsert_character', name: '阿鸢', role: 'supporting', voice: '快' })
    await harness.call('novel_canon', { action: 'upsert_world', name: '雾港', kind: '地点', detail: '终年起雾' })
    await harness.call('novel_project', { action: 'advance' })

    const result = await harness.call('novel_outline', {
      action: 'add_chapter',
      number: 1,
      characters: ['沈砚'],
      beats: ['只有一拍'],
    })
    expect(result.ok).toBe(false)
  })
})

describe('the full happy path', () => {
  it('produces a chapter with a traceable fact ledger', async () => {
    await harness.call('novel_project', { action: 'init', title: '雾港' })
    await harness.call('novel_project', { action: 'premise', premise: PREMISE })
    await harness.call('novel_project', { action: 'advance' })

    await harness.call('novel_canon', {
      action: 'upsert_character',
      name: '沈砚',
      role: 'protagonist',
      voice: '短句，回答前先停顿',
      appearance: '左手少一根指节',
    })
    await harness.call('novel_canon', {
      action: 'upsert_character',
      name: '阿鸢',
      role: 'supporting',
      voice: '语速快，爱用反问',
    })
    await harness.call('novel_canon', { action: 'upsert_world', name: '雾港', kind: '地点', detail: '终年起雾' })
    expect(valueOf<{ phase: string }>(await harness.call('novel_project', { action: 'advance' })).phase).toBe('outline')

    await harness.call('novel_outline', { action: 'add_volume', number: 1, title: '入港', summary: '接一单货' })
    await harness.call('novel_outline', { action: 'approve_volume', number: 1 })
    await harness.call('novel_outline', {
      action: 'add_chapter',
      number: 1,
      title: '夜渡',
      pov: '沈砚',
      characters: ['沈砚', '阿鸢'],
      beats: ['沈砚发现船底藏着尸体', '阿鸢承认改过航向'],
    })

    expect(valueOf<{ phase: string }>(await harness.call('novel_project', { action: 'advance' })).phase).toBe('drafting')

    // The phase is right, but an unapproved contract still blocks the pen.
    const tooEarly = await harness.call('novel_chapter', { action: 'write', number: 1, text: GOOD_TEXT })
    expect(tooEarly.ok).toBe(false)
    if (!tooEarly.ok) expect(tooEarly.error).toContain('批准')

    await harness.call('novel_outline', { action: 'approve_chapter', number: 1 })

    const briefing = valueOf<{ report: string; chars: number }>(
      await harness.call('novel_briefing', { chapter: 1 }),
    )
    expect(briefing.report).toContain('本章合同')
    expect(briefing.report).toContain('说话方式')

    // A draft that drops a contracted character is refused, not saved.
    const missingCast = await harness.call('novel_chapter', {
      action: 'write',
      number: 1,
      text: '沈砚一个人在船头站着，风很大。',
    })
    expect(missingCast.ok).toBe(false)
    if (!missingCast.ok) {
      expect(missingCast.error).toContain('阿鸢')
      expect(missingCast.error).toContain('没有保存')
    }

    const written = valueOf<{ words: number; report: string }>(
      await harness.call('novel_chapter', { action: 'write', number: 1, text: GOOD_TEXT }),
    )
    expect(written.words).toBeGreaterThan(20)
    expect(written.report).toContain('已保存')

    const fact = valueOf<{ id: string }>(await harness.call('novel_ledger', {
      action: 'record',
      subject: '沈砚',
      predicate: '左眼颜色',
      value: '黑',
      chapter: 1,
      quote: '他的左眼黑得像井',
    }))
    expect(fact.id).toBe('f-0001')

    const conflict = await harness.call('novel_ledger', {
      action: 'record',
      subject: '沈砚',
      predicate: '左眼颜色',
      value: '蓝',
      chapter: 1,
    })
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) {
      expect(conflict.error).toContain('同一章内自相矛盾')
      expect(conflict.error).toContain('f-0001')
    }

    const replacement = await harness.call('novel_ledger', {
      action: 'record',
      subject: '沈砚',
      predicate: '左眼颜色',
      value: '蓝',
      chapter: 2,
      supersedes: 'f-0001',
    })
    expect(replacement.ok).toBe(true)

    const audit = valueOf<{ report: string }>(await harness.call('novel_check', { action: 'all' }))
    expect(audit.report).toContain('体检')
  })

  it('resets approval when the outline is edited again', async () => {
    await harness.call('novel_project', { action: 'init', title: '雾港' })
    await harness.call('novel_project', { action: 'premise', premise: PREMISE })
    await harness.call('novel_project', { action: 'advance' })
    await harness.call('novel_canon', { action: 'upsert_character', name: '沈砚', role: 'protagonist', voice: '短句' })
    await harness.call('novel_canon', { action: 'upsert_character', name: '阿鸢', role: 'supporting', voice: '快' })
    await harness.call('novel_canon', { action: 'upsert_world', name: '雾港', kind: '地点', detail: '终年起雾' })
    await harness.call('novel_project', { action: 'advance' })
    await harness.call('novel_outline', { action: 'add_volume', number: 1, title: '入港' })
    await harness.call('novel_outline', { action: 'approve_volume', number: 1 })
    await harness.call('novel_outline', {
      action: 'add_chapter',
      number: 1,
      characters: ['沈砚', '阿鸢'],
      beats: ['甲', '乙'],
    })
    await harness.call('novel_outline', { action: 'approve_chapter', number: 1 })
    await harness.call('novel_project', { action: 'advance' })

    await harness.call('novel_outline', {
      action: 'add_chapter',
      number: 1,
      characters: ['沈砚', '阿鸢'],
      beats: ['甲', '乙', '丙'],
    })

    const blocked = await harness.call('novel_chapter', { action: 'write', number: 1, text: GOOD_TEXT })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error).toContain('批准')
  })
})
