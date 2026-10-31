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
import { countChars } from '../domain/text.ts'
import {
  buildLorePrompt,
  characterFromLore,
  emptyLore,
  parseLoreOutput,
  placeFromLore,
  topUpFromLore,
  worldFromLore,
} from '../domain/lore.ts'
import type { ProjectStore } from '../domain/store.ts'
import type { ChapterDraft } from '../domain/types.ts'
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
      '把已经写好的正文读成这本书的结构。三件事：① 章卡——派「档案员」为每章写梗概、关键事件、场景、出场人物、章末钩子（apply，一批默认 8 章）；② 设定——派「考据员」从正文抽出人物、地点、势力与规则，每条都带原文引用（lore，一批默认 40 章）；③ 只报告还缺什么（plan）。导入一本旧稿之后必须跑，否则人物设计、世界观、前情摘要全是空的。所有写入只填空着的字段，写好的一律不覆盖；voice 从不自动生成。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['plan', 'apply', 'lore'],
        description: 'plan 只读、只报告缺口；apply 读正文写章卡；lore 读正文写人物／地点／世界观。',
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

      if (args.action === 'lore') {
        return await runLore(ctx, deps, store, chapters, args, exec)
      }

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

/** How many chapters one lore batch reads by default. */
const LORE_BATCH = 40
/** Ceiling: past this the prose no longer fits a prompt worth sending. */
const LORE_BATCH_MAX = 120
/** Characters of prose one lore batch may carry. */
const LORE_BUDGET_CHARS = 60_000

/**
 * Read the canon out of the prose: who is in this book, where it happens, what
 * the rules are.
 *
 * One batch is many chapters, because a character is not legible from one: a
 * goal stated in chapter 3 only looks like a goal when chapter 60 shows it being
 * pursued. The budget is in characters rather than chapters for the same reason
 * — forty chapters of 3000 characters is a different request from forty of 800.
 *
 * @param ctx - plugin context, for spawning.
 * @param deps - config and store resolution.
 * @param store - the book.
 * @param chapters - every chapter with its text.
 * @param args - `from`, `to`, `limit`.
 * @param exec - execution context, for the parent agent.
 * @returns the report, in the shape the tool declares.
 */
async function runLore(
  ctx: Context,
  deps: ToolDeps,
  store: ProjectStore,
  chapters: readonly ChapterDraft[],
  args: { from?: number; to?: number; limit?: number },
  exec: { agent?: unknown; signal: AbortSignal },
): Promise<{
  report: string
  written: number
  missing: number
  next: number
  failed: number[]
}> {
  const project = await store.readProject()
  const existing = {
    characters: new Set((await store.characters()).map((card) => card.name)),
    places: new Set((await store.places()).map((card) => card.name)),
    world: new Set((await store.world()).map((entry) => entry.name)),
  }

  const from = Number.isInteger(args.from) && Number(args.from) > 0 ? Number(args.from) : 1
  const asked = Number.isInteger(args.limit) && Number(args.limit) > 0 ? Number(args.limit) : LORE_BATCH
  const limit = Math.min(asked, LORE_BATCH_MAX)
  const to = Number.isInteger(args.to) && Number(args.to) > 0 ? Number(args.to) : Number.POSITIVE_INFINITY

  // Take whole chapters while the budget lasts; a chapter that would cross it
  // ends the batch rather than being cut in half — half a chapter reads as a
  // character who never finishes a sentence.
  const batch: ChapterDraft[] = []
  let budget = LORE_BUDGET_CHARS
  for (const chapter of chapters) {
    if (chapter.number < from || chapter.number > to) continue
    if (batch.length >= limit) break
    if (chapter.text.trim() === '') continue
    if (batch.length > 0 && countChars(chapter.text) > budget) break
    batch.push(chapter)
    budget -= countChars(chapter.text)
  }

  if (batch.length === 0) {
    return {
      report: `第 ${from} 到 ${to === Number.POSITIVE_INFINITY ? '末尾' : to} 章之间没有正文可读。`,
      written: 0,
      missing: 0,
      next: 0,
      failed: [],
    }
  }

  const span =
    batch.length === 1
      ? `第${batch[0]!.number}章`
      : `第${batch[0]!.number}–${batch[batch.length - 1]!.number}章`
  const role = ROLES.lorekeeper
  const route = resolveRoleRoute('lorekeeper', deps.config, project.roles)
  const prompt = buildLorePrompt(
    { span, text: batch.map((chapter) => `=== 第${chapter.number}章 ${chapter.title} ===\n${chapter.text}`).join('\n\n') },
    role.persona,
    role.outputContract,
  )

  let lore = emptyLore()
  try {
    const output = await runRole(ctx, role.persona, prompt, exec, route, 'inkwell-lore')
    lore = parseLoreOutput(output)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      report: `考据没有跑成（${message}）。一个字都没写进去。`,
      written: 0,
      missing: 0,
      next: 0,
      failed: batch.map((chapter) => chapter.number),
    }
  }

  const now = new Date()
  const anchor = batch[0]!.number
  let created = 0
  let topped = 0

  const cards = await store.characters()
  const byName = new Map(cards.map((card) => [card.name, card]))
  for (const entry of lore.characters) {
    const previous = byName.get(entry.name)
    if (previous === undefined) {
      await store.upsertCharacter(characterFromLore(entry, now))
      created += 1
    } else {
      // Only fills blanks. A card the author wrote is never replaced by a card
      // a model read — including its empty `voice`, which stays empty.
      const next = topUpFromLore(previous, entry, now)
      if (JSON.stringify(next) !== JSON.stringify(previous)) {
        await store.upsertCharacter(next)
        topped += 1
      }
    }
  }

  const placeCards = await store.places()
  const placeByName = new Map(placeCards.map((card) => [card.name, card]))
  let places = 0
  for (const entry of lore.places) {
    if (placeByName.has(entry.name)) continue
    await store.upsertPlace(placeFromLore(entry, anchor, now))
    places += 1
  }

  const worldEntries = await store.world()
  const worldByName = new Map(worldEntries.map((entry) => [entry.name, entry]))
  let world = 0
  for (const entry of lore.world) {
    if (worldByName.has(entry.name)) continue
    await store.upsertWorld(worldFromLore(entry, now))
    world += 1
  }

  // The premise is the one thing a book cannot be used without: the canon gate
  // asks for it, and every briefing opens with it. Filled only when empty.
  let premise = false
  if (project.premise.trim() === '' && lore.premise !== '') {
    await store.writeProject({ ...project, premise: lore.premise, updatedAt: now.toISOString() })
    premise = true
  }

  const nextChapter = chapters.find((chapter) => chapter.number > batch[batch.length - 1]!.number)
  const remaining = chapters.filter((chapter) => chapter.number > batch[batch.length - 1]!.number && chapter.text.trim() !== '')

  const lines = [`考据了 ${span}（${countChars(batch.map((c) => c.text).join(''))} 字）。`]
  if (created > 0) lines.push(`新建角色卡 ${created} 张：${lore.characters.filter((e) => !existing.characters.has(e.name)).slice(0, 10).map((e) => e.name).join('、')}${created > 10 ? ' 等' : ''}。`)
  if (topped > 0) lines.push(`补齐已有角色卡 ${topped} 张（只填了空着的字段）。`)
  if (places > 0) lines.push(`新地点 ${places} 个：${lore.places.filter((e) => !existing.places.has(e.name)).slice(0, 8).map((e) => e.name).join('、')}${places > 8 ? ' 等' : ''}。`)
  if (world > 0) lines.push(`新世界观条目 ${world} 条：${lore.world.filter((e) => !existing.world.has(e.name)).slice(0, 8).map((e) => e.name).join('、')}${world > 8 ? ' 等' : ''}。`)
  if (premise) lines.push(`一句话立意：填上了（原文没写过，这是考据员读出来的——不对就改）。`)
  if (created + topped + places + world === 0 && !premise) {
    lines.push('这一段没有读出新的东西：正文里的人可能已经都在卡上了，或者这一段本来就只有情节没有交代。')
  }
  if (lore.characters.length === 0) {
    lines.push('', '注意：这一段没有读出任何带原文引用的人。要么这段是纯情节，要么模型没按要求抄原文——后者换个模型再来。')
  }

  if (remaining.length > 0 && nextChapter !== undefined) {
    lines.push(
      '',
      `还剩 ${remaining.length} 章没考据。接着跑：novel_archive action="lore" from=${nextChapter.number} limit=${LORE_BATCH}`,
    )
  } else {
    lines.push('', '全书都考据过了。接着 novel_archive action="apply" 补章卡，或者 novel_check action="all" 看看现在对不对得上。')
  }

  return {
    report: lines.join('\n'),
    written: created + topped,
    missing: remaining.length,
    next: nextChapter?.number ?? 0,
    failed: [],
  }
}
