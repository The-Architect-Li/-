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
import { registerPendingTool } from './tools/pending.ts'
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
  registerPendingTool(ctx, deps)
  registerStoryTool(ctx, deps)
  registerTimelineTool(ctx, deps)
  registerBackupTool(ctx, deps)

  // The commander's charter, contributed at the deployment-persona slot (order 0)
  // of the host's system-prompt registry. This is the piece that makes the
  // conversation AI a commander rather than a relay: the author talks to it in
  // natural language, it keeps asking until the intent is concrete, and only then
  // does it compile a brief and delegate. Without this the session AI reads as a
  // pass-through, and the author's real question becomes 「那我为什么不直接跟写手说」.
  ctx.inject(['systemPrompt'], (child) => {
    const registry = child.get('systemPrompt') as
      | { section?: (section: { name: string; order: number; text: string }) => () => void }
      | undefined
    if (registry === undefined || typeof registry.section !== 'function') return
    child.effect(() => registry.section!({
        name: 'inkwell:commander',
        order: 0,
        text: [
          '你是「墨井」长篇工坊的指挥官——作者唯一的对话对象，也是作者意图的编译器。',
          '',
          '## 你的身份',
          '你不是传话筒。作者说的是自然语言：「我想让这章紧张一点」「他俩这时候不该和好」。你的职责是通过反复追问把这种模糊的意图磨成具体、可执行、可验证的东西——',
          '这一章要发生哪几件事、谁在场、开头和结尾是什么、和前文的哪条线接上——直到你敢说：写手照这份单子写，出来的就是作者要的。',
          '意图没磨清就派单，是对作者最贵的那种浪费：两千字没人要的稿子。',
          '',
          '## 你怎么工作',
          '- 动手前先看书况：novel_project action="status" 与 novel_briefing，缺什么补什么。',
          '- 意图清晰、章纲齐备 → novel_dispatch 派写手；写完按流程审核（logic/character/chief），把意见讲给作者听，由作者决定改还是收。',
          '- 意图模糊 → 追问。一次问一两个关键问题（这一章的钩子是什么？这个人物此刻知道什么？），不要一口气发问卷。',
          '- 作者说错了方向 → 直说，给出你的判断和理由。你是长篇的执行主编，不是速记员。',
          '- 面板能做的机械操作（建章卡、审核一轮、挪并章、搜正文）不要替作者点；但作者在对话里要求时照做。',
          '',
          '## 分工边界',
          '写与改：你和你的子智能体。审：你和面板都有入口，产出同账。面板的按钮永远不写正文——这是定死的。',
        ].join('\n'),
    }))
  })

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
          // A round started from the panel delegates from the session's own
          // agent: `agents.get(id)` is keyed by agent id, which for a session's
          // agent is the session id.
          agentOf: (sessionId) => {
            const agents = ctx.get('agents') as unknown as { get?: (id?: string) => unknown } | undefined
            if (typeof agents?.get !== 'function') return undefined
            // No session id means the panel is running single-book; the host's
            // agent registry still has to answer, or the panel's review round
            // cannot delegate at all.
            return sessionId === undefined ? undefined : agents.get(sessionId)
          },
          ctxOf: () => ctx,
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
