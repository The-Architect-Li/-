/**
 * The spawn seam, across two host generations.
 *
 * The failure this guards against actually happened: a build compiled against
 * one release of `@deepseek-ai/dsh-subagent` was loaded into a host that had
 * moved to another, and every dispatch died with `ctx.subagents.start is not a
 * function`. That sentence blames the plugin for a version boundary, and it
 * killed the writer, the reviewers, the archivist and the lorekeeper at once.
 *
 * So the shapes are detected at call time and both are exercised here.
 */
import { describe, expect, it } from 'vitest'
import { pickProvider, runRole, subagentApi, textOfRun } from '../src/spawn.ts'

/** A tool execution context: `runRole` only needs a parent agent and a signal. */
function exec() {
  return { agent: { id: 'parent' }, signal: new AbortController().signal }
}

/** A context whose only job is to carry `subagents`. */
function ctxWith(service: unknown) {
  return { subagents: service } as never
}

const persona = '你是小说写手。'
const prompt = '写第 1 章。'

describe('subagentApi', () => {
  it('recognises the older start(name, request) shape', () => {
    expect(subagentApi({ start: async () => ({ result: Promise.resolve('') }) })).toBe('start')
  })

  it('recognises the newer startActivation(spec) shape', () => {
    expect(subagentApi({ startActivation: async () => ({ result: Promise.resolve('') }) })).toBe('activation')
  })

  it('says none when the service is missing or unrecognisable', () => {
    expect(subagentApi(undefined)).toBe('none')
    expect(subagentApi({ registerProvider: () => undefined } as never)).toBe('none')
  })
})

describe('pickProvider', () => {
  it('finds the spawn backend by substring, whatever it is called', () => {
    expect(pickProvider({ list: () => ['fork', 'subagent-spawn-in-process'] })).toBe('subagent-spawn-in-process')
    expect(pickProvider({ list: () => ['spawn'] })).toBe('spawn')
  })

  it('falls back to the first registered backend before inventing a name', () => {
    expect(pickProvider({ list: () => ['only-one'] })).toBe('only-one')
    expect(pickProvider({ list: () => [] })).toBe('spawn')
  })
})

describe('textOfRun', () => {
  it('reads the output blocks both generations return', () => {
    expect(textOfRun({ output: [{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }] })).toBe('甲乙')
  })

  it('reads a bare block array', () => {
    expect(textOfRun([{ type: 'text', text: '正文' }])).toBe('正文')
  })

  it('reads a plain string', () => {
    expect(textOfRun('正文')).toBe('正文')
  })

  it('returns empty rather than throwing on a shape it does not know', () => {
    expect(textOfRun({ stopReason: 'error' })).toBe('')
    expect(textOfRun(null)).toBe('')
  })
})

describe('runRole', () => {
  it('uses the older seam when the host has it', async () => {
    const calls: { name: string; request: Record<string, unknown> }[] = []
    const service = {
      start: async (name: string, request: Record<string, unknown>) => {
        calls.push({ name, request })
        return { result: Promise.resolve({ output: [{ type: 'text', text: '写好了。' }] }), dispose: async () => undefined }
      },
      list: () => ['spawn'],
    }
    const text = await runRole(ctxWith(service), persona, prompt, exec(), undefined, 'inkwell-dispatch')
    expect(text).toBe('写好了。')
    expect(calls[0]?.name).toBe('spawn')
    expect(calls[0]?.request.persona).toBe(persona)
  })

  it('uses the newer seam when start is gone, and folds the persona into the prompt', async () => {
    const specs: Record<string, unknown>[] = []
    const service = {
      startActivation: async (spec: Record<string, unknown>) => {
        specs.push(spec)
        return { result: Promise.resolve({ output: [{ type: 'text', text: '卡写好了。' }] }), dispose: async () => undefined }
      },
      list: () => ['subagent-spawn-in-process'],
    }
    const text = await runRole(ctxWith(service), persona, prompt, exec(), undefined, 'inkwell-archive')
    expect(text).toBe('卡写好了。')
    expect(specs[0]?.provider).toBe('subagent-spawn-in-process')
    expect(specs[0]?.label).toBe('inkwell-archive')
    const request = specs[0]?.request as { prompt: { text: string }[] }
    expect(request.prompt[0]?.text).toContain(persona)
    expect(request.prompt[0]?.text).toContain(prompt)
  })

  it('names the version boundary instead of "is not a function"', async () => {
    // The exact situation that produced the report this whole file exists for.
    await expect(runRole(ctxWith({ registerProvider: () => undefined }), persona, prompt, exec(), undefined)).rejects.toThrow(
      /没有可用的子智能体接口/,
    )
  })

  it('says the host has no subagent service at all', async () => {
    await expect(runRole({} as never, persona, prompt, exec(), undefined)).rejects.toThrow(/ctx\.subagents 不存在/)
  })

  it('refuses outside a session, before touching the seam', async () => {
    await expect(
      runRole(ctxWith({ startActivation: async () => ({ result: Promise.resolve('') }) }), persona, prompt, { signal: new AbortController().signal }, undefined),
    ).rejects.toThrow(/parent agent/)
  })
})
