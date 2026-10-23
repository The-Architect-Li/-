/** `novel_briefing`: assemble the context pack for one chapter. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildBriefing } from '../domain/briefing.ts'
import type { ToolDeps } from './deps.ts'

/**
 * Register the briefing tool.
 *
 * @param ctx - plugin context with the tool registry.
 * @param deps - store and resolved config.
 */
export function registerBriefingTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'novel_briefing',
    description:
      '取某一章的写作上下文包：本章章纲、出场角色卡、上一章结尾、相关事实、前情摘要、待回收线索，按优先级装进固定字数预算，并告诉你哪些被挤掉了。动笔前先调这个，不要自己去翻全稿。',
    parameters: {
      chapter: { type: 'number', required: true, description: '要写的章号' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chapter: { type: 'number' },
          chars: { type: 'number' },
          budget: { type: 'number' },
          sections: { type: 'array', items: { type: 'string' } },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    async execute(args, exec) {
      const store = deps.storeFor(exec)
      const snapshot = await store.snapshot()
      const drafts = await store.allChapters()
      const chapter = args.chapter
      if (!Number.isInteger(chapter) || chapter < 1) throw new Error('chapter 必须是正整数。')

      const result = buildBriefing(snapshot, drafts, chapter, deps.config)

      return {
        chapter,
        chars: result.totalChars,
        budget: result.budgetChars,
        sections: result.sections.map((section) =>
          `${section.name}｜${section.chars} 字｜${section.kept ? '已装入' : '被挤掉'}`,
        ),
        report: [
          `第${chapter}章上下文包：${result.totalChars}/${result.budgetChars} 字。`,
          '',
          result.markdown,
        ].join('\n'),
      }
    },
  }))
}
