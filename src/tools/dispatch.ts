/** `novel_dispatch`: drive the studio pipeline by spawning role subagents. */
import type {} from '@deepseek-ai/dsh-subagent'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { countChars } from '../domain/text.ts'
import { skillExcerpts } from '../domain/skills.ts'
import { buildReviewWindow } from '../domain/review-window.ts'
import type { ToolDeps } from './deps.ts'
import {
  ROLES,
  buildChiefPrompt,
  buildKeeperPrompt,
  buildReviewerPrompt,
  buildWriterBrief,
  describeRoute,
  parseKeeperOutput,
  parseReviewerOutput,
  resolveRoleRoute,
  unparsedFinding,
  type ReviewerFinding,
} from '../roles.ts'
import { describeWindow, resolveTimeline, windowAt } from '../domain/clock.ts'
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
      '小说工坊流水线：按角色派一个子智能体干活，等它结果回来。writer=写手出初稿（返回正文文本）；logic=逻辑审核、character=角色一致性审核（返回带证据的 findings 数组）；chief=总审核（需要把前面各审核的 findings 传进 findings 参数，返回裁决后的清单）；card=不派，只把写手那张派单书原样给你（复制到别的会话、存档、或先看看它会读到什么）。模型由 novel_roles 配置，每次调用自动带上，你不用管。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['writer', 'logic', 'character', 'chief', 'keeper', 'card'],
        description: '派哪个角色；card 不派，只生成一张写手派单书（纯文本，可以复制到别处）',
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
          proposals: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string' },
                subject: { type: 'string' },
                key: { type: 'string' },
                value: { type: 'string' },
                chapter: { type: 'number' },
                quote: { type: 'string' },
              },
            },
          },
          shifts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                chapter: { type: 'number' },
                from: { type: 'string' },
                to: { type: 'string' },
                cause: { type: 'string' },
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

      // `card` stops here: it is the writer's prompt as a document, not a
      // spawn. Useful when the author wants to hand the job to another session,
      // keep the brief, or read what the writer is about to be told.
      if (args.action === 'card') {
        const brief = buildWriterBrief({
          snapshot,
          drafts,
          chapter: number,
          config: deps.config,
          directive: args.directive ?? '',
          skills: await skillExcerpts(store.root),
        })
        return {
          role: 'writer',
          number,
          text: '',
          words: 0,
          report: [
            `派单书 · 第${number}章（写给写手；复制下面全文即可，不会真的派出）`,
            `模型：${describeRoute(resolveRoleRoute('writer', deps.config, snapshot.project.roles))}`,
            ...(brief.warnings.length > 0 ? ['', '【注意：这几项没能进包】', ...brief.warnings.map((line) => `- ${line}`)] : []),
            '',
            brief.text,
          ].join('\n'),
        }
      }

      const route = resolveRoleRoute(roleId, deps.config, snapshot.project.roles)
      const routeText = describeRoute(route)

      if (roleId === 'writer') {
        const brief = buildWriterBrief({
          snapshot,
          drafts,
          chapter: number,
          config: deps.config,
          directive: args.directive ?? '',
          skills: await skillExcerpts(store.root),
        })
        const text = await runRole(ctx, role.persona, brief.text, exec, route)
        const words = countChars(text)
        return {
          role: roleId,
          number,
          text,
          words,
          report: [
            `写手已交稿（${words} 字，模型 ${routeText}）。`,
            ...(brief.warnings.length > 0 ? ['', '【这一章有几项要求没能进包】', ...brief.warnings.map((line) => `- ${line}`)] : []),
            '下一步：novel_chapter action="propose" 把稿子落成草稿并跑自动体检，再派审核。',
          ].join('\n'),
        }
      }

      const draft = await store.latestDraft(number)
      if (!draft) {
        throw new Error(`第${number}章还没有草稿。先派 writer，再 novel_chapter action="propose"，然后才能审核。`)
      }
      const draftRecord = { number: draft.number, title: draft.summary ? draft.summary.slice(0, 40) : `第${draft.number}章`, words: draft.words, summary: draft.summary, writtenAt: draft.writtenAt, text: draft.text }

      // The keeper runs on the chapter alone plus the state: it maintains the
      // record, it does not re-read the book. That is the whole point of
      // keeping state — if maintaining it cost a re-read, it would cost more
      // than the reviewers it exists to make cheap.
      if (roleId === 'keeper') {
        const highest = Math.max(number, ...snapshot.chapters.map((item) => item.number), 1)
        const resolution = resolveTimeline(snapshot.timeline, highest)
        const here = windowAt(resolution, number)
        const prompt = buildKeeperPrompt(
          draftRecord,
          snapshot,
          here
            ? `这一章的窗口是 ${describeWindow(here)}${resolution.anchors.some((anchor) => anchor.chapter === number) ? '（这一章自己就有锚点）' : '（由前面的锚点与跨度推出来）'}`
            : '这一章还没有能被算出来的日期——正文里没写、也没有锚点。',
          args.directive ?? '',
        )
        const output = await runRole(ctx, role.persona, prompt, exec, route)
        const { items, parsed } = parseKeeperOutput(output)
        const lines = items.map((item) => `- [${item.kind}] ${item.subject}${item.key ? `·${item.key}` : ''}：${item.value}${item.quote ? `｜「${item.quote}」` : ''}`)
        return {
          role: roleId,
          number,
          proposals: items,
          report: [
            `状态维护员看完了第${number}章（模型 ${routeText}）：${items.length} 条建议。${parsed ? '' : '（它没按 JSON 输出，下面是没解析出来的原文，别直接用）'}`,
            ...(lines.length > 0 ? lines : ['- 这一章没有需要记的新东西。']),
            '',
            '下一步：逐条决定要不要落盘——事实用 novel_ledger record，地点用 novel_canon upsert_place，阶段用 novel_canon upsert_character，日期用 novel_timeline anchor，章卡用 novel_outline card。它只提案，写不写由你。',
          ].join('\n'),
        }
      }

      // What came before, in the shape each role can afford to read. The chief
      // adjudicates continuity, so it gets the long window; the two reviewers
      // read the seam only — paying for the same window three times a round is
      // a lot of tokens for a judgement they are not the ones making.
      const window = buildReviewWindow(snapshot, drafts, number, {
        full: deps.config.reviewFullChapters,
        recap: deps.config.reviewRecapChapters,
        budget: deps.config.reviewBudgetChars,
      })
      const neighbour = buildReviewWindow(snapshot, drafts, number, {
        full: deps.config.reviewNeighbourChapters,
        recap: 0,
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
          shifts: shiftsOf(findings),
          report: [
            summarize(roleId, findings, routeText),
            window.report,
            `已记账：第${number}章第 ${stored.round} 轮审稿（${stored.items.length} 条）。`,
            reviewHint(number, stored.items),
            shiftHint(shiftsOf(findings)),
          ].filter((line) => line !== '').join('\n'),
        }
      }

      const prompt = buildReviewerPrompt(roleId as 'logic' | 'character', draftRecord, snapshot, deps.config, args.directive ?? '', neighbour)
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
        shifts: shiftsOf(findings),
        report: [
          summarize(roleId, findings, routeText),
          neighbour.report,
          `${ROLES[roleId]?.label ?? roleId} 这一轮（第 ${stored.round} 轮）已记账，每条都有 id：`,
          ...stored.items.map((item) => `  ${item.id}　${item.severity}　${item.message}`),
          reviewHint(number, stored.items),
          shiftHint(shiftsOf(findings)),
        ].filter((line) => line !== '').join('\n'),
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

/** The turns a review round proposed, ready to hand to `novel_canon shift`. */
function shiftsOf(items: readonly ReviewerFinding[]): NonNullable<ReviewerFinding['shift']>[] {
  return items
    .map((item) => item.shift)
    .filter((shift): shift is NonNullable<ReviewerFinding['shift']> => shift !== undefined)
}

/**
 * The line that turns a review question into a record.
 *
 * A reviewer can spot that a man is not who his card says he is, but only the
 * author can say whether that is growth or a mistake. So the round ends with the
 * two answers side by side and the call already spelled out: saying yes is one
 * tool call, not transcribing four arguments out of a paragraph.
 *
 * @param shifts - the turns this round proposed.
 * @returns the hint, or an empty string when nobody asked.
 */
function shiftHint(shifts: readonly NonNullable<ReviewerFinding['shift']>[]): string {
  if (shifts.length === 0) return ''
  const lines = [
    `这一轮有 ${shifts.length} 处「他是不是变了」。回答是（有意为之），就把下面那行原样发出去，参数已经填好了：`,
  ]
  for (const shift of shifts) {
    lines.push(
      `  novel_canon action="shift" name="${shift.name}" chapter="${shift.chapter}" from="${shift.from}" to="${shift.to}" cause="${shift.cause}"`,
    )
  }
  lines.push('回答不是（这条是写崩了），就别发，按 character/drift 改这一章。')
  return lines.join('\n')
}
