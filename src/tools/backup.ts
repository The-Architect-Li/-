/** `novel_backup`: keep a copy of the book, and go back to one. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  backupHome,
  describeBackup,
  listBackups,
  packageBook,
  restoreBook,
  type BackupEntry,
} from '../domain/backup.ts'
import type { ToolDeps } from './deps.ts'

/**
 * Turn a restore into the lines an author needs to hear.
 *
 * @param result - what the restore did.
 * @returns the report body.
 */
function restoreReport(result: Awaited<ReturnType<typeof restoreBook>>): string[] {
  const lines = [
    `已经回到 ${result.name}。`,
    `写了 ${result.written.length} 个文件，${result.unchanged.length} 个本来就一样。`,
  ]
  if (result.safety !== undefined) lines.push(`恢复前那份先存成了 ${result.safety.name}，所以要退回去还有一次机会。`)
  if (result.extra.length > 0) {
    lines.push('', `这 ${result.extra.length} 个文件是那份备份里没有的，没有删，留着你看看要不要：`)
    for (const path of result.extra.slice(0, 12)) lines.push(`- ${path}`)
    if (result.extra.length > 12) lines.push(`- ……还有 ${result.extra.length - 12} 个`)
  }
  lines.push('', '书的结构变了的话（比如恢复了更早的章纲），再跑一次 novel_check action="all"。')
  return lines
}

/**
 * Register the backup tool.
 *
 * @param ctx - plugin context with the tool registry.
 * @param deps - store and resolved config.
 */
export function registerBackupTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'novel_backup',
    description:
      '给整本书留一份副本，或者把书退回某一份副本。list 看有哪些副本（时间、文件数、大小）；make 现在打一份（只留最近 20 份，副本放在 dsh 的状态目录下，不在书里）；restore 回到某一份——恢复前会先自动存一份当下的状态（pre-restore-），所以恢复本身也能撤销；备份里没有的文件不会被删，只在报告里列出来。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'make', 'restore'],
        description: 'list 列表 / make 现在备份 / restore 回到某一份',
      },
      name: {
        type: 'string',
        description: 'restore 用：副本的文件名（novel_backup action="list" 里有）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          backup: { type: 'string' },
          backups: { type: 'array', items: { type: 'string' } },
          pruned: { type: 'array', items: { type: 'string' } },
          written: { type: 'array', items: { type: 'string' } },
          extra: { type: 'array', items: { type: 'string' } },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    async execute(args, exec): Promise<Record<string, unknown>> {
      const store = deps.storeFor(exec)
      if (!(await store.exists())) throw new Error(`这里还不是一本书：${store.root}。`)

      const dir = backupHome(store.root)
      const existing: BackupEntry[] = await listBackups(store.root)

      if (args.action === 'list') {
        const lines =
          existing.length === 0
            ? [`这本书还没有备份。用 novel_backup action="make" 打一份。`, `备份会放在 ${dir}。`]
            : [
                `共 ${existing.length} 份备份（最新的在上面），在 ${dir}：`,
                '',
                ...existing.map((entry) => `- ${describeBackup(entry)}（${entry.name}）`),
              ]
        return { backup: '', backups: existing.map((entry) => entry.name), pruned: [], written: [], extra: [], report: lines.join('\n') }
      }

      if (args.action === 'make') {
        const made = await packageBook(store.root)
        const lines = [
          `备份好了：${made.entry.name}`,
          describeBackup(made.entry),
          `放在 ${dir}（不在书里——书被别人搬走或删掉，这份还在）。`,
        ]
        if (made.pruned.length > 0) lines.push(`只留最近 20 份，删掉了：${made.pruned.join('、')}`)
        return {
          backup: made.entry.name,
          backups: (await listBackups(store.root)).map((entry) => entry.name),
          pruned: made.pruned,
          written: [],
          extra: [],
          report: lines.join('\n'),
        }
      }

      const name = (args.name ?? '').trim()
      if (name === '') {
        const newest = existing[0]
        if (newest === undefined) throw new Error('这本书还没有备份，先 novel_backup action="make" 打一份。')
        throw new Error(`restore 要说回到哪一份。最新的那份是 ${newest.name}；全部列表用 action="list"。`)
      }
      const result = await restoreBook(store.root, name)
      return {
        backup: result.name,
        backups: (await listBackups(store.root)).map((entry) => entry.name),
        pruned: [],
        written: result.written,
        extra: result.extra,
        report: restoreReport(result).join('\n'),
      }
    },
  }))
}
