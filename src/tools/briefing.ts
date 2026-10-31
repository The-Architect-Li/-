/** `novel_briefing`: assemble the context pack for one chapter. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildBriefing } from '../domain/briefing.ts'
import { recordCoverage } from '../domain/records.ts'
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

      // Every chapter's pack ends with what the records still owe. A book that
      // was imported arrives with eighty-five chapters and no places at all, and
      // nothing else would ever bring that up again.
      const coverage = recordCoverage(snapshot)
      const owed =
        coverage.silent.length === 0
          ? []
          : [
              '',
              '【记录欠账】',
              coverage.empty
                ? '地点、故事点、时间线都还是空的。写到哪一章，就用 novel_canon action="upsert_place"、novel_story action="add"、novel_timeline action="anchor" 把那一章的样子记下来。'
                : `${coverage.silent.length} 章还没有留下任何记录（最远到第 ${coverage.reached} 章）。写完一章就顺手记一条，别攒着。`,
            ]

      return {
        chapter,
        chars: result.totalChars,
        budget: result.budgetChars,
        sections: result.sections.map((section) =>
          `${section.name}｜${section.chars} 字｜${section.kept ? '已装入' : '被挤掉'}`,
        ),
        report: [
          `第${chapter}章上下文包：${result.totalChars}/${result.budgetChars} 字。`,
          ...(result.warnings.length > 0 ? ['', '【没装进去的】', ...result.warnings.map((line) => `- ${line}`)] : []),
          '',
          result.markdown,
          ...owed,
        ].join('\n'),
      }
    },
  }))
}
