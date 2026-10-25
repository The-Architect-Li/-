import { describe, expect, it } from 'vitest'
import {
  ROLES,
  buildChiefPrompt,
  buildReviewerPrompt,
  buildWriterPrompt,
  describeRoute,
  parseReviewerOutput,
  resolveRoleRoute,
  unparsedFinding,
} from '../src/roles.ts'
import { resolveConfig } from '../src/config.ts'
import type { ChapterDraft, InkwellConfig, RoleId, Snapshot } from '../src/domain/types.ts'

const config = resolveConfig()

function snapshot(): Snapshot {
  return {
    project: { formatVersion: 1, title: '雾港', phase: 'drafting', premise: 'x', targetWords: 1, createdAt: '', updatedAt: '' },
    characters: [
      { name: '沈砚', role: 'protagonist', voice: '短句', appearance: '', goal: '找人', secret: '烧过船', updatedAt: '' },
      { name: '阿鸢', role: 'supporting', voice: '快', appearance: '', goal: '航图', secret: '改过航', updatedAt: '' },
    ],
    world: [{ name: '雾港', kind: '地点', detail: '起雾', updatedAt: '' }],
    places: [],
    storyPoints: [],
    timeline: { formatVersion: 1, anchors: [], spans: [] },
    volumes: [{ number: 1, title: '入港', summary: '', approved: true }],
    plans: [{
      number: 1, volume: 1, title: '夜渡', pov: '沈砚',
      characters: ['沈砚', '阿鸢'], beats: ['沈砚发现船底藏着尸体', '阿鸢承认改过航向'], hooks: ['岸上有人'], approved: true,
    }],
    ledger: [{ id: 'f-0001', subject: '沈砚', predicate: '左眼颜色', value: '黑', chapter: 1, quote: '黑得像井', supersedes: null, createdAt: '' }],
    chapters: [],
  }
}

const drafts: ChapterDraft[] = []

describe('resolveRoleRoute', () => {
  it('returns undefined when nothing is configured', () => {
    expect(resolveRoleRoute('writer', resolveConfig(), undefined)).toBeUndefined()
  })

  it('uses the global default', () => {
    const cfg = resolveConfig({ roles: { writer: { provider: 'zai', model: 'glm-test' } } }) as InkwellConfig
    expect(resolveRoleRoute('writer', cfg, undefined)).toEqual({ provider: 'zai', model: 'glm-test' })
  })

  it('lets a per-book override win over the global default', () => {
    const cfg = resolveConfig({ roles: { writer: { provider: 'zai', model: 'glm-test' } } }) as InkwellConfig
    expect(resolveRoleRoute('writer', cfg, { writer: { provider: 'deepseek-account', model: 'deepseek-pro' } }))
      .toEqual({ provider: 'deepseek-account', model: 'deepseek-pro' })
  })

  it('merges per-field: book sets model, global sets provider', () => {
    const cfg = resolveConfig({ roles: { writer: { provider: 'zai' } } }) as InkwellConfig
    expect(resolveRoleRoute('writer', cfg, { writer: { model: 'glm-x' } })).toEqual({ provider: 'zai', model: 'glm-x' })
  })

  it('carries reasoningEffort through to the route', () => {
    const cfg = resolveConfig({ roles: { writer: { model: 'glm-x', reasoningEffort: 'high' } } }) as InkwellConfig
    expect(resolveRoleRoute('writer', cfg, undefined)).toEqual({ model: 'glm-x', reasoningEffort: 'high' })
  })

  it('lets the book override the global effort', () => {
    const cfg = resolveConfig({ roles: { writer: { reasoningEffort: 'high' } } }) as InkwellConfig
    expect(resolveRoleRoute('writer', cfg, { writer: { reasoningEffort: 'minimal' } }))
      .toEqual({ reasoningEffort: 'minimal' })
  })

  it('treats a null in the book as an explicit clear, not as "inherit"', () => {
    const cfg = resolveConfig({ roles: { writer: { model: 'glm-x', reasoningEffort: 'high' } } }) as InkwellConfig
    // The book says "no effort for this one" and must keep the model it inherits.
    expect(resolveRoleRoute('writer', cfg, { writer: { reasoningEffort: null } })).toEqual({ model: 'glm-x' })
  })

  it('keeps clearing one field from wiping its neighbours', () => {
    const cfg = resolveConfig({ roles: { writer: { provider: 'zai', model: 'glm-x', maxTokens: 4096 } } }) as InkwellConfig
    const route = resolveRoleRoute('writer', cfg, { writer: { maxTokens: null } })
    expect(route).toEqual({ provider: 'zai', model: 'glm-x' })
  })

  it('drops fields a book cleared even when nothing else supplies them', () => {
    expect(resolveRoleRoute('writer', resolveConfig(), { writer: { provider: null } })).toBeUndefined()
  })
})

describe('describeRoute', () => {
  it('names inheritance when unset', () => {
    expect(describeRoute(undefined)).toBe('继承当前会话模型')
  })
  it('formats a set route', () => {
    expect(describeRoute({ provider: 'zai', model: 'glm' })).toBe('zai/glm')
  })
  it('mentions the effort when one is set', () => {
    expect(describeRoute({ provider: 'zai', model: 'glm', reasoningEffort: 'high' })).toBe('zai/glm effort=high')
  })
})

describe('parseReviewerOutput', () => {
  it('parses a clean JSON array', () => {
    const out = parseReviewerOutput('[{"severity":"error","code":"x","message":"m","evidence":"e"}]')
    expect(out.parsed).toBe(true)
    expect(out.items[0]?.code).toBe('x')
  })

  it('strips prose and fences around the array', () => {
    const out = parseReviewerOutput('好的，如下：\n```json\n[{"severity":"warn","code":"c","message":"m","evidence":"e"}]\n```\n以上。')
    expect(out.parsed).toBe(true)
    expect(out.items).toHaveLength(1)
  })

  it('returns parsed:false on garbage, leaving items empty', () => {
    const out = parseReviewerOutput('我觉得这章不错。')
    expect(out.parsed).toBe(false)
    expect(out.items).toHaveLength(0)
  })

  it('unparsedFinding wraps the raw text as evidence', () => {
    const f = unparsedFinding('logic', '不是 JSON')
    expect(f.severity).toBe('info')
    expect(f.evidence).toContain('不是 JSON')
  })
})

describe('prompt builders', () => {
  it('puts the context pack and the output contract into the writer prompt', () => {
    const prompt = buildWriterPrompt(snapshot(), drafts, 1, config, '结尾留个反问')
    expect(prompt).toContain('本章上下文包')
    expect(prompt).toContain('沈砚发现船底藏着尸体')
    expect(prompt).toContain('说话方式')
    expect(prompt).toContain('结尾留个反问')
    expect(prompt).toContain('直接输出正文')
  })

  it('embeds the draft text and the facts into a reviewer prompt', () => {
    const draft: ChapterDraft = { number: 1, title: '夜渡', words: 10, summary: '', writtenAt: '', text: '沈砚蹲下，船底果然藏着尸体。' }
    const prompt = buildReviewerPrompt('logic', draft, snapshot(), config, '')
    expect(prompt).toContain('沈砚蹲下，船底果然藏着尸体。')
    expect(prompt).toContain('左眼颜色')
    expect(prompt).toContain('严格输出一个 JSON 数组')
  })

  it('folds prior findings into the chief prompt', () => {
    const draft: ChapterDraft = { number: 1, title: '夜渡', words: 10, summary: '', writtenAt: '', text: '正文。' }
    const prompt = buildChiefPrompt(
      draft,
      [{ role: 'logic', items: [{ severity: 'error', code: 'logic/x', message: '时间矛盾', evidence: '第3章' }] }],
      snapshot(),
      config,
      '',
    )
    expect(prompt).toContain('各审核员意见')
    expect(prompt).toContain('时间矛盾')
  })

  it('each role has a label and a persona', () => {
    for (const id of Object.keys(ROLES) as RoleId[]) {
      expect(ROLES[id].label).toBeTruthy()
      expect(ROLES[id].persona.length).toBeGreaterThan(10)
    }
  })
})
