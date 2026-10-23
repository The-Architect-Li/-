/**
 * A minimal stand-in for the harness.
 *
 * It reproduces the only two seams Inkwell uses — the tool registry and the
 * `tools/pre-execute` waterfall — so the tests exercise the same code path a
 * real call takes, including the refusals.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'

type AnyTool = ToolDefinition & { execute: (args: unknown, exec: unknown) => Promise<unknown> }
type GateListener = (
  exec: { name: string; arguments: unknown },
  next: () => Promise<{ kind: 'allow' }>,
) => Promise<{ kind: string; reason?: string }>

/** Result of invoking a tool through the fake pipeline. */
export type CallResult =
  | { ok: true; value: Record<string, never> | unknown }
  | { ok: false; error: string }

/** A mounted plugin plus the helpers to call it. */
export interface Harness {
  root: string
  tools: Map<string, AnyTool>
  call(name: string, args: Record<string, unknown>): Promise<CallResult>
  cleanup(): Promise<void>
}

/**
 * Mount Inkwell over a temporary project directory.
 *
 * @param config - extra plugin config, merged over a temp root.
 * @returns the harness.
 */
export async function createHarness(config: Record<string, unknown> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'inkwell-'))
  const tools = new Map<string, AnyTool>()
  const gates: GateListener[] = []

  const ctx = {
    tools: {
      register(definition: AnyTool) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    on(event: string, listener: GateListener) {
      if (event === 'tools/pre-execute') gates.push(listener)
      return () => undefined
    },
  } as unknown as Context

  apply(ctx, { root, ...config } as never)

  return {
    root,
    tools,
    async call(name, args) {
      const tool = tools.get(name)
      if (!tool) return { ok: false, error: `tool ${name} is not registered` }

      // The registry runs policy before the body. Mirror that order.
      for (const gate of gates) {
        const decision = await gate({ name, arguments: args }, async () => ({ kind: 'allow' }))
        if (decision.kind === 'deny') return { ok: false, error: decision.reason ?? 'denied' }
      }

      try {
        const value = await tool.execute(args, {
          callId: 'test-call',
          name,
          arguments: args,
          signal: new AbortController().signal,
          token: Symbol('test-token'),
        })
        return { ok: true, value }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

/** Narrow a successful call to its structured value. */
export function valueOf<T>(result: CallResult): T {
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`)
  return result.value as T
}
