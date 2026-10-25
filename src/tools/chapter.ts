/** `novel_chapter`: write, propose, commit, read, and list chapter bodies. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { checkContract, rank } from '../domain/contract.ts'
import { recordCoverage } from '../domain/records.ts'
import { ChapterBlockedError, deriveSummary, saveChapterBody } from '../domain/save.ts'
import { scanChapter } from '../domain/scan.ts'
import type { ProjectStore } from '../domain/store.ts'
import { countChars, splitParagraphs } from '../domain/text.ts'
import type { ChapterDraft, Finding, ReviewItem, ReviewRound } from '../domain/types.ts'
import { formatFindings, tally, type ToolDeps } from './deps.ts'

/**
 * Register the chapter tool.
 *
 * Writing is the only tool whose failure blocks the save: a draft that misses a
 * required character is not saved at all, so the manuscript never contains a
 * chapter that silently violated its own outline.
 *
 * @param ctx - plugin context with the tool registry.
 * @param deps - store and resolved config.
 */
export function registerChapterTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'novel_chapter',
    description:
      '章节正文。studio 流程用 propose→commit：propose 把稿子存成草稿并跑章纲合同+确定性扫描（不挡，原样留待审核）；commit 把最新草稿定稿进 chapters（你点头后调）。write 是绕过流水线的直接落笔，合同 error 会拒绝保存；write 与 restore 都要带上你读到的那一版 revision（防两处同时改互相覆盖），确要无条件覆盖传 force=true。restore 把某一轮草稿回退成正文。read 读某章（报告里带 revision 与审稿历史）。review 看某一章的审稿条目、并给单条结案（state=fixed/waived + note）。list 列出全部章节。写完一章建议接着 novel_ledger 记事实。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['write', 'propose', 'commit', 'restore', 'read', 'list', 'review'],
        description:
          'write 直接写 / propose 落草稿 / commit 定稿 / restore 回退到某一轮草稿 / read 读 / list 列表 / review 看审稿条目并结案',
      },
      number: { type: 'number', description: '章号，从 1 开始' },
      text: { type: 'string', description: 'write 或 propose 时的完整正文' },
      summary: { type: 'string', description: '本章一句话摘要，供后续章节的上下文包使用；不填则自动取末段' },
      title: { type: 'string', description: '章节标题，默认沿用章纲标题' },
      revision: {
        type: 'number',
        description: 'write/restore 时的基准版本号：novel_chapter action="read" 的报告里有。别处改过就会拒绝，先重读',
      },
      round: { type: 'number', description: 'restore 时回退到第几轮草稿（propose 报告的「第 N 轮」）' },
      force: { type: 'boolean', description: 'write/restore 时无视版本冲突，直接覆盖' },
      id: { type: 'string', description: 'review 时要结案的条目 id（形如 005-r2-3），不填则列出全部条目' },
      state: {
        type: 'string',
        enum: ['open', 'fixed', 'waived'],
        description: 'review 结案状态：fixed 已改 / waived 认可不改（要在 note 里写为什么）/ open 重新打开',
      },
      note: { type: 'string', description: 'review 结案备注：改了什么，或为什么决定不改' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          number: { type: 'number' },
          words: { type: 'number' },
          errors: { type: 'number' },
          warnings: { type: 'number' },
          chapters: { type: 'array', items: { type: 'string' } },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    async execute(args, exec) {
      const store = deps.storeFor(exec)
      const snapshot = await store.snapshot()

      if (args.action === 'list') {
        const chapters = await store.chapters()
        const written = new Set(chapters.map((item) => item.number))
        return {
          number: 0,
          words: chapters.reduce((sum, item) => sum + item.words, 0),
          errors: 0,
          warnings: 0,
          chapters: chapters.map((item) => `第${item.number}章 ${item.title}（${item.words} 字）`),
          report: [
            `已写 ${chapters.length} 章，共 ${chapters.reduce((sum, item) => sum + item.words, 0)} 字。`,
            ...snapshot.plans
              .filter((plan) => !written.has(plan.number))
              .map((plan) => `待写：第${plan.number}章《${plan.title}》`),
          ].join('\n'),
        }
      }

      const number = args.number
      if (number === undefined || !Number.isInteger(number) || number < 1) {
        throw new Error('需要正整数 number。')
      }

      if (args.action === 'read') {
        const draft = await store.chapter(number)
        if (!draft) throw new Error(`第${number}章还没写。`)
        const rounds = await store.reviews(number)
        return {
          number,
          words: draft.words,
          errors: 0,
          warnings: 0,
          chapters: [],
          report: [
            `第${number}章《${draft.title}》　${draft.words} 字　第 ${draft.revision} 版`,
            draft.summary ? `摘要：${draft.summary}` : '',
            reviewHistory(rounds),
            '',
            draft.text,
          ].filter((line) => line !== '').join('\n'),
        }
      }

      if (args.action === 'review') {
        if (args.id === undefined || args.id.trim() === '') {
          const rounds = await store.reviews(number)
          return {
            number,
            words: 0,
            errors: 0,
            warnings: 0,
            chapters: [],
            report: reviewBoard(number, rounds),
          }
        }
        const state = args.state ?? 'open'
        if (state !== 'open' && state !== 'fixed' && state !== 'waived') {
          throw new Error('review 的 state 只能是 open / fixed / waived。')
        }
        if (state === 'waived' && (args.note ?? '').trim() === '') {
          throw new Error('waived 要在 note 里写清楚为什么决定不改——半年后你会想知道。')
        }
        const updated = await store.setReviewState(number, args.id.trim(), state, args.note ?? '')
        if (updated === undefined) {
          const rounds = await store.reviews(number)
          throw new Error(
            [
              `第${number}章没有 id 为「${args.id}」的审稿条目。`,
              '现有条目：',
              reviewBoard(number, rounds),
            ].join('\n'),
          )
        }
        return {
          number,
          words: 0,
          errors: 0,
          warnings: 0,
          chapters: [],
          report: [
            `${updated.id}　${reviewStateLabel(updated.state)}　${updated.message}`,
            updated.note === '' ? '' : `备注：${updated.note}`,
            '',
            reviewBoard(number, await store.reviews(number)),
          ].filter((line) => line !== '').join('\n'),
        }
      }

      if (args.action === 'commit') {
        const meta = await store.commitDraft(number)
        return {
          number,
          words: meta.words,
          errors: 0,
          warnings: 0,
          chapters: [],
          report: `第${number}章《${meta.title}》已定稿（${meta.words} 字，第 ${meta.revision} 版），进入 chapters。可以接着写下一章，或用 novel_ledger 记本章新确立的设定。`,
        }
      }

      if (args.action === 'restore') {
        const round = args.round
        if (round === undefined || !Number.isInteger(round) || round < 1) {
          throw new Error('restore 需要正整数 round（propose 报告里的「第 N 轮」）。')
        }
        const rounds = await store.draftsOf(number)
        const source = rounds.find((item) => item.round === round)
        if (source === undefined) {
          const seen = rounds.map((item) => item.round).join('、')
          throw new Error(`第${number}章没有第 ${round} 轮草稿。现有的轮次：${seen === '' ? '（没有草稿）' : seen}。`)
        }
        const base = args.force === true ? undefined : await baseRevisionFor(store, number, args.revision)
        const restored = await saveChapterBody(store, deps.config, {
          number,
          text: source.text,
          title: args.title ?? source.summary.slice(0, 40),
          summary: args.summary ?? source.summary,
          baseRevision: base,
        })
        return {
          number,
          words: restored.draft.words,
          errors: 0,
          warnings: 0,
          chapters: [],
          report: [
            `第${number}章已回退到第 ${round} 轮草稿：${restored.draft.words} 字，第 ${restored.draft.revision} 版。`,
            `标题跟着回到《${restored.draft.title}》。想要别的标题，再 write 一次。`,
          ].join('\n'),
        }
      }

      const text = args.text?.trim()
      if (!text) throw new Error(`${args.action} 需要 text。`)
      const plan = snapshot.plans.find((item) => item.number === number)
      if (!plan) throw new Error(`第${number}章没有章纲，先写章纲再落笔。`)

      const contract = checkContract(plan, text, deps.config)

      if (args.action === 'propose') {
        // A draft is saved as-is so the review pipeline can judge it. The
        // deterministic findings ride along on the round, never blocking.
        const previous = await store.allChapters()
        const round = (await store.draftsOf(number)).length + 1
        const words = countChars(text)
        const findings = rank([
          ...contract,
          ...scanChapter({ number, title: args.title?.trim() || plan.title, text, words, summary: args.summary?.trim() || deriveSummary(text), writtenAt: new Date().toISOString() }, previous, deps.config),
        ])
        const counts = tally(findings)
        await store.saveDraft({
          number,
          round,
          text,
          words,
          summary: args.summary?.trim() || deriveSummary(text),
          autoFindings: findings,
          writtenAt: new Date().toISOString(),
        })
        return {
          number,
          words,
          errors: counts.errors,
          warnings: counts.warnings,
          chapters: [],
          report: [
            `第${number}章草稿（第 ${round} 轮）已存，${words} 字，未进 chapters。`,
            findings.length === 0 ? '自动体检无发现。' : '',
            formatFindings(findings),
            '',
            '下一步：novel_dispatch action="logic"/"character" 审这章，再用 chief 汇总，最后你点头 novel_chapter commit。',
          ].filter(Boolean).join('\n'),
        }
      }

      // write: contract errors block the save so the manuscript stays clean.
      const base = args.force === true ? undefined : await baseRevisionFor(store, number, args.revision)
      let saved: { draft: ChapterDraft; findings: Finding[] }
      try {
        saved = await saveChapterBody(store, deps.config, {
          number,
          text,
          title: args.title,
          summary: args.summary,
          baseRevision: base,
        })
      } catch (error) {
        if (!(error instanceof ChapterBlockedError)) throw error
        throw new Error(
          [
            `第${number}章未通过章纲合同，没有保存：`,
            formatFindings(error.blockers),
            '',
            '两条路：改正文让这些角色出场，或者改章纲（novel_outline action="add_chapter" 会重置批准，需要重新 approve_chapter）。',
          ].join('\n'),
        )
      }

      const draft = saved.draft
      const findings = saved.findings
      const counts = tally(findings)
      const next = await recordHint(store, number)

      return {
        number,
        words: draft.words,
        errors: counts.errors,
        warnings: counts.warnings,
        chapters: [],
        report: [
          `第${number}章《${draft.title}》已保存，${draft.words} 字，第 ${draft.revision} 版。`,
          counts.errors + counts.warnings > 0
            ? ['', formatFindings(findings.filter((item) => item.severity !== 'info'))].join('\n')
            : '',
          '',
          '下一步：把本章新确立的设定用 novel_ledger 记进账本（action="record"），避免后面自相矛盾。',
          next,
        ].filter(Boolean).join('\n'),
      }
    },
  }))
}

/**
 * What to record about the chapter that was just saved.
 *
 * Locations, arcs and dates cannot be inferred from prose without inventing
 * them, so the tool does the next honest thing: it says whether this chapter
 * left a trace, and names the three calls that would leave one. The wording is
 * a checklist, not a scold — an author who deliberately records nothing should
 * be able to read it and move on.
 *
 * @param store - the book's store.
 * @param number - the chapter just written.
 * @returns one line for the report, or an empty string when it is covered.
 */
async function recordHint(store: ProjectStore, number: number): Promise<string> {
  const snapshot = await store.snapshot()
  const coverage = recordCoverage(snapshot)
  if (!coverage.silent.includes(number)) return ''
  const parts = [
    `这一章还没有地点、故事点或时间线的记录（全书 ${coverage.silent.length}/${coverage.written.length} 章如此）。`,
    `要更新的话：novel_canon action="upsert_place"（第 ${number} 章这里是什么样）、novel_timeline action="anchor"（这一章是哪天），story 该收尾就 novel_story action="close"。`,
  ]
  return parts.join('')
}

/**
 * One Chinese label per review item state.
 * @param state - open, fixed, or waived.
 * @returns the label a writer reads.
 */
function reviewStateLabel(state: ReviewItem['state']): string {
  if (state === 'fixed') return '已改'
  if (state === 'waived') return '不改'
  return '未结'
}

/**
 * Count how many reviewer findings are still open.
 *
 * @param rounds - every recorded round, oldest first.
 * @returns open and total item counts.
 */
function reviewTally(rounds: readonly ReviewRound[]): { open: number; total: number } {
  let open = 0
  let total = 0
  for (const round of rounds) {
    for (const item of round.items) {
      total += 1
      if (item.state === 'open') open += 1
    }
  }
  return { open, total }
}

/**
 * The one-line review summary that rides along with `action="read"`.
 *
 * @param rounds - every recorded round.
 * @returns a line like `审稿：3 轮，2/9 条未结`, or an empty string when nobody reviewed.
 */
function reviewHistory(rounds: readonly ReviewRound[]): string {
  if (rounds.length === 0) return ''
  const { open, total } = reviewTally(rounds)
  const roles = [...new Set(rounds.map((round) => round.role))].join('/')
  return `审稿：${rounds.length} 轮（${roles}），${open}/${total} 条未结。novel_chapter action="review" number=<章号> 看条目。`
}

/**
 * The full review board for one chapter.
 *
 * Grouped by round rather than flattened, because "which pass said this" is the
 * question a writer actually asks: a logic note from round 2 and a character
 * note from round 3 are different conversations.
 *
 * @param number - the chapter.
 * @param rounds - every recorded round, oldest first.
 * @returns a report; empty-reviewed chapters say so.
 */
function reviewBoard(number: number, rounds: readonly ReviewRound[]): string {
  if (rounds.length === 0) {
    return `第${number}章还没有审稿记录。派 novel_dispatch action="logic"/"character" 审一轮，结论会自动落进 reviews/。`
  }
  const { open, total } = reviewTally(rounds)
  const lines = [`第${number}章审稿：${rounds.length} 轮，${total} 条，${open} 条未结。`]
  for (const round of rounds) {
    lines.push('', `第 ${round.round} 轮 · ${round.role}（${round.route || '继承会话'}）· 草稿第 ${round.draftRound} 轮`)
    for (const item of round.items) {
      const mark = item.state === 'open' ? '　' : item.state === 'fixed' ? '✓' : '—'
      lines.push(`${mark} ${item.id}　[${item.severity}] ${item.message}`)
      if (item.evidence.trim() !== '') lines.push(`　　${item.evidence.trim()}`)
      if (item.note.trim() !== '') lines.push(`　　备注：${item.note.trim()}`)
    }
  }
  lines.push('', '结案：novel_chapter action="review" number=<章号> id="<条目>" state="fixed"|"waived" note="<改了什么/为什么>')
  return lines.join('\n')
}

/**
 * Work out which revision a save is based on.
 *
 * A chapter that already exists must be written through a revision: silence
 * here is exactly how a panel tab and a chat turn overwrite each other. A
 * chapter that does not exist yet has nothing to conflict with.
 *
 * @param store - the book.
 * @param number - the chapter about to be written.
 * @param requested - the revision the caller said it edited, if it said.
 * @returns the revision to compare against, or `undefined` for a first write.
 * @throws when the chapter exists and the caller named no revision.
 */
async function baseRevisionFor(
  store: ProjectStore,
  number: number,
  requested: number | undefined,
): Promise<number | undefined> {
  const existing = (await store.chapters()).find((item) => item.number === number)
  if (existing === undefined) return requested
  if (requested !== undefined) return requested
  throw new Error(
    [
      `第${number}章已经存在（第 ${existing.revision} 版），这次没有说基于哪一版。`,
      `先用 novel_chapter action="read" 读一遍（报告里有 revision），再 write 时传 revision=<那个数字>。`,
      '确实要无条件覆盖，传 force=true。',
    ].join('\n'),
  )
}
