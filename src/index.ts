/**
 * dsh-inkwell plugin entry point.
 *
 * Registers the ten `novel_*` tools and one pre-execute gate. The gate is the
 * only place studio rules are enforced for *calls*; the tools themselves guard
 * their arguments. Nothing here knows about prose — that lives in `domain/`.
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig, Config as ConfigSchema } from './config.ts'
import { ProjectStore } from './domain/store.ts'
import { sessionCwdById } from './domain/scope.ts'
import { gateToolCall, isInkwellTool } from './gate.ts'
import { createPanelHandler, PANEL_PREFIX } from './panel/serve.ts'
import type { LlmCatalogSource } from './panel/ports.ts'
import { createDeps } from './tools/deps.ts'
import { registerBackupTool } from './tools/backup.ts'
import { registerBriefingTool } from './tools/briefing.ts'
import { registerCanonTool } from './tools/canon.ts'
import { registerChapterTool } from './tools/chapter.ts'
import { registerCheckTool } from './tools/check.ts'
import { registerDispatchTool } from './tools/dispatch.ts'
import { registerExportTool } from './tools/export.ts'
import { registerImportTool } from './tools/import.ts'
import { registerArchiveTool } from './tools/archive.ts'
import { registerLedgerTool } from './tools/ledger.ts'
import { registerOutlineTool } from './tools/outline.ts'
import { registerProjectTool } from './tools/project.ts'
import { registerRolesTool } from './tools/roles.ts'
import { registerStoryTool } from './tools/story.ts'
import { registerTimelineTool } from './tools/timeline.ts'
import type { InkwellConfig } from './domain/types.ts'

export const name = 'inkwell'

export const inject = ['tools', 'subagents']

/**
 * The one host service the panel route needs, described structurally.
 *
 * The plugin deliberately takes no build-time dependency on the web shell: a
 * dsh that has no `webServer` never runs this branch, and the types here are
 * the two fields actually used.
 */
interface PanelRouteHost {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
  }): () => void
}

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
  registerExportTool(ctx, deps)
  registerImportTool(ctx, deps)
  registerArchiveTool(ctx, deps)
  registerStoryTool(ctx, deps)
  registerTimelineTool(ctx, deps)
  registerBackupTool(ctx, deps)

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!isInkwellTool(exec.name)) return next()
    // The gate resolves the same per-session store the tool will use, so it
    // never approves a call against a different book's canon.
    const store = deps.storeFor(exec)
    const reason = await gateToolCall(exec.name, exec.arguments, store, resolved)
    if (reason) return { kind: 'deny', reason }
    return next()
  })

  // The workshop panel's data route. Waiting on `webServer` keeps this branch
  // out of headless and CLI profiles entirely, where there is no browser to
  // serve — and the tools above keep working there regardless.
  ctx.inject(['webServer'], (child) => {
    const host = child.get('webServer') as PanelRouteHost | undefined
    if (host === undefined) return
    child.effect(
      () => host.register({
        kind: 'prefix',
        path: PANEL_PREFIX,
        handler: createPanelHandler({
          config: resolved,
          baseStore,
          cwdOf: (sessionId) => sessionCwdById(ctx, sessionId),
          // Looked up per request: a profile may mount or swap its model
          // providers after this plugin was applied, and a picker showing the
          // registry from mount time would offer providers that are gone.
          llmOf: () => ctx.get('llm') as unknown as LlmCatalogSource | undefined,
        }),
      }),
      'inkwell: panel route',
    )
  })
}

export namespace apply {
  export const Config = ConfigSchema
}

export const Config = ConfigSchema

// No default export on purpose. The loader unwraps `exports.default ?? exports`
// before handing the module to Cordis, so a default export would replace this
// namespace with the bare `apply` function — and take `inject` with it, leaving
// the plugin to reach for `ctx.tools` before the service exists.
