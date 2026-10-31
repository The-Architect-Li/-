/**
 * `novel_archive`: read prose that is already written and write its chapter cards.
 *
 * The importer puts a manuscript into the book's shape — one file per chapter,
 * a title, a word count. What it cannot do is say what each chapter *is*: who
 * walked on, what changed, what was left hanging. Those answers live in the
 * cards, and every feature downstream reads them.
 *
 * Doing this in one call for 500 chapters was never an option: it would cost a
 * fortune in tokens, fail at chapter 300 with no way to resume, and hide the
 * fact that a model wrote something wrong in chapter 12. So it is batched, the
 * caller says which chapters, and every batch reports what is left.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  buildArchivePrompt,
  chaptersNeedingCards,
  mergeArchiveCard,
  parseArchiveOutput,
  type ArchiveInput,
} from '../domain/archive.ts'
import { UNASSIGNED } from '../domain/volumes.ts'
import { ROLES, resolveRoleRoute } from '../roles.ts'
import { runRole } from '../spawn.ts'
import type { ToolDeps } from './deps.ts'

/** How many chapters one batch reads by default. */
const DEFAULT_BATCH = 8
/** A hard ceiling: past this the prompt stops being readable and starts being skipped. */
const MAX_BATCH = 30

/**
 * Register the archiving tool.
 *
 * @param ctx - plugin context with the tool registry and the subagent registry.
 * @param deps - per-session store resolution and config.
 */
export function registerArchiveTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'novel_archive',
    description:
      '把已经写好的正文读成章卡：派「档案员」读正文，为每一章写故事梗概、关键事件、场景、出场人物、章末钩子，写进章纲的卡字段（不动章纲的必写节拍与批准状态）。plan=只报告哪些章还没有卡、下一批是哪几章；apply=读一批并写入。导入一本旧稿之后用它，否则前情摘要、人物出场、章节记忆这些全都读不到东西。一批默认 8 章，可指定 from/to 与 limit；每批回来都会说还剩多少。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['plan', 'apply'],
        description: 'plan 只读、只报告；apply 真读真写。',
      },
      from: { type: 'number', description: '从第几章开始（默认：第一张缺卡的章）' },
      to: { type: 'number', description: '到第几章为止（默认：不限，由 limit 决定）' },
      limit: { type: 'number', description: `这一批最多几章，默认 ${DEFAULT_BATCH}，上限 ${MAX_BATCH}` },
      overwrite: {
        type: 'boolean',
        description: '连已有的卡也重写（默认 false：只补缺的、以及描述的是旧版本正文的）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'string' },
          written: { type: 'number' },
          missing: { type: 'number' },
          next: { type: 'number' },
          failed: { type: 'array', items: { type: 'number' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    async execute(args, exec) {
      const store = deps.storeFor(exec)
      if (!(await store.exists())) {
        throw new Error(`这里还没有书：${store.root} 里没有 project.json。先把稿子导进来，或新建一本。`)
      }
      const chapters = await store.allChapters()
      const plans = await store.plans()
      if (chapters.length === 0) {
        throw new Error('这本书还没有正文。novel_import action="apply" 先把稿子导进来。')
      }

      const needs = args.overwrite === true
        ? chapters.map((chapter) => chapter.number).sort((a, b) => a - b)
        : chaptersNeedingCards(chapters, plans)

      if (args.action === 'plan') {
        return {
          report: describeNeed(needs, chapters.length),
          written: 0,
          missing: needs.length,
          next: needs[0] ?? 0,
          failed: [],
        }
      }

      if (needs.length === 0) {
        return {
          report: `全部 ${chapters.length} 章都已经有卡，而且描述的是当前这版正文。不用再跑。\n想重写已有的卡，加 overwrite=true。`,
          written: 0,
          missing: 0,
          next: 0,
          failed: [],
        }
      }

      const from = Number.isInteger(args.from) && Number(args.from) > 0 ? Number(args.from) : needs[0]!
      const to = Number.isInteger(args.to) && Number(args.to) > 0 ? Number(args.to) : Number.POSITIVE_INFINITY
      const asked = Number.isInteger(args.limit) && Number(args.limit) > 0 ? Number(args.limit) : DEFAULT_BATCH
      const limit = Math.min(asked, MAX_BATCH)
      const batch = needs.filter((number) => number >= from && number <= to).slice(0, limit)
      if (batch.length === 0) {
        return {
          report: `第 ${from} 到 ${to === Number.POSITIVE_INFINITY ? '末尾' : to} 章之间没有缺卡的章。还有 ${needs.length} 章等着，最近的一章是第 ${needs[0]} 章。`,
          written: 0,
          missing: needs.length,
          next: needs[0] ?? 0,
          failed: [],
        }
      }

      const role = ROLES.archivist
      const route = resolveRoleRoute('archivist', deps.config, (await store.readProject()).roles)
      const inputs: ArchiveInput[] = []
      const byNumber = new Map(chapters.map((chapter) => [chapter.number, chapter]))
      for (const number of batch) {
        const chapter = byNumber.get(number)
        if (chapter === undefined) continue
        inputs.push({ number, title: chapter.title, text: chapter.text })
      }

      const prompt = buildArchivePrompt(inputs, role.persona, role.outputContract)
      const output = await runRole(ctx, role.persona, prompt, exec, route, 'inkwell-archive')
      const cards = parseArchiveOutput(output)

      const written: number[] = []
      const seen = new Set<number>()
      for (const card of cards) {
        if (!batch.includes(card.number) || seen.has(card.number)) continue
        seen.add(card.number)
        const chapter = byNumber.get(card.number)!
        const existing = plans.find((plan) => plan.number === card.number)
        await store.upsertPlan(
          mergeArchiveCard(existing, card, chapter.title, UNASSIGNED, chapter.revision ?? 0),
        )
        written.push(card.number)
      }

      const failed = batch.filter((number) => !written.includes(number))
      const remaining = needs.filter((number) => !written.includes(number))
      return {
        report: describeBatch(written, failed, remaining, batch.length),
        written: written.length,
        missing: remaining.length,
        next: remaining[0] ?? 0,
        failed,
      }
    },
  }))
}

/**
 * What the plan action says: how many chapters are waiting, and why.
 *
 * @param needs - chapter numbers that have no usable card.
 * @param total - how many chapters the book has.
 * @returns the report.
 */
function describeNeed(needs: readonly number[], total: number): string {
  if (needs.length === 0) {
    return `全部 ${total} 章都已经有卡，而且描述的是当前这版正文。`
  }
  const head = needs.slice(0, 12).join('、')
  const more = needs.length > 12 ? ` 等` : ''
  return [
    `${total} 章里有 ${needs.length} 章还没有可用的章卡。`,
    `最早的是：第 ${head} 章${more}。`,
    '',
    `下一批：novel_archive action="apply" from=${needs[0]} limit=${DEFAULT_BATCH}`,
    '每批都会说还剩多少；不满意就停下，先看一眼写进去的卡，再决定要不要接着跑。',
  ].join('\n')
}

/**
 * What one batch says: what landed, what did not, what is left.
 *
 * @param written - chapters whose card was stored.
 * @param failed - chapters the model answered nothing usable for.
 * @param remaining - chapters still without a card afterwards.
 * @param asked - how many were sent.
 * @returns the report.
 */
function describeBatch(
  written: readonly number[],
  failed: readonly number[],
  remaining: readonly number[],
  asked: number,
): string {
  const lines: string[] = []
  lines.push(`这一批读了 ${asked} 章，写下 ${written.length} 张卡。`)
  if (written.length > 0) {
    lines.push(`已完成：第 ${written.slice(0, 12).join('、')} 章${written.length > 12 ? ' 等' : ''}。`)
  }
  if (failed.length > 0) {
    lines.push(
      '',
      `模型没有给出可用结果：第 ${failed.join('、')} 章。这几章多半是正文太长被截、或者它答成了散文。`,
      '它们没有被写成空卡——原样留着，下一批会再试一次。',
    )
  }
  if (remaining.length > 0) {
    lines.push(
      '',
      `还剩 ${remaining.length} 章。接着跑：novel_archive action="apply" from=${remaining[0]} limit=${DEFAULT_BATCH}`,
    )
  } else {
    lines.push('', '全书都有卡了。接着 novel_check action="all"，看看这些卡和正文对不对得上。')
  }
  return lines.join('\n')
}
