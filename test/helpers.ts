/** A minimal stand-in for the harness. */
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

/** One recorded `ctx.subagents.start` call. */
export interface SubagentCall {
  name: string
  request: {
    persona?: string
    prompt?: unknown
    agentOptions?: unknown
    toolFilter?: unknown
    parent?: unknown
  }
}

/** A fake subagent service that returns scripted text per call. */
export interface FakeSubagents {
  calls: SubagentCall[]
  service: { start: (name: string, request: unknown) => Promise<unknown> }
}

/** Result of invoking a tool through the fake pipeline. */
export type CallResult =
  | { ok: true; value: Record<string, never> | unknown }
  | { ok: false; error: string }

/** A mounted plugin plus the helpers to call it. */
export interface Harness {
  root: string
  tools: Map<string, AnyTool>
  subagents: FakeSubagents
  call(name: string, args: Record<string, unknown>): Promise<CallResult>
  cleanup(): Promise<void>
}

/** Build a fake subagent service whose responder inspects each request. */
export function fakeSubagents(responder: (call: SubagentCall) => string): FakeSubagents {
  const calls: SubagentCall[] = []
  return {
    calls,
    service: {
      async start(name, request) {
        const record: SubagentCall = { name, request: request as SubagentCall['request'] }
        calls.push(record)
        const text = responder(record)
        return {
          id: `fake-${calls.length}`,
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
          dispose: async () => undefined,
        }
      },
    },
  }
}

/**
 * Mount Inkwell over a temporary project directory.
 *
 * @param config - extra plugin config, merged over a temp root.
 * @param subagents - a fake subagent service; defaults to one that throws so
 *   dispatch tests must opt in.
 * @returns the harness.
 */
export async function createHarness(
  config: Record<string, unknown> = {},
  subagents?: FakeSubagents,
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'inkwell-'))
  const tools = new Map<string, AnyTool>()
  const gates: GateListener[] = []
  const subs = subagents ?? fakeSubagents(() => {
    throw new Error('this test did not configure a subagents responder')
  })

  const ctx = {
    tools: {
      register(definition: AnyTool) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    subagents: subs.service,
    on(event: string, listener: GateListener) {
      if (event === 'tools/pre-execute') gates.push(listener)
      return () => undefined
    },
  } as unknown as Context

  apply(ctx, { root, ...config } as never)

  return {
    root,
    tools,
    subagents: subs,
    async call(name, args) {
      const tool = tools.get(name)
      if (!tool) return { ok: false, error: `tool ${name} is not registered` }

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
          agent: { session: { id: 'parent-session' } },
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
