/**
 * dsh-inkwell plugin entry point.
 *
 * Registers the nine `novel_*` tools and one pre-execute gate. The gate is the
 * only place studio rules are enforced for *calls*; the tools themselves guard
 * their arguments. Nothing here knows about prose — that lives in `domain/`.
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig, Config as ConfigSchema } from './config.ts'
import { ProjectStore } from './domain/store.ts'
import { gateToolCall, isInkwellTool } from './gate.ts'
import { createDeps } from './tools/deps.ts'
import { registerBriefingTool } from './tools/briefing.ts'
import { registerCanonTool } from './tools/canon.ts'
import { registerChapterTool } from './tools/chapter.ts'
import { registerCheckTool } from './tools/check.ts'
import { registerDispatchTool } from './tools/dispatch.ts'
import { registerLedgerTool } from './tools/ledger.ts'
import { registerOutlineTool } from './tools/outline.ts'
import { registerProjectTool } from './tools/project.ts'
import { registerRolesTool } from './tools/roles.ts'
import type { InkwellConfig } from './domain/types.ts'

export const name = 'inkwell'

export const inject = ['tools', 'subagents']

/**
 * Mount the plugin.
 *
 * @param ctx - the hosting context.
 * @param config - loader configuration; every field is optional.
 */
export function apply(ctx: Context, config: Partial<InkwellConfig> = {}): void {
  const resolved = resolveConfig(config)
  const baseStore = new ProjectStore(resolved.root)
  const deps = createDeps(resolved, baseStore)

  registerProjectTool(ctx, deps)
  registerCanonTool(ctx, deps)
  registerOutlineTool(ctx, deps)
  registerChapterTool(ctx, deps)
  registerLedgerTool(ctx, deps)
  registerBriefingTool(ctx, deps)
  registerCheckTool(ctx, deps)
  registerRolesTool(ctx, deps)
  registerDispatchTool(ctx, deps)

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!isInkwellTool(exec.name)) return next()
    // The gate resolves the same per-session store the tool will use, so it
    // never approves a call against a different book's canon.
    const store = deps.storeFor(exec)
    const reason = await gateToolCall(exec.name, exec.arguments, store, resolved)
    if (reason) return { kind: 'deny', reason }
    return next()
  })
}

export namespace apply {
  export const Config = ConfigSchema
}

export const Config = ConfigSchema

export default apply
