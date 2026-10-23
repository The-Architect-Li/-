/**
 * Inkwell — deterministic constraints for long-form fiction on DeepSeek Harness.
 *
 * The plugin registers seven tools and one pre-dispatch gate. The gate is the
 * point of the whole thing: rules that live in code cannot be talked out of.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config as ConfigSchema, resolveConfig } from './config.ts'
import { ProjectStore } from './domain/store.ts'
import type { InkwellConfig } from './domain/types.ts'
import { gateToolCall, isInkwellTool } from './gate.ts'
import { registerBriefingTool } from './tools/briefing.ts'
import { registerCanonTool } from './tools/canon.ts'
import { registerChapterTool } from './tools/chapter.ts'
import { registerCheckTool } from './tools/check.ts'
import { registerLedgerTool } from './tools/ledger.ts'
import { registerOutlineTool } from './tools/outline.ts'
import { registerProjectTool } from './tools/project.ts'

/** Plugin name used by the Cordis fiber and the logger. */
export const name = 'inkwell'

/** Inkwell contributes tools; it must not load before the registry exists. */
export const inject = ['tools']

/**
 * Mount the plugin.
 *
 * @param ctx - plugin context.
 * @param config - project-level overrides from `cordis.yml`.
 */
export function apply(ctx: Context, config: Partial<InkwellConfig> = {}): void {
  const resolved = resolveConfig(config)
  const store = new ProjectStore(resolved.root)
  const deps = { store, config: resolved }

  registerProjectTool(ctx, deps)
  registerCanonTool(ctx, deps)
  registerOutlineTool(ctx, deps)
  registerChapterTool(ctx, deps)
  registerLedgerTool(ctx, deps)
  registerBriefingTool(ctx, deps)
  registerCheckTool(ctx, deps)

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!isInkwellTool(exec.name)) return next()
    const reason = await gateToolCall(exec.name, exec.arguments, store, resolved)
    if (reason) return { kind: 'deny', reason }
    return next()
  })
}

/** Loader-facing config schema, reachable as `apply.Config` and as `Config`. */
export namespace apply {
  export const Config = ConfigSchema
}

export const Config = ConfigSchema
export default apply
