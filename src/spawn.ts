/**
 * Spawning one child agent and reading back its answer.
 *
 * It lived inside `novel_dispatch` until the importer needed the same thing:
 * reading a hundred chapters and writing down what happened in each is a job
 * for a model, not for a regex, and the second caller must not grow its own
 * copy of the plumbing.
 *
 * ## Why this file has two shapes in it
 *
 * `ctx.subagents` changed between harness releases. The older one exposed
 * `start(name, request)` and returned a run whose `result` was the child's
 * answer. The newer one exposes `startActivation(spec)`, where the provider is
 * a field rather than an argument, the persona travels inside the preset
 * instead of the request, and a child is a *background* delegation that reports
 * to its parent by message.
 *
 * A plugin compiled against the older typings therefore dies on the newer host
 * with `ctx.subagents.start is not a function` — which reads like a bug in the
 * plugin and is really a version boundary. Detecting the shape at call time is
 * what keeps one build working on both, and the failure when neither shape
 * exists says which host it is talking to instead of "not a function".
 */
import type { Context } from '@deepseek-ai/cordis'
import type { resolveRoleRoute } from './roles.ts'

/** What the tool harness hands an `execute`, narrowed to what spawning needs. */
export interface SpawnContext {
  agent?: unknown
  signal: AbortSignal
}

/**
 * The two generations of the subagent seam, described structurally.
 *
 * Deliberately not imported from the package: the types come from whichever
 * version the build machine happened to install, and the whole point here is to
 * run against a host that may be newer or older than that.
 */
interface HostSubagents {
  /** Older hosts: `start(name, request)`. */
  start?: (name: string, request: unknown) => Promise<{ result: Promise<unknown>; dispose?: () => Promise<void> }>
  /** Newer hosts: `startActivation(spec)`. */
  startActivation?: (spec: unknown) => Promise<{ result: Promise<unknown>; dispose?: () => Promise<void> }>
  /** Both generations: the names a caller can ask for. */
  list?: () => string[]
}

/** Read `ctx.subagents` without trusting the declared type of whichever host loaded us. */
function subagentsOf(ctx: Context): HostSubagents | undefined {
  const service = (ctx as unknown as { subagents?: unknown }).subagents
  if (typeof service !== 'object' || service === null) return undefined
  return service as HostSubagents
}

/**
 * Which generation of the seam this host speaks.
 *
 * @param service - `ctx.subagents`, or undefined when the host has none.
 * @returns the shape to use, or `'none'` when neither call exists.
 */
export function subagentApi(service: HostSubagents | undefined): 'start' | 'activation' | 'none' {
  if (service === undefined) return 'none'
  if (typeof service.start === 'function') return 'start'
  if (typeof service.startActivation === 'function') return 'activation'
  return 'none'
}

/**
 * The provider to ask for, discovered rather than assumed.
 *
 * The bundled in-process backend registers under `subagent-spawn-in-process` on
 * newer hosts and `spawn` on older ones. Picking by name would break on the
 * next rename, so preference is by substring and the old literal is the last
 * resort.
 *
 * @param service - the seam.
 * @returns a provider name to pass to the host.
 */
export function pickProvider(service: HostSubagents | undefined): string {
  const names = typeof service?.list === 'function' ? service.list() : []
  return names.find((name) => /spawn/i.test(name)) ?? names[0] ?? 'spawn'
}

/**
 * Pull the assistant text out of whatever the host resolved the run with.
 *
 * Three shapes exist in the wild: `{ output: blocks }` from both generations,
 * a bare block array from a slightly different build, and a plain string from a
 * provider that answered without content blocks. Getting this wrong loses the
 * answer silently, which is the worst possible failure for a role whose whole
 * output is that text.
 *
 * @param value - whatever the run resolved to.
 * @returns the concatenated text, or `''` when there is none.
 */
export function textOfRun(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return textOfBlocks(value)
  if (typeof value === 'object' && value !== null) {
    const record = value as { output?: unknown; text?: unknown }
    if (Array.isArray(record.output)) return textOfBlocks(record.output)
    if (typeof record.text === 'string') return record.text
  }
  return ''
}

/** Concatenate the text blocks of one content array. */
function textOfBlocks(blocks: readonly unknown[]): string {
  return blocks
    .filter((block): block is { type: 'text'; text: string } => {
      if (typeof block !== 'object' || block === null) return false
      const record = block as { type?: unknown; text?: unknown }
      return record.type === 'text' && typeof record.text === 'string'
    })
    .map((block) => block.text)
    .join('')
}

/**
 * Spawn a one-shot child and return its final assistant text.
 *
 * @param ctx - plugin context, for the subagent registry.
 * @param persona - the child's system persona.
 * @param promptText - the task.
 * @param exec - the calling tool's execution context; its agent is the parent.
 * @param route - model route, or `undefined` to inherit the session's.
 * @param label - what the host shows while this runs.
 * @returns the child's answer, concatenated.
 * @throws when the host has no usable subagent seam, or when called outside a session.
 */
export async function runRole(
  ctx: Context,
  persona: string,
  promptText: string,
  exec: SpawnContext,
  route: ReturnType<typeof resolveRoleRoute>,
  label = 'inkwell-dispatch',
): Promise<string> {
  const agent = exec.agent
  if (!agent) {
    throw new Error('这一步必须在会话中调用：当前没有可用的 parent agent。')
  }
  const service = subagentsOf(ctx)
  const api = subagentApi(service)
  if (api === 'none') {
    throw new Error(
      [
        '这个宿主没有可用的子智能体接口，派不出子智能体。',
        service === undefined
          ? 'ctx.subagents 不存在：插件声明了 inject 里的 subagents，但宿主没有提供这个服务。'
          : 'ctx.subagents 存在，但既没有 start() 也没有 startActivation()：宿主换了接口，插件还是旧版。',
        '能做的：把这一章/这一批的活交给对话里的模型直接做，或者升级插件到匹配宿主的版本。',
      ].join('\n'),
    )
  }

  if (api === 'start') {
    const run = await service!.start!(pickProvider(service), {
      label,
      prompt: [{ type: 'text', text: promptText }],
      parent: agent as never,
      signal: exec.signal,
      persona,
      toolFilter: { allow: [] },
      agentOptions: route,
    })
    const result = await run.result
    await run.dispose?.().catch(() => undefined)
    return textOfRun(result)
  }

  // Newer hosts take the persona inside a preset, not on the request. Folding it
  // into the prompt is the honest fallback: these children have no tools and no
  // second turn, so "what it was told" is the same text either way.
  const request = {
    prompt: [{ type: 'text', text: `${persona}\n\n${promptText}` }],
    parent: agent as never,
    ...(route === undefined ? {} : { agentOptions: route }),
  }
  const spec = { provider: pickProvider(service), label, request, signal: exec.signal, delivery: 'caller' as const }
  let receipt
  try {
    receipt = await service!.startActivation!(spec)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // `delivery` is the field most likely to differ between releases; retrying
    // with the value the bundled delegation tool uses costs one round trip and
    // saves the whole feature.
    if (!/delivery/i.test(message)) throw error
    receipt = await service!.startActivation!({ ...spec, delivery: 'parent' as never })
  }
  const result = await receipt.result
  await receipt.dispose?.().catch(() => undefined)
  return textOfRun(result)
}
