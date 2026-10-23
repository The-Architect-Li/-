/** `novel_check`: deterministic inspection without spending tokens. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { checkContract, rank } from '../domain/contract.ts'
import { scanChapter } from '../domain/scan.ts'
import type { Finding } from '../domain/types.ts'
import { auditLedger } from './ledger.ts'
import { formatFindings, tally, type ToolDeps } from './deps.ts'

/**
 * Register the check tool.
 *
 * Every check here is a pure function over text already on disk, so it costs no
 * tokens and can be run on every chapter after every revision.
 *
 * @param ctx - plugin context with the tool registry.
 * @param deps - store and resolved config.
 */
export function registerCheckTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'novel_check',
    description:
      '确定性体检，零 token。contract 检查某章正文是否兑现章纲；scan 检查复读、句式、套路词、对话占比、章末钩子；ledger 检查设定冲突；all 全量跑一遍（不给 number 则检查所有已写章节）。这些结论是启发式的，用来定位问题，不替代人判断。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['contract', 'scan', 'ledger', 'all'],
        description: '检查类型',
      },
      number: { type: 'number', description: '章号；all 时可省略，省略则检查全书' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          errors: { type: 'number' },
          warnings: { type: 'number' },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    async execute(args, exec) {
      const store = deps.storeFor(exec)
      const snapshot = await store.snapshot()
      const drafts = await store.allChapters()
      const findings: Finding[] = []

      if (args.action === 'ledger' || args.action === 'all') {
        findings.push(...auditLedger(snapshot.ledger, drafts.length))
      }

      const targets = args.number !== undefined
        ? drafts.filter((item) => item.number === args.number)
        : drafts

      if (args.number !== undefined && targets.length === 0) {
        throw new Error(`第${args.number}章还没写，没有可检查的正文。`)
      }

      if (args.action === 'contract' || args.action === 'all') {
        for (const draft of targets) {
          const plan = snapshot.plans.find((item) => item.number === draft.number)
          if (!plan) {
            findings.push({
              code: 'contract/missing-plan',
              severity: 'warn',
              message: `第${draft.number}章有正文但没有章纲，无法核对`,
              evidence: '',
            })
            continue
          }
          findings.push(...checkContract(plan, draft.text, deps.config))
        }
      }

      if (args.action === 'scan' || args.action === 'all') {
        for (const draft of targets) {
          const others = drafts.filter((item) => item.number !== draft.number)
          findings.push(
            ...scanChapter(draft, others, deps.config).map((finding) => ({
              ...finding,
              message: `第${draft.number}章：${finding.message}`,
            })),
          )
        }
      }

      const ordered = rank(findings)
      const counts = tally(ordered)
      const scope = args.number !== undefined ? `第${args.number}章` : '全书'

      return {
        errors: counts.errors,
        warnings: counts.warnings,
        report: ordered.length === 0
          ? `${scope}体检通过，没有发现问题。`
          : [
              `${scope}体检：${counts.errors} 个错误，${counts.warnings} 个警告，${counts.infos} 条提示。`,
              '',
              formatFindings(ordered),
            ].join('\n'),
      }
    },
  }))
}
