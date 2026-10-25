import { describe, expect, it } from 'vitest'
import { blockersFor, canEnter, evaluateAdvance, nextPhase, atLeast } from '../src/domain/phase.ts'
import { resolveConfig } from '../src/config.ts'
import type { Snapshot } from '../src/domain/types.ts'

const config = resolveConfig()

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    project: {
      formatVersion: 1,
      title: '雾港',
      phase: 'premise',
      premise: '',
      targetWords: 800000,
      createdAt: '',
      updatedAt: '',
    },
    characters: [],
    world: [],
    places: [],
    storyPoints: [],
    timeline: { formatVersion: 1, anchors: [], spans: [] },
    volumes: [],
    plans: [],
    ledger: [],
    chapters: [],
    ...overrides,
  }
}

describe('nextPhase', () => {
  it('walks the phases in order', () => {
    expect(nextPhase('premise')).toBe('canon')
    expect(nextPhase('drafting')).toBe('review')
  })

  it('stops at the end', () => {
    expect(nextPhase('done')).toBeNull()
  })
})

describe('atLeast', () => {
  it('compares positions, not names', () => {
    expect(atLeast('drafting', 'outline')).toBe(true)
    expect(atLeast('canon', 'outline')).toBe(false)
  })
})

describe('gates', () => {
  it('needs a premise of the configured length', () => {
    const blockers = blockersFor('canon', snapshot(), config)
    expect(blockers[0]).toContain('至少 80 字')
  })

  it('needs a protagonist and a second character to leave canon', () => {
    const state = snapshot({
      project: { ...snapshot().project, phase: 'canon' },
      characters: [
        { name: '沈砚', role: 'supporting', voice: '短句', appearance: '', goal: '', secret: '', updatedAt: '' },
      ],
      world: [{ name: '雾港', kind: '地点', detail: '终年起雾', updatedAt: '' }],
    })
    const blockers = blockersFor('outline', state, config)
    expect(blockers.join('\n')).toContain('至少 1 个主角')
    expect(blockers.join('\n')).toContain('至少 2 个角色')
  })

  it('needs every character to have a voice', () => {
    const state = snapshot({
      project: { ...snapshot().project, phase: 'canon' },
      characters: [
        { name: '沈砚', role: 'protagonist', voice: '', appearance: '', goal: '', secret: '', updatedAt: '' },
        { name: '阿鸢', role: 'supporting', voice: '快', appearance: '', goal: '', secret: '', updatedAt: '' },
      ],
      world: [{ name: '雾港', kind: '地点', detail: '终年起雾', updatedAt: '' }],
    })
    expect(blockersFor('outline', state, config).join('\n')).toContain('voice')
  })

  it('needs an approved volume and two beats per chapter before drafting', () => {
    const state = snapshot({
      project: { ...snapshot().project, phase: 'outline' },
      characters: [
        { name: '沈砚', role: 'protagonist', voice: '短句', appearance: '', goal: '', secret: '', updatedAt: '' },
        { name: '阿鸢', role: 'supporting', voice: '快', appearance: '', goal: '', secret: '', updatedAt: '' },
      ],
      volumes: [{ number: 1, title: '入港', summary: '', approved: false }],
      plans: [
        {
          number: 1,
          volume: 1,
          title: '入港',
          pov: '沈砚',
          characters: ['沈砚'],
          beats: ['只有一拍'],
          hooks: [],
          approved: true,
        },
      ],
    })
    const blockers = blockersFor('drafting', state, config)
    expect(blockers.join('\n')).toContain('已批准的分卷')
    expect(blockers.join('\n')).toContain('必写节拍')
  })

  it('names outline chapters that reference unknown characters', () => {
    const state = snapshot({
      project: { ...snapshot().project, phase: 'outline' },
      characters: [
        { name: '沈砚', role: 'protagonist', voice: '短句', appearance: '', goal: '', secret: '', updatedAt: '' },
        { name: '阿鸢', role: 'supporting', voice: '快', appearance: '', goal: '', secret: '', updatedAt: '' },
      ],
      volumes: [{ number: 1, title: '入港', summary: '', approved: true }],
      plans: [
        {
          number: 1,
          volume: 1,
          title: '入港',
          pov: '沈砚',
          characters: ['不存在的角色'],
          beats: ['一', '二'],
          hooks: [],
          approved: true,
        },
      ],
    })
    expect(blockersFor('drafting', state, config).join('\n')).toContain('不存在的角色')
  })
})

describe('canEnter', () => {
  it('is open when nothing blocks', () => {
    const state = snapshot({
      project: { ...snapshot().project, premise: '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。'.repeat(4) },
    })
    expect(canEnter('canon', state, config)).toEqual({ ok: true, blockers: [] })
  })
})

describe('evaluateAdvance', () => {
  it('returns the next phase when the gate is open', () => {
    const state = snapshot({
      project: { ...snapshot().project, premise: '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。'.repeat(4) },
    })
    expect(evaluateAdvance(state, config)).toMatchObject({ next: 'canon', ok: true })
  })

  it('reports the blockers when it is closed', () => {
    const result = evaluateAdvance(snapshot(), config)
    expect(result.ok).toBe(false)
    expect(result.blockers.length).toBeGreaterThan(0)
  })

  it('knows when the machine is finished', () => {
    const state = snapshot({ project: { ...snapshot().project, phase: 'done' } })
    expect(evaluateAdvance(state, config).done).toBe(true)
  })
})
