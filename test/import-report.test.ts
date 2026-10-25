/**
 * What the scan says about itself.
 *
 * The report is the only thing standing between "the plugin found 85 chapters"
 * and "the plugin quietly found 30 and the author thinks the other 55 are
 * safe". So every line that warns about something — a cap, a clash, a card
 * without a voice — is asserted here rather than trusted.
 */
import { describe, expect, it } from 'vitest'
import type { ImportPlan, PlannedChapter } from '../src/domain/import-scan.ts'
import { describeScan, summarize } from '../src/domain/manuscript.ts'
import type { CharacterCard } from '../src/domain/types.ts'

const chapter = (number: number, words: number): PlannedChapter => ({
  number,
  title: `第${number}章`,
  text: '正文'.repeat(words / 2),
  words,
  summary: '',
  source: `正文/第${number}章.md`,
})

const card = (name: string, voice: string): CharacterCard => ({
  name,
  role: 'supporting',
  voice,
  appearance: '',
  goal: '',
  secret: '',
  updatedAt: '2026-10-01T00:00:00.000Z',
})

const plan = (over: Partial<ImportPlan> = {}): ImportPlan => ({
  chapters: [chapter(1, 3000), chapter(2, 2000)],
  cast: [
    { card: card('沈砚', ''), source: '人物/沈砚.md' },
    { card: card('林青', '话少，短句'), source: '人物/林青.md' },
  ],
  volumes: [],
  plans: [],
  premise: '',
  ignored: [],
  ...over,
})

describe('the scan report', () => {
  it('says what it read and where it would write', () => {
    const report = describeScan(summarize('E:/稿', plan(), new Set(), ['正文']), 'E:/书')
    expect(report).toContain('正文：2 章，共 5000 字')
    expect(report).toContain('会写进：E:/书')
  })

  it('names the cards the gate will hold on', () => {
    const report = describeScan(summarize('E:/稿', plan(), new Set(), ['正文']), undefined)
    expect(report).toContain('说话方式还空着：沈砚')
    expect(report).toContain('闸门会拦')
  })

  it('warns that the walk stopped early instead of pretending it read everything', () => {
    const summary = summarize('E:/稿', plan(), new Set(), ['正文'], true)
    expect(summary.capped).toBe(true)
    expect(describeScan(summary, undefined)).toContain('只读了前 5000 个')
  })

  it('says nothing about a cap when nothing was capped', () => {
    const report = describeScan(summarize('E:/稿', plan(), new Set(), ['正文']), undefined)
    expect(report).not.toContain('只读了前')
  })

  it('spells out an empty folder as an empty folder, not as an error', () => {
    const report = describeScan(
      summarize('E:/空', plan({ chapters: [], cast: [] }), new Set(), []),
      undefined,
    )
    expect(report).toContain('没找到能导入的东西')
    expect(report).toContain('正文/')
  })
})
