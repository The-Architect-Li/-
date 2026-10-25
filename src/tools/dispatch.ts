/** `novel_dispatch`: drive the studio pipeline by spawning role subagents. */
import type {} from '@deepseek-ai/dsh-subagent'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { countChars } from '../domain/text.ts'
import { buildReviewWindow } from '../domain/review-window.ts'
import type { ToolDeps } from './deps.ts'
import {
  ROLES,
  buildChiefPrompt,
  buildReviewerPrompt,
  buildWriterPrompt,
  describeRoute,
  parseReviewerOutput,
  resolveRoleRoute,
  unparsedFinding,
  type ReviewerFinding,
} from '../roles.ts'
import type { RoleId } from '../domain/types.ts'

/** One reviewer's findings, as the commander passes them to the chief. */
interface FindingInput {
  role: 'logic' | 'character'
  items: ReviewerFinding[]
}

/**
 * Register the dispatch tool.
 *
 * The commander never names a model: this tool reads the role's route from the
 * per-book override or the global config and folds it into `agentOptions`. The
 * child sees only its persona and the embedded context pack — no parent
 * transcript, no leaked tools.
 *
 * @param ctx - plugin context with the subagent service.
 * @param deps - store and resolved config.
 */
export function registerDispatchTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'novel_dispatch',
    description:
      '小说工坊流水线：按角色派一个子智能体干活，等它结果回来。writer=写手出初稿（返回正文文本）；logic=逻辑审核、character=角色一致性审核（返回带证据的 findings 数组）；chief=总审核（需要把前面各审核的 findings 传进 findings 参数，返回裁决后的清单）。模型由 novel_roles 配置，每次调用自动带上，你不用管。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['writer', 'logic', 'character', 'chief'],
        description: '派哪个角色',
      },
      number: { type: 'number', required: true, description: '章号' },
      directive: { type: 'string', description: '指挥官给这次派发的具体要求；不填则按章纲合同来' },
      findings: {
        type: 'array',
        description: 'chief 时必填：前面 logic/character 的意见，用来裁决',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            role: { type: 'string', enum: ['logic', 'character'] },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  severity: { type: 'string', enum: ['error', 'warn', 'info'] },
                  code: { type: 'string' },
                  message: { type: 'string' },
                  evidence: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          role: { type: 'string' },
          number: { type: 'number' },
          text: { type: 'string' },
          words: { type: 'number' },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                severity: { type: 'string' },
                code: { type: 'string' },
                message: { type: 'string' },
                evidence: { type: 'string' },
              },
            },
          },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    timeoutMs: ROLES.writer.timeoutMs,
    async execute(args, exec) {
      const store = deps.storeFor(exec)
      const roleId = args.action as RoleId
      const role = ROLES[roleId]
      const number = args.number
      const snapshot = await store.snapshot()
      const plan = snapshot.plans.find((item) => item.number === number)
      if (!plan) {
        throw new Error(`第${number}章没有章纲。先 novel_outline add_chapter + approve_chapter，再派发。`)
      }

      const drafts = await store.allChapters()
      const route = resolveRoleRoute(roleId, deps.config, snapshot.project.roles)
      const routeText = describeRoute(route)

      if (roleId === 'writer') {
        const prompt = buildWriterPrompt(snapshot, drafts, number, deps.config, args.directive ?? '')
        const text = await runRole(ctx, role.persona, prompt, exec, route)
        const words = countChars(text)
        return {
          role: roleId,
          number,
          text,
          words,
          report: [
            `写手已交稿（${words} 字，模型 ${routeText}）。`,
            '下一步：novel_chapter action="propose" 把稿子落成草稿并跑自动体检，再派审核。',
          ].join('\n'),
        }
      }

      const draft = await store.latestDraft(number)
      if (!draft) {
        throw new Error(`第${number}章还没有草稿。先派 writer，再 novel_chapter action="propose"，然后才能审核。`)
      }
      const draftRecord = { number: draft.number, title: draft.summary ? draft.summary.slice(0, 40) : `第${draft.number}章`, words: draft.words, summary: draft.summary, writtenAt: draft.writtenAt, text: draft.text }

      // What came before, in the shape the reviewer can afford to read: the last
      // few chapters quoted, a longer run as recaps. Built once per dispatch so
      // the report can say exactly what was in front of the reviewer.
      const window = buildReviewWindow(snapshot, drafts, number, {
        full: deps.config.reviewFullChapters,
        recap: deps.config.reviewRecapChapters,
        budget: deps.config.reviewBudgetChars,
      })

      if (roleId === 'chief') {
        const inputs = (args.findings ?? []) as unknown as FindingInput[]
        const prompt = buildChiefPrompt(draftRecord, inputs, snapshot, deps.config, args.directive ?? '', window)
        const output = await runRole(ctx, role.persona, prompt, exec, route)
        const { items, parsed } = parseReviewerOutput(output)
        const findings = parsed ? items : [unparsedFinding('chief', output)]
        const stored = await store.appendReview(number, {
          role: roleId,
          route: routeText,
          draftRound: draft.round,
          items: findings.map((finding) => ({
            severity: finding.severity,
            code: finding.code,
            message: finding.message,
            evidence: finding.evidence ?? '',
          })),
        })
        return {
          role: roleId,
          number,
          findings,
          report: [
            summarize(roleId, findings, routeText),
            window.report,
            `已记账：第${number}章第 ${stored.round} 轮审稿（${stored.items.length} 条）。`,
            reviewHint(number, stored.items),
          ].join('\n'),
        }
      }

      const prompt = buildReviewerPrompt(roleId as 'logic' | 'character', draftRecord, snapshot, deps.config, args.directive ?? '', window)
      const output = await runRole(ctx, role.persona, prompt, exec, route)
      const { items, parsed } = parseReviewerOutput(output)
      const findings = parsed ? items : [unparsedFinding(roleId, output)]
      const stored = await store.appendReview(number, {
        role: roleId,
        route: routeText,
        draftRound: draft.round,
        items: findings.map((finding) => ({
          severity: finding.severity,
          code: finding.code,
          message: finding.message,
          evidence: finding.evidence ?? '',
        })),
      })
      return {
        role: roleId,
        number,
        findings,
        report: [
          summarize(roleId, findings, routeText),
          window.report,
          `${ROLES[roleId]?.label ?? roleId} 这一轮（第 ${stored.round} 轮）已记账，每条都有 id：`,
          ...stored.items.map((item) => `  ${item.id}　${item.severity}　${item.message}`),
          reviewHint(number, stored.items),
        ].join('\n'),
      }
    },
  }))
}

/** Spawn a one-shot child and return its final assistant text. */
async function runRole(
  ctx: Context,
  persona: string,
  promptText: string,
  exec: { agent?: unknown; signal: AbortSignal },
  route: ReturnType<typeof resolveRoleRoute>,
): Promise<string> {
  const agent = exec.agent
  if (!agent) {
    throw new Error('dispatch 必须在会话中调用：当前没有可用的 parent agent。')
  }
  const run = await ctx.subagents.start('spawn', {
    label: 'inkwell-dispatch',
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

function summarize(roleId: RoleId, findings: ReviewerFinding[], routeText: string): string {
  const errors = findings.filter((item) => item.severity === 'error').length
  const warns = findings.filter((item) => item.severity === 'warn').length
  const infos = findings.filter((item) => item.severity === 'info').length
  return [
    `${ROLES[roleId]?.label ?? roleId} 完成（模型 ${routeText}）：${errors} 必改 / ${warns} 建议改 / ${infos} 可忽略。`,
    findings.length === 0 ? '无意见。' : findings.map((item) => `[${item.severity}] ${item.code}：${item.message}`).join('\n'),
  ].join('\n')
}

/**
 * Tell the writer how to close the loop on what was just filed.
 *
 * The point of persisting a review is that it can be answered. Saying so in the
 * same breath is what makes the record get used instead of ignored.
 *
 * @param number - the chapter reviewed.
 * @param items - the stored items, ids included.
 * @returns one line of next steps, or an empty string when there is nothing open.
 */
function reviewHint(number: number, items: readonly { id: string }[]): string {
  if (items.length === 0) return ''
  const example = items[0]?.id ?? ''
  return [
    `改动第${number}章后逐条结案：novel_chapter action="review" number=${number} id="${example}" state="fixed"（已改）/ "waived"（认了，写理由）。`,
    `看全部未结案：novel_chapter action="review" number=${number}。`,
  ].join('\n')
}
