/** `novel_chapter`: write, read, and list chapter bodies. */
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
      '章节正文。write 落笔（需要已批准的章纲，正文会经过章纲合同校验和确定性扫描：漏掉出场角色会被直接拒绝保存）；read 读取某章；list 列出全部章节与字数。写完一章建议接着用 novel_ledger 把新确立的设定记下来。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['write', 'read', 'list'],
        description: 'write 写 / read 读 / list 列表',
      },
      number: { type: 'number', description: '章号，从 1 开始' },
      text: { type: 'string', description: 'write 时的完整正文' },
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
    async execute(args) {
      const snapshot = await deps.store.snapshot()

      if (args.action === 'list') {
        const chapters = await deps.store.chapters()
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
        const draft = await deps.store.chapter(number)
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

      const text = args.text?.trim()
      if (!text) throw new Error('write 需要 text。')
      const plan = snapshot.plans.find((item) => item.number === number)
      if (!plan) throw new Error(`第${number}章没有章纲，先写章纲再落笔。`)

      const contract = checkContract(plan, text, deps.config)
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

      const previous = await deps.store.allChapters()
      const draft: ChapterDraft = {
        number,
        title: args.title?.trim() || plan.title,
        words: countChars(text),
        summary: args.summary?.trim() || deriveSummary(text),
        writtenAt: new Date().toISOString(),
        text,
      }
      const findings: Finding[] = rank([...contract, ...scanChapter(draft, previous, deps.config)])
      await deps.store.writeChapter(draft)
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
