/**
 * The agent team: which model each role runs on, and the catalog that offers them.
 *
 * Three things are worth testing here and they are separable: the catalog built
 * from a host registry, the route merge over the book, and the HTTP door that
 * ties them to the panel.
 */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { ProjectStore } from '../src/domain/store.ts'
import type { ProjectFile } from '../src/domain/types.ts'
import { buildCatalog, createCatalogCache, effortsOf, modelsOf } from '../src/panel/catalog.ts'
import type { LlmCatalogSource } from '../src/panel/ports.ts'
import { checkRouteAgainstCatalog, readRoleChoice, roleViews, withRoleOverride } from '../src/panel/roles.ts'
import { createPanelHandler, PANEL_HEADER, PANEL_HEADER_VALUE, PANEL_PREFIX, readTeam, writeTeam } from '../src/panel/serve.ts'

/** A project file with just enough to be real. */
function project(): ProjectFile {
  return {
    formatVersion: 1,
    title: '雾港',
    phase: 'premise',
    premise: '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。',
    targetWords: 120000,
    createdAt: '2026-10-20T09:00:00.000Z',
    updatedAt: '2026-10-20T09:00:00.000Z',
  }
}

/** A host registry that answers from a literal table. */
function host(table: Record<string, { model: string; efforts?: string[]; defaultEffort?: string }[]>): LlmCatalogSource {
  return {
    listProviders: () => Object.keys(table).map((id) => ({ id, name: id.toUpperCase() })),
    listModels: async (provider) => (table[provider] ?? []).map((entry) => ({ id: entry.model, name: entry.model })),
    resolveModelInfo: async (provider, model) => {
      const entry = (table[provider] ?? []).find((item) => item.model === model)
      if (entry === undefined || entry.efforts === undefined) return {}
      return {
        reasoning: {
          efforts: entry.efforts.map((id) => ({ id, name: id })),
          ...(entry.defaultEffort === undefined ? {} : { defaultEffort: entry.defaultEffort }),
        },
      }
    },
  }
}

describe('catalog', () => {
  it('lists providers with their models and efforts', async () => {
    const catalog = await buildCatalog(host({ zai: [{ model: 'glm-4', efforts: ['low', 'high'], defaultEffort: 'high' }] }))
    expect(catalog).toHaveLength(1)
    expect(catalog[0]?.id).toBe('zai')
    expect(catalog[0]?.models[0]?.id).toBe('glm-4')
    expect(catalog[0]?.models[0]?.efforts.map((entry) => entry.id)).toEqual(['low', 'high'])
    expect(catalog[0]?.models[0]?.defaultEffort).toBe('high')
  })

  it('keeps a provider whose model list throws, with no models', async () => {
    const broken: LlmCatalogSource = {
      listProviders: () => [{ id: 'dead', name: 'Dead' }],
      listModels: async () => {
        throw new Error('endpoint unreachable')
      },
      resolveModelInfo: async () => ({}),
    }
    const catalog = await buildCatalog(broken)
    expect(catalog).toEqual([{ id: 'dead', name: 'Dead', models: [] }])
  })

  it('records a model with no reasoning block as offering no efforts', async () => {
    const catalog = await buildCatalog(host({ doubao: [{ model: 'seed' }] }))
    expect(catalog[0]?.models[0]?.efforts).toEqual([])
  })

  it('survives a model whose metadata lookup throws', async () => {
    const flaky: LlmCatalogSource = {
      listProviders: () => [{ id: 'zai', name: 'Zai' }],
      listModels: async () => [{ id: 'glm-4', name: 'GLM' }],
      resolveModelInfo: async () => {
        throw new Error('nope')
      },
    }
    const catalog = await buildCatalog(flaky)
    expect(catalog[0]?.models[0]).toEqual({ id: 'glm-4', name: 'GLM', efforts: [] })
  })

  it('caches one build until the ttl lapses', async () => {
    let calls = 0
    const counting: LlmCatalogSource = {
      listProviders: () => {
        calls += 1
        return [{ id: 'zai', name: 'Zai' }]
      },
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
    }
    const cache = createCatalogCache()
    await cache.get(counting)
    await cache.get(counting)
    expect(calls).toBe(1)
  })

  it('answers an empty catalog when the host has no llm service', async () => {
    expect(await createCatalogCache().get(undefined)).toEqual([])
  })

  it('picks models and efforts for a chosen route', async () => {
    const catalog = await buildCatalog(
      host({ zai: [{ model: 'glm-4', efforts: ['high'] }], doubao: [{ model: 'seed' }] }),
    )
    expect(modelsOf(catalog, 'zai').map((entry) => entry.id)).toEqual(['glm-4'])
    expect(modelsOf(catalog, undefined).map((entry) => entry.id)).toEqual(['glm-4', 'seed'])
    expect(modelsOf(catalog, 'missing')).toEqual([])
    expect(effortsOf(catalog, 'zai', 'glm-4').map((entry) => entry.id)).toEqual(['high'])
    expect(effortsOf(catalog, 'doubao', 'seed')).toEqual([])
  })
})

describe('role views', () => {
  it('reports no override as inheriting the session model', () => {
    const views = roleViews(resolveConfig({}))
    expect(views.map((view) => view.id)).toEqual(['writer', 'logic', 'character', 'chief', 'keeper'])
    expect(views[0]?.source).toBe('inherit')
    expect(views[0]?.effective).toBe('继承当前会话模型')
  })

  it('reports a global route without calling it the book route', () => {
    const config = resolveConfig({ roles: { writer: { provider: 'zai', model: 'glm-4' } } })
    const writer = roleViews(config)[0]
    expect(writer?.source).toBe('global')
    expect(writer?.override).toBeNull()
    expect(writer?.effective).toBe('zai/glm-4')
  })

  it('reports a book route as stronger than the global one', () => {
    const config = resolveConfig({ roles: { writer: { provider: 'zai', model: 'glm-4' } } })
    const writer = roleViews(config, { writer: { model: 'glm-5' } })[0]
    expect(writer?.source).toBe('book')
    expect(writer?.override).toEqual({ model: 'glm-5' })
    expect(writer?.effective).toBe('zai/glm-5')
  })

  it('treats an empty override object as no override', () => {
    const writer = roleViews(resolveConfig({}), { writer: {} })[0]
    expect(writer?.source).toBe('inherit')
    expect(writer?.override).toBeNull()
  })

  it('carries the effort into the effective line', () => {
    const config = resolveConfig({})
    const writer = roleViews(config, { writer: { provider: 'zai', model: 'glm-4', reasoningEffort: 'high' } })[0]
    expect(writer?.effective).toBe('zai/glm-4 effort=high')
  })

  it('does not call an empty global entry the global route', () => {
    // The config schema materialises every role as `{}`, so presence alone
    // says nothing; the live panel used to label all four roles 全局默认 while
    // they were really inheriting the session model.
    const config = resolveConfig({})
    const hollow = { ...config, roles: { writer: {}, logic: {}, character: {}, chief: {} } }
    for (const view of roleViews(hollow)) {
      expect(view.source).toBe('inherit')
      expect(view.effective).toBe('继承当前会话模型')
    }
  })
})

describe('reading a choice', () => {
  it('accepts a full route', () => {
    const choice = readRoleChoice({ role: 'logic', provider: ' zai ', model: 'glm-4', reasoningEffort: 'low', maxTokens: 4096.7 })
    expect(choice.role).toBe('logic')
    expect(choice.reset).toBe(false)
    expect(choice.patch).toEqual({ provider: 'zai', model: 'glm-4', reasoningEffort: 'low', maxTokens: 4096 })
  })

  it('rejects an unknown role', () => {
    expect(() => readRoleChoice({ role: 'editor', model: 'x' })).toThrow(/role 必须是/)
  })

  it('rejects a body with nothing to change', () => {
    expect(() => readRoleChoice({ role: 'writer' })).toThrow(/没有要改的字段/)
  })

  it('reads an empty string as a clear, not a value', () => {
    expect(readRoleChoice({ role: 'writer', provider: '' }).patch).toEqual({ provider: null })
  })

  it('rejects a non-integer token ceiling', () => {
    expect(() => readRoleChoice({ role: 'writer', maxTokens: -1 })).toThrow(/maxTokens/)
  })

  it('marks a reset', () => {
    const choice = readRoleChoice({ role: 'chief', reset: true })
    expect(choice).toEqual({ role: 'chief', reset: true, patch: {} })
  })
})

describe('writing a route', () => {
  it('stores the book override and bumps updatedAt', () => {
    const choice = readRoleChoice({ role: 'writer', provider: 'zai', model: 'glm-4' })
    const next = withRoleOverride(project(), choice)
    expect(next.roles?.writer).toEqual({ provider: 'zai', model: 'glm-4' })
    expect(next.updatedAt).not.toBe('2026-10-20T09:00:00.000Z')
  })

  it('merges into an existing override instead of replacing it', () => {
    const base: ProjectFile = { ...project(), roles: { writer: { provider: 'zai', model: 'glm-4' } } }
    const next = withRoleOverride(base, readRoleChoice({ role: 'writer', reasoningEffort: 'high' }))
    expect(next.roles?.writer).toEqual({ provider: 'zai', model: 'glm-4', reasoningEffort: 'high' })
  })

  it('keeps a clear distinct from an absence', () => {
    const base: ProjectFile = { ...project(), roles: { writer: { provider: 'zai', model: 'glm-4' } } }
    const next = withRoleOverride(base, readRoleChoice({ role: 'writer', model: '' }))
    expect(next.roles?.writer).toEqual({ provider: 'zai', model: null })
  })

  it('drops the override on reset, and drops the map when it empties', () => {
    const base: ProjectFile = { ...project(), roles: { writer: { provider: 'zai' } } }
    const next = withRoleOverride(base, readRoleChoice({ role: 'writer', reset: true }))
    expect(next.roles).toBeUndefined()
    expect('roles' in next).toBe(false)
  })

  it('leaves the other roles alone', () => {
    const base: ProjectFile = { ...project(), roles: { logic: { model: 'glm-4' } } }
    const next = withRoleOverride(base, readRoleChoice({ role: 'writer', provider: 'zai' }))
    expect(next.roles?.logic).toEqual({ model: 'glm-4' })
  })
})

describe('catalog checks', () => {
  const providers = ['zai', 'doubao']
  const models = (provider: string): string[] => (provider === 'zai' ? ['glm-4'] : ['seed'])

  it('accepts a known provider and model', () => {
    expect(() =>
      checkRouteAgainstCatalog(readRoleChoice({ role: 'writer', provider: 'zai', model: 'glm-4' }), providers, models),
    ).not.toThrow()
  })

  it('rejects an unknown provider', () => {
    expect(() =>
      checkRouteAgainstCatalog(readRoleChoice({ role: 'writer', provider: 'nope' }), providers, models),
    ).toThrow(/宿主没有 nope/)
  })

  it('rejects an unknown model on a known provider', () => {
    expect(() =>
      checkRouteAgainstCatalog(readRoleChoice({ role: 'writer', provider: 'zai', model: 'glm-9' }), providers, models),
    ).toThrow(/zai 没有 glm-9/)
  })

  it('stays permissive when the catalog is empty', () => {
    expect(() =>
      checkRouteAgainstCatalog(readRoleChoice({ role: 'writer', provider: 'nope', model: 'x' }), [], models),
    ).not.toThrow()
  })
})

describe('team routes', () => {
  let root = ''

  async function freshRoot(): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'inkwell-team-'))
    return root
  }

  it('reports the team for a book that does not exist yet', async () => {
    const dir = await freshRoot()
    try {
      const answer = await readTeam({ config: resolveConfig({}), baseStore: new ProjectStore(join(dir, '.novel')) }, createCatalogCache(), undefined, undefined)
      expect(answer.status).toBe(200)
      const data = answer.body as { ok: boolean; data: { noBook: boolean; roles: unknown[]; catalogUnavailable: boolean } }
      expect(data.data.noBook).toBe(true)
      expect(data.data.roles).toHaveLength(5)
      expect(data.data.catalogUnavailable).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writes a route into the book and reads it back', async () => {
    const dir = await freshRoot()
    try {
      const store = new ProjectStore(join(dir, '.novel'))
      await store.init('雾港', 120000)
      const deps = { config: resolveConfig({}), baseStore: store, llmOf: () => host({ zai: [{ model: 'glm-4', efforts: ['high'] }] }) }
      const cache = createCatalogCache()
      const written = await writeTeam(deps, cache, { role: 'writer', provider: 'zai', model: 'glm-4', reasoningEffort: 'high' }, undefined, undefined)
      expect(written.status).toBe(200)
      const read = await readTeam(deps, cache, undefined, undefined)
      const data = read.body as { data: { roles: { id: string; source: string; effective: string }[] } }
      const writer = data.data.roles.find((role) => role.id === 'writer')
      expect(writer?.source).toBe('book')
      expect(writer?.effective).toBe('zai/glm-4 effort=high')
      expect((await store.readProject()).roles?.writer).toEqual({ provider: 'zai', model: 'glm-4', reasoningEffort: 'high' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses to configure a team before there is a book', async () => {
    const dir = await freshRoot()
    try {
      const deps = { config: resolveConfig({}), baseStore: new ProjectStore(join(dir, '.novel')) }
      const answer = await writeTeam(deps, createCatalogCache(), { role: 'writer', model: 'glm-4' }, undefined, undefined)
      expect(answer.status).toBe(409)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a provider the host does not have', async () => {
    const dir = await freshRoot()
    try {
      const store = new ProjectStore(join(dir, '.novel'))
      await store.init('雾港', 0)
      const deps = { config: resolveConfig({}), baseStore: store, llmOf: () => host({ zai: [{ model: 'glm-4' }] }) }
      const answer = await writeTeam(deps, createCatalogCache(), { role: 'writer', provider: 'nope' }, undefined, undefined)
      expect(answer.status).toBe(400)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('serves the team over HTTP, and demands the plugin header to write', async () => {
    const dir = await freshRoot()
    const store = new ProjectStore(join(dir, '.novel'))
    await store.init('雾港', 0)
    const handler = createPanelHandler({ config: resolveConfig({}), baseStore: store, llmOf: () => host({ zai: [{ model: 'glm-4' }] }) })
    const server = createServer((req, res) => void handler(req, res))
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const base = `http://127.0.0.1:${address.port}${PANEL_PREFIX}`
    try {
      const read = await fetch(`${base}/roles`)
      expect(read.status).toBe(200)
      const payload = (await read.json()) as { data: { roles: unknown[]; providers: { id: string }[] } }
      expect(payload.data.roles).toHaveLength(5)
      expect(payload.data.providers.map((entry) => entry.id)).toEqual(['zai'])

      const noHeader = await fetch(`${base}/roles`, { method: 'POST', body: JSON.stringify({ role: 'writer', model: 'glm-4' }) })
      expect(noHeader.status).toBe(403)

      const ok = await fetch(`${base}/roles`, {
        method: 'POST',
        headers: { [PANEL_HEADER]: PANEL_HEADER_VALUE, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'writer', provider: 'zai', model: 'glm-4' }),
      })
      expect(ok.status).toBe(200)
      const after = (await ok.json()) as { data: { roles: { id: string; effective: string }[] } }
      expect(after.data.roles.find((role) => role.id === 'writer')?.effective).toBe('zai/glm-4')
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
      await rm(dir, { recursive: true, force: true })
    }
  })
})
