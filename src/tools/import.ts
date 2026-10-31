/**
 * `novel_import`: bring a manuscript that already exists into a book.
 *
 * Two actions, and the order matters: `scan` reads the folder and says exactly
 * what would happen without writing anything, `apply` does it. The tool exists
 * because the realistic first question from a writer with 86 chapters on disk
 * is "can these become a book the checker knows about?" — and the honest
 * answer, before v0.12, was "type them in again".
 */
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { applyImport } from '../domain/import-apply.ts'
import { planImport } from '../domain/import-scan.ts'
import { describeScan, isDirectory, readSources, summarize, wordsText } from '../domain/manuscript.ts'
import type { ProjectStore } from '../domain/store.ts'
import { formatFindings } from './deps.ts'
import type { ToolDeps } from './deps.ts'

/** The same plan read twice must not disagree about what exists. */
async function existingChapters(store: ProjectStore): Promise<Set<number>> {
  const metas = await store.chapters()
  return new Set(metas.map((meta) => meta.number))
}

/**
 * Register the import tool.
 *
 * @param ctx - plugin context with the tool registry.
 * @param deps - per-session store resolution and config.
 */
export function registerImportTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'novel_import',
    description:
      '把已经在磁盘上的稿子导进 Inkwell 这本书。scan 只读：看 正文/（或 chapters/）里的「第N章-标题.md」、人物/ 里的角色文件、大纲/全书大纲.md，报告会写什么，不落一个字。apply 按 scan 的结果写：章正文进 chapters/00N.md 与 index.json（带版本号）、角色进 canon/characters.json、分卷与章纲进 outline/。默认不覆盖已有的章。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['scan', 'apply'],
        description: 'scan 只读预览；apply 真写。',
      },
      dir: {
        type: 'string',
        required: true,
        description: '稿子所在的绝对路径：里面应当有 正文/、人物/、大纲/（缺哪个就跳过哪个）。',
      },
      overwrite: {
        type: 'boolean',
        description: 'apply 时覆盖本书已有的章（默认 false：跳过并报告）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'string' },
          chapters: { type: 'number' },
          words: { type: 'number' },
          cast: { type: 'number' },
          volumes: { type: 'number' },
          plans: { type: 'number' },
          skipped: { type: 'number' },
          conflicts: { type: 'array', items: { type: 'number' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    async execute(args, exec) {
      const store = deps.storeFor(exec)
      const raw = typeof args.dir === 'string' ? args.dir.trim() : ''
      if (raw === '') throw new Error('dir 不能为空：告诉我稿子在哪个文件夹。')
      if (!isAbsolute(raw)) throw new Error(`dir 必须是绝对路径：${raw}`)
      const dir = resolve(raw)
      if (!(await isDirectory(dir))) throw new Error(`没有这个文件夹：${dir}`)

      const sources = await readSources(dir)
      const plan = planImport(sources)
      const exists = await store.exists()
      const existing = exists ? await existingChapters(store) : new Set<number>()
      const summary = summarize(dir, plan, existing, sources.used, sources.capped)
      const words = plan.chapters.reduce((sum, chapter) => sum + chapter.words, 0)

      if (args.action === 'scan') {
        return {
          report: describeScan(summary, exists ? store.root : undefined),
          chapters: summary.chapters,
          words: summary.words,
          cast: summary.cast,
          volumes: summary.volumes,
          plans: summary.plans,
          skipped: 0,
          conflicts: summary.conflicts,
        }
      }

      if (!exists) {
        throw new Error(
          `这里还没有书：${store.root} 里没有 project.json。先 novel_project action="init"（或直接在面板里新建），再 apply。`,
        )
      }

      const overwrite = args.overwrite === true
      const applied = await applyImport(store, plan, { overwrite })

      const lines = [
        `导入完成：${applied.written} 章${applied.skipped > 0 ? `（跳过 ${applied.skipped} 章，已存在）` : ''}、${plan.cast.length} 张角色卡、${plan.volumes.length} 卷、${plan.plans.length} 条章纲。`,
        `正文共 ${wordsText(applied.words)}，写在 ${join(store.root, 'chapters')}。`,
      ]
      // An imported book has prose and no memory. Saying so here is the whole
      // difference between "I imported my novel" and "I imported 521 files that
      // the checker cannot say anything about".
      if (applied.written > 0) {
        lines.push(
          '',
          `这 ${applied.written} 章还没有章卡：梗概、关键事件、出场人物、章末钩子都空着，所以前情摘要与人物出场读不到东西。`,
          '让档案员读一遍补上：novel_archive action="plan" 先看缺多少，再 action="apply" 一批一批写（默认 8 章一批，每批都会说还剩多少）。',
        )
      }
      lines.push('另外：novel_check action="all" 看看这些老章节自己的问题。')
      if (applied.phase === 'drafting') {
        lines.push(
          `阶段：这本书已经有正文，阶段直接落在「drafting」，不必从 premise 重走一遍——现在可以接着写第 ${plan.chapters.reduce((max, chapter) => Math.max(max, chapter.number), 0) + 1} 章。`,
        )
      }
      if (applied.clock !== undefined) {
        lines.push(
          `时间线：从这些正文里认出了 ${applied.clock.anchors} 个日期、${applied.clock.spans} 段跨度${
            applied.clock.start === undefined ? '' : `，起点定在 ${applied.clock.start}`
          }。季节和「多日后」没有算——猜一个日期，后面会撞车。`,
        )
      }
      if (plan.chapters.length === 0) {
        lines.push(
          '',
          formatFindings([
            { severity: 'warn', code: 'import/no-prose', message: '这个文件夹里没找到带章号的正文，什么都没写进去。', evidence: dir },
          ]),
        )
      }
      return {
        report: lines.join('\n'),
        chapters: applied.written,
        words,
        cast: plan.cast.length,
        volumes: plan.volumes.length,
        plans: plan.plans.length,
        skipped: applied.skipped,
        conflicts: summary.conflicts,
      }
    },
  }))
}
