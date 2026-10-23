import { describe, expect, it } from 'vitest'
import { beatCoverage, checkContract } from '../src/domain/contract.ts'
import { resolveConfig } from '../src/config.ts'
import type { ChapterPlan } from '../src/domain/types.ts'

const config = resolveConfig({ chapterMinWords: 100, chapterMaxWords: 4000 })

function plan(overrides: Partial<ChapterPlan> = {}): ChapterPlan {
  return {
    number: 3,
    volume: 1,
    title: '夜渡',
    pov: '沈砚',
    characters: ['沈砚', '阿鸢'],
    beats: ['沈砚发现船底藏着尸体', '阿鸢承认自己改过航向'],
    hooks: ['岸上有人等他'],
    approved: true,
    ...overrides,
  }
}

describe('beatCoverage', () => {
  it('reports full coverage when the beat vocabulary is present', () => {
    const coverage = beatCoverage(['沈砚发现船底藏着尸体'], '沈砚蹲下去，船底果然藏着东西，是一具尸体。')
    expect(coverage[0]?.ratio).toBeGreaterThan(0.4)
  })

  it('reports the missing vocabulary when the beat is absent', () => {
    const coverage = beatCoverage(['阿鸢承认改过航向'], '天亮了。')
    expect(coverage[0]?.ratio).toBe(0)
    expect(coverage[0]?.missing.length).toBeGreaterThan(0)
  })
})

describe('checkContract', () => {
  it('flags a required character who never appears', () => {
    const findings = checkContract(plan(), '沈砚一个人站在船头，风很大。', config)
    const missing = findings.find((item) => item.code === 'contract/character-missing')
    expect(missing?.severity).toBe('error')
    expect(missing?.message).toContain('阿鸢')
  })

  it('passes when everyone appears and the beats land', () => {
    const text = '沈砚发现船底藏着尸体。他回头看阿鸢，阿鸢承认自己改过航向，声音很轻。'
    const findings = checkContract(plan(), text, config)
    expect(findings.filter((item) => item.severity === 'error')).toHaveLength(0)
  })

  it('warns when the chapter is under the length floor', () => {
    const findings = checkContract(plan(), '沈砚和阿鸢站着。', resolveConfig({ chapterMinWords: 1800 }))
    expect(findings.some((item) => item.code === 'contract/too-short')).toBe(true)
  })

  it('warns when the viewpoint character is absent by name', () => {
    const findings = checkContract(plan(), '阿鸢一个人走了。', config)
    expect(findings.some((item) => item.code === 'contract/pov-missing')).toBe(true)
  })

  it('orders errors before warnings', () => {
    const findings = checkContract(plan(), '风很大。', resolveConfig({ chapterMinWords: 5000 }))
    expect(findings[0]?.severity).toBe('error')
  })
})
