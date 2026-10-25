/** `novel_export`: write the book out as files someone else can open. */
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { bookText, canonMarkdown, safeFileName, volumeFiles } from '../domain/export.ts'
import type { ToolDeps } from './deps.ts'

/**
 * Turn the `out` argument into an absolute directory.
 *
 * A relative path is taken from the book, not from the process: an export that
 * lands in whatever directory dsh happened to start in is a bug report waiting
 * to happen.
 *
 * @param out - the caller's path, or an empty string for the default.
 * @param root - the project root.
 * @returns an absolute directory path.
 */
function outputDir(out: string, root: string): string {
  if (out.trim() === '') return join(root, 'exports')
  const trimmed = out.trim()
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed)
}

/**
 * Register the export tool.
 *
 * @param ctx - plugin context with the tool registry.
 * @param deps - store and resolved config.
 */
export function registerExportTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'novel_export',
    description:
      '把书导出成文件。text 整本纯文本（投稿用，只有章名和段落）；markdown 按卷分文件（每卷一个 .md，外加未分卷）；canon 设定集（人物、世界观、分卷、章纲、事实账本）。默认写到书目录下的 exports/。只导出已落盘（novel_chapter write 或 commit 过）的章节，草稿不会混进去。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['text', 'markdown', 'canon'],
        description: 'text 整本 txt / markdown 按卷分 md / canon 设定集',
      },
      out: {
        type: 'string',
        description: '输出目录；相对路径按书目录算，省略则写到 <书>/exports',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dir: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    async execute(args, exec) {
      const store = deps.storeFor(exec)
      const snapshot = await store.snapshot()
      const dir = outputDir(args.out ?? '', store.root)
      const chapters = await store.allChapters()

      const files: { name: string; body: string }[] = []
      if (args.action === 'text') {
        files.push({ name: `${safeFileName(snapshot.project.title)}.txt`, body: bookText(snapshot, chapters) })
      } else if (args.action === 'markdown') {
        files.push(...volumeFiles(snapshot, chapters))
      } else {
        files.push({ name: `${safeFileName(snapshot.project.title)}·设定集.md`, body: canonMarkdown(snapshot) })
      }

      // A text or per-volume export of a book with no written chapters has
      // nothing to put in a file. The canon sheet still does: characters, the
      // outline and the ledger exist before the first chapter does.
      const needsProse = args.action !== 'canon'
      if (files.length === 0 || (needsProse && chapters.length === 0)) {
        return {
          dir,
          files: [],
          report: [
            '还没有可导出的正文。',
            'novel_chapter action="write" 写过、或 action="commit" 定过稿的章节才会进导出；propose 落下的草稿在 drafts/ 里，不算。',
          ].join('\n'),
        }
      }

      await mkdir(dir, { recursive: true })
      const written: string[] = []
      for (const file of files) {
        const target = join(dir, file.name)
        await writeFile(target, file.body, 'utf8')
        written.push(target)
      }

      const words = chapters.reduce((sum, draft) => sum + draft.words, 0)
      return {
        dir,
        files: written,
        report: [
          `已导出 ${written.length} 个文件到 ${dir}`,
          `正文 ${chapters.length} 章，共 ${words} 字。`,
          '',
          ...written.map((path) => `- ${path}`),
        ].join('\n'),
      }
    },
  }))
}
