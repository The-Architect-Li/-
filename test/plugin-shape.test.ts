/**
 * The module's *shape*, as the plugin loader reads it.
 *
 * A plugin is not simply "a module with apply()": the loader normalizes the
 * namespace with `exports.default ?? exports` and hands the result to Cordis,
 * which then reads `inject` and `Config` off whatever it got. A default export
 * therefore silently becomes the plugin — and a default-exported `apply` carries
 * no `inject`, so the entry activates before its services exist and dies with
 * `cannot get property "tools" without inject`.
 *
 * That failure is invisible to every other test: they call `apply(ctx, config)`
 * directly, which skips the loader entirely. This file asserts the exact shape
 * the loader depends on, so the mistake cannot come back unnoticed.
 */
import { describe, expect, it } from 'vitest'
import * as inkwell from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

/** What the loader does before Cordis sees a module. */
function loaderUnwrap(exports: Record<string, unknown>): unknown {
  return exports.default ?? exports
}

describe('plugin module shape', () => {
  it('has no default export, so the loader keeps the namespace', () => {
    expect((inkwell as unknown as Record<string, unknown>).default).toBeUndefined()
  })

  it('survives the loader unwrap with inject still attached', () => {
    const plugin = loaderUnwrap(inkwell as unknown as Record<string, unknown>) as Record<string, unknown>
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.inject).toEqual(['tools', 'subagents'])
    expect(plugin.Config).toBeDefined()
    expect(plugin.name).toBe('inkwell')
  })

  it('names exactly the services it touches at apply time', () => {
    // `webServer` is deliberately absent: the panel route waits for it through
    // `ctx.inject`, so a headless profile still mounts the tools.
    expect(inkwell.inject).not.toContain('webServer')
    expect(inkwell.inject).toContain('tools')
    expect(inkwell.inject).toContain('subagents')
  })

  it('mounts with only the declared services present', () => {
    const tools = new Map<string, unknown>()
    const services: Record<string, unknown> = {
      tools: { register: (definition: { name: string }) => void tools.set(definition.name, definition) },
      subagents: { start: async () => undefined },
    }
    const ctx = {
      tools: services.tools,
      subagents: services.subagents,
      on: () => () => undefined,
      get: (name: string) => services[name],
      inject: (deps: string[], callback: (child: unknown) => void) => {
        if (deps.every((needed) => services[needed] !== undefined)) callback(ctx)
        return () => undefined
      },
      effect: () => () => undefined,
    } as unknown as Context

    expect(() => inkwell.apply(ctx, {})).not.toThrow()
    expect(tools.size).toBe(10)
    expect([...tools.keys()]).toContain('novel_export')
  })
})
