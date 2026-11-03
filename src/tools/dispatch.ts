/** `novel_dispatch`: drive the studio pipeline by spawning role subagents. */
import type {} from '@deepseek-ai/dsh-subagent'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { countChars } from '../domain/text.ts'
import { runRole } from '../spawn.ts'
import { describePending, pushPending } from '../domain/pending.ts'
import { proposeDraft } from '../domain/save.ts'
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
        enum: ['round', 'writer', 'logic', 'character', 'chief', 'keeper', 'card'],
        description: '派哪个角色；round=一条命令跑完一章（写手→落草稿→逻辑审核→人物审核→总裁决，不自动定稿）；card 不派，只生成一张写手派单书',
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
      if ((args.action as string) === 'round') return await runRound(ctx, deps, args, exec)
      return await dispatchOne(ctx, deps, args.action as RoleId, args, exec)
    },
  }))
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


/**
 * One role, one job, with everything it needs read fresh.
 *
 * Named rather than inlined so that a whole round can call it three times —
 * writer, then the two reviewers, then the chief — without the pipeline having
 * to know how any single role is built.
 *
 * @param ctx - plugin context, for spawning.
 * @param deps - config and store resolution.
 * @param roleId - which role to run.
 * @param args - `number`, optional `directive`, and (for the chief) `findings`.
 * @param exec - execution context, for the parent agent.
 * @returns whatever that role produced, in the shape the tool declares.
 */
async function dispatchOne(
  ctx: Context,
  deps: ToolDeps,
  roleId: RoleId,
  args: { number: number; directive?: string; findings?: unknown[]; action?: string },
  exec: { agent?: unknown; signal: AbortSignal },
): Promise<Record<string, unknown>> {
    const store = deps.storeFor(exec)
    const role = ROLES[roleId]
    const number = args.number
    const snapshot = await store.snapshot()

    // The outline gate belongs to the writer alone: it aims the prose at beats.
    // Reviewers read what exists — a draft, or committed prose — and a chapter
    // without a card is exactly the one that most needs reading.
    if (roleId === 'writer') {
      const writerPlan = snapshot.plans.find((item) => item.number === number)
      if (!writerPlan) {
        throw new Error(`第${number}章没有章纲。先 novel_outline add_chapter + approve_chapter，再派发。`)
      }
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
          '下一步：novel_chapter action="propose" 把上面这段存成草稿（顺带跑自动体检），然后 novel_dispatch action="logic" / "character" 审，再 action="chief" 汇总。',
          `嫌麻烦就一条命令：novel_dispatch action="round" number=${number} —— 写手、草稿、两份审核、总裁决一次跑完（会重新写一遍稿）。`,
        ].join('\n'),
      }
    }

    // The text under review: the newest draft when one exists (the writer's
    // round), otherwise the committed prose itself. Reviewing the latter is how a
    // chapter that arrived whole — imported, or written before this workshop —
    // gets read without being rewritten first.
    const draft = await store.latestDraft(number)
    const chapterOnDisk = draft ? undefined : (await store.chapter(number))
    if (!draft && chapterOnDisk === undefined) {
      throw new Error(`第${number}章既没有草稿也没有正文，没东西可审。在对话里说「为第${number}章写正文」先。`)
    }
    const draftRecord = draft
      ? { number: draft.number, title: draft.summary ? draft.summary.slice(0, 40) : `第${draft.number}章`, words: draft.words, summary: draft.summary, writtenAt: draft.writtenAt, text: draft.text }
      : { number: chapterOnDisk!.number, title: chapterOnDisk!.title, words: chapterOnDisk!.words, summary: chapterOnDisk!.summary, writtenAt: chapterOnDisk!.writtenAt, text: chapterOnDisk!.text }
    const reviewRound = draft ? draft.round : (chapterOnDisk!.revision ?? 0)

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
      // Straight into the queue, not into the transcript alone. A proposal
      // that only exists as chat text has to be retyped into five different
      // tools by hand, and what actually happens then is that nobody files it.
      const queued = items.length === 0 ? { added: [], duplicates: 0 } : await pushPending(store.root, items, number, roleId)
      const lines = queued.added.map((item) => `- ${describePending(item)}`)
      return {
        role: roleId,
        number,
        proposals: items,
        report: [
          `状态维护员看完了第${number}章（模型 ${routeText}）：${items.length} 条建议，${queued.added.length} 条进了待审队列。${parsed ? '' : '（它没按 JSON 输出，下面这些没解析出来，别直接用）'}`,
          ...(lines.length > 0 ? lines : ['- 没有新的要记的东西。']),
          ...(queued.duplicates > 0 ? [`（${queued.duplicates} 条队列里已经有了，跳过）`] : []),
          ...(queued.added.length > 0
            ? [
                '',
                '还没有写进书里。下一条命令看全部：novel_pending action="list"',
                '要收就一次收完：novel_pending action="approve" all=true —— 或者先看一眼，用 ids="p-0003,p-0004" 只收那几条。',
              ]
            : []),
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
        draftRound: reviewRound,
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
      draftRound: reviewRound,
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
}

/** Where a round is, for whoever is watching it. */
export type RoundStage = 'writer' | 'logic' | 'character' | 'chief' | 'done'

/** Where a review-only round is: no writer, by design. */
export type ReviewStage = 'logic' | 'character' | 'chief' | 'done'

/** What one review role reported, as the round summarises it. */
interface RoundReview {
  errors?: number
  warnings?: number
  infos?: number
  findings?: unknown[]
}

/**
 * Run one whole chapter through the studio: write, file, review, adjudicate.
 *
 * The pipeline existed only as a list of commands in the documentation —
 * writer, propose, logic, character, chief, commit — and an author who did not
 * build the tool had to hold six steps and five tool names in their head. The
 * tool was honest and the product was unusable.
 *
 * This is the same steps, called in order, so that "写第 12 章" is one sentence.
 * It stops before `commit` on purpose: a draft is the studio's opinion, and the
 * file is the author's decision. The report ends with the single next thing to
 * do, because that is the question the author actually has.
 *
 * @param ctx - plugin context, for spawning.
 * @param deps - config and store resolution.
 * @param args - `number`, optional `directive`.
 * @param exec - execution context, for the parent agent.
 * @returns the summary the author reads.
 */
/**
 * The panel's round: two reviewers and the chief, reading what is already there.
 *
 * Deliberately no writer. Writing is the commander's job — the author says what
 * they want in the conversation, and `novel_dispatch` spawns the writer. When the
 * panel also spawned one, the workshop had two entry points that produced prose,
 * two sets of gates that disagreed, and a button that fired two thousand words the
 * author never asked for. The panel's round is the quality gate, not the pen.
 *
 * Runs on committed prose when no draft exists, so a chapter that arrived whole
 * can be read without being rewritten first.
 *
 * @param ctx - plugin context, for spawning.
 * @param deps - config and store resolution.
 * @param args - the chapter number.
 * @param exec - execution context carrying the parent agent.
 * @param onStage - progress: which reviewer holds the pen.
 * @returns findings and a report, shaped like runRound's minus the writer parts.
 */
export async function runReviewRound(
  ctx: Context,
  deps: ToolDeps,
  args: { number: number },
  exec: { agent?: unknown; signal: AbortSignal },
  onStage?: (stage: ReviewStage) => void,
): Promise<Record<string, unknown>> {
  const pass = (extra: Record<string, unknown>) => ({ number: args.number, ...extra })

  onStage?.('logic')
  const logic = (await dispatchOne(ctx, deps, 'logic', pass({}), exec)) as unknown as RoundReview
  onStage?.('character')
  const character = (await dispatchOne(ctx, deps, 'character', pass({}), exec)) as unknown as RoundReview
  onStage?.('chief')
  const chief = (await dispatchOne(
    ctx,
    deps,
    'chief',
    pass({
      findings: [
        { role: 'logic', items: logic.findings ?? [] },
        { role: 'character', items: character.findings ?? [] },
      ],
    }),
    exec,
  )) as unknown as RoundReview

  const tallyOf = (review: RoundReview) => {
    const list = (review.findings ?? []) as { severity?: string }[]
    return {
      errors: list.filter((item) => item.severity === 'error').length,
      warnings: list.filter((item) => item.severity === 'warn').length,
      infos: list.filter((item) => item.severity === 'info').length,
    }
  }
  const line = (review: RoundReview) => {
    const counts = tallyOf(review)
    return `${counts.errors} 必改 / ${counts.warnings} 建议改 / ${counts.infos} 可忽略`
  }
  const verdict = tallyOf(chief)
  const blocking = verdict.errors > 0
  const open = verdict.warnings + verdict.infos

  return {
    role: 'review',
    number: args.number,
    findings: chief.findings ?? [],
    report: [
      `第${args.number}章审核完一轮（正文未动，${args.number} 章照旧）。`,
      '',
      `逻辑审核　${line(logic)}`,
      `人物审核　${line(character)}`,
      `总裁决　　${line(chief)}`,
      '',
      blocking
        ? `总裁决认定 ${verdict.errors} 条必改。下一步：在对话里说「按审核意见改第${args.number}章」，改完再点一次审核。`
        : open > 0
          ? `没有必改项，还有 ${open} 条建议。采不采纳由你：在对话里说「按审核意见改第${args.number}章」，或者不管它。`
          : '三份审核都没意见。这一章不用动。',
    ].join('\n'),
  }
}

export async function runRound(
  ctx: Context,
  deps: ToolDeps,
  args: { number: number; directive?: string },
  exec: { agent?: unknown; signal: AbortSignal },
  onStage?: (stage: RoundStage) => void,
): Promise<Record<string, unknown>> {
  const store = deps.storeFor(exec)
  const number = args.number
  const directive = args.directive ?? ''
  const pass = (extra: Record<string, unknown>) => ({
    number,
    ...(directive === '' ? {} : { directive }),
    ...extra,
  })

  onStage?.('writer')
  const written = await dispatchOne(ctx, deps, 'writer', pass({}), exec)
  const text = String(written.text ?? '')
  if (text.trim() === '') {
    throw new Error('写手这次没有交回正文（模型返回为空）。换个写手模型：novel_roles action="set" role="writer" …，或单独用 action="writer" 跑一次看它卡在哪。')
  }

  // Same checks `novel_chapter action="propose"` runs, so a round and a manual
  // draft are the same object.
  const filed = await proposeDraft(store, deps.config, { number, text })

  // Sequential, not parallel: one workshop, one notebook, and a report that
  // reads in the order the author thinks.
  onStage?.('logic')
  const logic = (await dispatchOne(ctx, deps, 'logic', pass({}), exec)) as unknown as RoundReview
  onStage?.('character')
  const character = (await dispatchOne(ctx, deps, 'character', pass({}), exec)) as unknown as RoundReview
  onStage?.('chief')
  const chief = (await dispatchOne(
    ctx,
    deps,
    'chief',
    pass({
      findings: [
        { role: 'logic', items: logic.findings ?? [] },
        { role: 'character', items: character.findings ?? [] },
      ],
    }),
    exec,
  )) as unknown as RoundReview

  // Count from the findings themselves: a reviewer returns a list, not a
  // summary, and inventing a second shape here is how the two drift apart.
  const tallyOf = (review: RoundReview) => {
    const list = (review.findings ?? []) as { severity?: string }[]
    return {
      errors: list.filter((item) => item.severity === 'error').length,
      warnings: list.filter((item) => item.severity === 'warn').length,
      infos: list.filter((item) => item.severity === 'info').length,
    }
  }
  const line = (review: RoundReview) => {
    const counts = tallyOf(review)
    return `${counts.errors} 必改 / ${counts.warnings} 建议改 / ${counts.infos} 可忽略`
  }
  const verdict = tallyOf(chief)
  const blocking = verdict.errors > 0
  const open = verdict.warnings + verdict.infos

  return {
    role: 'round',
    number,
    text,
    words: filed.words,
    findings: chief.findings ?? [],
    report: [
      `第${number}章走完一轮：写手交了 ${filed.words} 字，存成第 ${filed.round} 轮草稿（还没进正文）。`,
      '',
      `自动体检　${filed.errors} 必改 / ${filed.warnings} 建议改`,
      `逻辑审核　${line(logic)}`,
      `人物审核　${line(character)}`,
      `总裁决　　${line(chief)}`,
      '',
      blocking
        ? `总裁决认定 ${verdict.errors} 条必改。下一步：改这一轮，再跑 novel_dispatch action="round" number=${number}；或者先看草稿 novel_chapter action="read" number=${number}。`
        : open > 0
          ? `没有必改项，还有 ${open} 条建议。下一步二选一：\n  · 收下：novel_chapter action="commit" number=${number}（定稿后再逐条结案）\n  · 先改：照清单改完，重跑 novel_dispatch action="round" number=${number}`
          : `三份审核都没意见。下一步：novel_chapter action="commit" number=${number} 定稿。`,
      '',
      '正文没有自动进 chapters —— 定稿是你的决定，不是流水线的。',
    ].join('\n'),
  }
}
