/**
 * Spawning one child agent and reading back its answer.
 *
 * It lived inside `novel_dispatch` until the importer needed the same thing:
 * reading a hundred chapters and writing down what happened in each is a job
 * for a model, not for a regex, and the second caller must not grow its own
 * copy of the plumbing. Children get no tools — every role here is a pure text
 * generator, so a model that decides to "just edit the file" cannot.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { resolveRoleRoute } from './roles.ts'

/** What the tool harness hands an `execute`, narrowed to what spawning needs. */
export interface SpawnContext {
  agent?: unknown
  signal: AbortSignal
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
 * @throws when there is no parent agent (called outside a session).
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
  const run = await ctx.subagents.start('spawn', {
    label,
    prompt: [{ type: 'text', text: promptText }],
    parent: agent as never,
    signal: exec.signal,
    persona,
    toolFilter: { allow: [] },
    agentOptions: route,
  })
  const result = await run.result
  await run.dispose().catch(() => undefined)
  return result.output
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}
