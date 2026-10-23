/** A minimal stand-in for the harness. */
import { mkdtemp, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
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

/** Extra execution-context details a test wants the host to report. */
export interface CallOptions {
  /** The session's working directory; omit to model a host that reports none. */
  cwd?: string
  /** Drop the agent entirely, to model a call made outside any session. */
  noAgent?: boolean
}

/** One host route the plugin registered, recorded instead of served. */
export interface RecordedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  /** Whether the plugin has since disposed the registration. */
  disposed: boolean
}

/** A mounted plugin plus the helpers to call it. */
export interface Harness {
  root: string
  tools: Map<string, AnyTool>
  subagents: FakeSubagents
  /** Every HTTP route the plugin registered on the fake host. */
  routes: RecordedRoute[]
  call(name: string, args: Record<string, unknown>, options?: CallOptions): Promise<CallResult>
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
  const routes: RecordedRoute[] = []
  const subs = subagents ?? fakeSubagents(() => {
    throw new Error('this test did not configure a subagents responder')
  })

  // The host services the plugin may touch. `webServer` is included because the
  // panel route registers against it; a host without one is modelled by the
  // `inject` guard below, which only calls back once every named service exists.
  const services: Record<string, unknown> = {
    tools: {
      register(definition: AnyTool) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    subagents: subs.service,
    webServer: {
      register(route: Omit<RecordedRoute, 'disposed'>) {
        const record: RecordedRoute = { ...route, disposed: false }
        routes.push(record)
        return () => {
          record.disposed = true
        }
      },
    },
  }

  const ctx = {
    ...services,
    on(event: string, listener: GateListener) {
      if (event === 'tools/pre-execute') gates.push(listener)
      return () => undefined
    },
    get(service: string) {
      return services[service]
    },
    inject(deps: string[], callback: (child: unknown) => void) {
      if (deps.every((needed) => services[needed] !== undefined)) callback(ctx)
      return () => undefined
    },
    effect(effect: () => unknown) {
      const disposer = effect()
      return typeof disposer === 'function' ? disposer : () => undefined
    },
  } as unknown as Context

  apply(ctx, { root, ...config } as never)

  return {
    root,
    tools,
    routes,
    subagents: subs,
    async call(name, args, options = {}) {
      const tool = tools.get(name)
      if (!tool) return { ok: false, error: `tool ${name} is not registered` }

      // The real host hands the gate and the tool the same execution context,
      // agent included. Anything less lets the gate judge a different book than
      // the tool edits, which is exactly the bug these tests guard against.
      const exec = {
        callId: 'test-call',
        name,
        arguments: args,
        signal: new AbortController().signal,
        token: Symbol('test-token'),
        agent: options.noAgent
          ? undefined
          : {
              session: {
                id: 'parent-session',
                ...(options.cwd === undefined ? {} : { header: { cwd: options.cwd } }),
              },
            },
      }

      for (const gate of gates) {
        const decision = await gate(exec, async () => ({ kind: 'allow' }))
        if (decision.kind === 'deny') return { ok: false, error: decision.reason ?? 'denied' }
      }

      try {
        const value = await tool.execute(args, exec)
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
