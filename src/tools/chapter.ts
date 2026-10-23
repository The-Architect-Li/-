/** `novel_chapter`: write, propose, commit, read, and list chapter bodies. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { checkContract, rank } from '../domain/contract.ts'
import { scanChapter } from '../domain/scan.ts'
import { countChars, splitParagraphs } from '../domain/text.ts'
import type { ChapterDraft, Finding } from '../domain/types.ts'
import { formatFindings, tally, type ToolDeps } from './deps.ts'

function deriveSummary(text: string): string {
  const paragraphs = splitParagraphs(text)
  const last = paragraphs[paragraphs.length - 1] ?? ''
  return last.length > 80 ? `${last.slice(0, 80)}…` : last
}

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
      '章节正文。studio 流程用 propose→commit：propose 把稿子存成草稿并跑章纲合同+确定性扫描（不挡，原样留待审核）；commit 把最新草稿定稿进 chapters（你点头后调）。write 是绕过流水线的直接落笔，合同 error 会拒绝保存。read 读某章；list 列出全部章节。写完一章建议接着 novel_ledger 记事实。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['write', 'propose', 'commit', 'read', 'list'],
        description: 'write 直接写 / propose 落草稿 / commit 定稿 / read 读 / list 列表',
      },
      number: { type: 'number', description: '章号，从 1 开始' },
      text: { type: 'string', description: 'write 或 propose 时的完整正文' },
      summary: { type: 'string', description: '本章一句话摘要，供后续章节的上下文包使用；不填则自动取末段' },
      title: { type: 'string', description: '章节标题，默认沿用章纲标题' },
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
        return {
          number,
          words: draft.words,
          errors: 0,
          warnings: 0,
          chapters: [],
          report: [
            `第${number}章《${draft.title}》　${draft.words} 字`,
            draft.summary ? `摘要：${draft.summary}` : '',
            '',
            draft.text,
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
          report: `第${number}章《${meta.title}》已定稿（${meta.words} 字），进入 chapters。可以接着写下一章，或用 novel_ledger 记本章新确立的设定。`,
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
      const blocking = contract.filter((finding) => finding.severity === 'error')
      if (blocking.length > 0) {
        throw new Error(
          [
            `第${number}章未通过章纲合同，没有保存：`,
            formatFindings(blocking),
            '',
            '两条路：改正文让这些角色出场，或者改章纲（novel_outline action="add_chapter" 会重置批准，需要重新 approve_chapter）。',
          ].join('\n'),
        )
      }

      const previous = await store.allChapters()
      const draft: ChapterDraft = {
        number,
        title: args.title?.trim() || plan.title,
        words: countChars(text),
        summary: args.summary?.trim() || deriveSummary(text),
        writtenAt: new Date().toISOString(),
        text,
      }
      const findings: Finding[] = rank([...contract, ...scanChapter(draft, previous, deps.config)])
      await store.writeChapter(draft)
      const counts = tally(findings)

      return {
        number,
        words: draft.words,
        errors: counts.errors,
        warnings: counts.warnings,
        chapters: [],
        report: [
          `第${number}章《${draft.title}》已保存，${draft.words} 字。`,
          counts.errors + counts.warnings > 0
            ? ['', formatFindings(findings.filter((item) => item.severity !== 'info'))].join('\n')
            : '',
          '',
          '下一步：把本章新确立的设定用 novel_ledger 记进账本（action="record"），避免后面自相矛盾。',
        ].filter(Boolean).join('\n'),
      }
    },
  }))
}
