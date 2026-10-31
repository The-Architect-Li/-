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
import { join } from 'node:path'
import { listHistory, parseTarget, readHistory } from '../domain/history.ts'
import { writeSkill } from '../domain/skills.ts'
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
      '给整本书留一份副本，或者把书退回某一份副本；也管单份文件的历史。list 看有哪些整书副本；make 现在打一份（只留最近 20 份，副本放在 dsh 的状态目录下，不在书里）；restore 回到某一份整书副本——恢复前会先自动存一份当下的状态，所以恢复本身也能撤销；history 看某一份文件的历史版本（target="chapter:7" / "canon:characters" / "skill:开篇钩子"）；revert 把那一个文件退回某一版，其余文件不动。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'make', 'restore', 'history', 'revert'],
        description: 'list 整书副本列表 / make 备份 / restore 回到副本 / history 单文件历史 / revert 单文件回退',
      },
      name: {
        type: 'string',
        description: 'restore 用：整书副本的文件名（action="list" 里有）',
      },
      target: {
        type: 'string',
        description: 'history / revert 用：要动哪一份，写成「类别:名字」，例如 chapter:7、canon:characters、canon:world、canon:places、skill:开篇钩子',
      },
      rev: {
        type: 'string',
        description: 'revert 用：历史版本号（action="history" 里列出来的那个）',
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
          history: { type: 'array', items: { type: 'string' } },
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

      if (args.action === 'history') {
        const { kind, name } = parseTarget(args.target ?? '')
        const entries = await listHistory(store.root, kind, name)
        const lines =
          entries.length === 0
            ? [`${kind}:${name} 还没有历史版本：它只被写过一次，或者每次写的内容都一样。`, `历史存在书里：${join(store.root, '.history')}。`]
            : [
                `${kind}:${name} 的历史（最新在前，共 ${entries.length} 版）：`,
                '',
                ...entries.map((entry) => `- ${entry.rev}｜${entry.bytes} 字节｜${entry.at}`),
                '',
                '退回去：novel_backup action="revert" target=… rev=…',
              ]
        return {
          backup: '',
          backups: existing.map((entry) => entry.name),
          pruned: [],
          written: [],
          extra: [],
          history: entries.map((entry) => entry.rev),
          report: lines.join('\n'),
        }
      }

      if (args.action === 'revert') {
        const { kind, name } = parseTarget(args.target ?? '')
        const entries = await listHistory(store.root, kind, name)
        const rev = (args.rev ?? '').trim()
        if (rev === '') {
          const newest = entries[0]
          if (newest === undefined) throw new Error(`${kind}:${name} 没有历史版本，退不了。`)
          throw new Error(`revert 要说回到哪一版。最新的是 ${newest.rev}；全部用 action="history"。`)
        }
        const text = await readHistory(store.root, kind, name, rev)
        if (kind === 'chapter') {
          await store.restoreChapterText(Number(name), text)
        } else if (kind === 'canon') {
          if (!['characters', 'world', 'places', 'relations'].includes(name)) {
            throw new Error(`canon 只认 characters / world / places / relations，不认「${name}」。`)
          }
          await store.writeCanonRaw(name as 'characters' | 'world' | 'places' | 'relations', text)
        } else {
          await writeSkill(store.root, name, text)
        }
        return {
          backup: '',
          backups: existing.map((entry) => entry.name),
          pruned: [],
          written: [name],
          extra: [],
          history: (await listHistory(store.root, kind, name)).map((entry) => entry.rev),
          report: [
            `已经把 ${kind}:${name} 退回 ${rev}（${text.length} 字）。`,
            '退回前的这一版也进了历史，所以退错了还能再退回来。',
            '整书备份没有动；要连别的文件一起回，用 action="restore"。',
          ].join('\n'),
        }
      }

      if (args.action === 'list') {
        const lines =
          existing.length === 0
            ? [`这本书还没有备份。用 novel_backup action="make" 打一份。`, `备份会放在 ${dir}。`]
            : [
                `共 ${existing.length} 份备份（最新的在上面），在 ${dir}：`,
                '',
                ...existing.map((entry) => `- ${describeBackup(entry)}（${entry.name}）`),
              ]
        return { backup: '', backups: existing.map((entry) => entry.name), pruned: [], written: [], extra: [], history: [], report: lines.join('\n') }
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
          history: [],
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
        history: [],
        report: restoreReport(result).join('\n'),
      }
    },
  }))
}
