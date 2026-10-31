/**
 * `novel_pending`: the review queue between what a subagent read and what the
 * book believes.
 *
 * The keeper's proposals used to live only in the chat reply. Filing one meant
 * retyping it into one of five tools, which is enough friction that in practice
 * nobody files anything, and the book silently grows without its records — the
 * exact failure the records exist to prevent.
 *
 * Writing automatically is the other extreme and it is worse: a character card
 * is the author's judgement about a person, and letting a reading overwrite it
 * after every chapter turns judgement into a guess. So the queue sits between
 * the two — proposal in, decision by a person, one deterministic write after.
 *
 * Approval is deliberately batchable. Ten items reviewed one at a time is the
 * same friction that made the old flow useless; `all=true` is the common path,
 * and `ids` exists for the ones that need a second look.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { applyPendingBatch, type Applied } from '../domain/approve.ts'
import {
  PENDING_KEEP,
  clearPending,
  describePending,
  readPending,
  removePending,
  type PendingItem,
} from '../domain/pending.ts'
import type { ToolDeps } from './deps.ts'

/**
 * Register the review-queue tool.
 *
 * @param ctx - plugin context with the tool registry.
 * @param deps - per-session store resolution and config.
 */
export function registerPendingTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'novel_pending',
    description:
      '子智能体读完一章之后提出的「该记点什么」，在这里等你点头。keeper 派发时自动入队，不自动写。list 看全部（带原文引用）；approve 批准并写进书里（all=true 全收，或 ids="p-0003,p-0004" 只收那几条）；reject 丢掉（all=true 清空，或 ids）。写入是按类别确定的：事实进账本、地点加一个状态、人物加一段经历、日期钉到时间线、章卡补梗概、伏笔记成一条欠账（同名的不会重复记）。批准是不可撤销的，但每一处写入都留着原文引用，能追。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'approve', 'reject'],
        description: 'list 只读；approve 写进书里；reject 丢掉。',
      },
      all: { type: 'boolean', description: 'true 表示整队：approve 全收、reject 全清。' },
      ids: {
        type: 'string',
        description: '只处理这几条，逗号分隔，例如 "p-0003,p-0007"。与 all 二选一。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'string' },
          waiting: { type: 'number' },
          applied: { type: 'number' },
          skipped: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    async execute(args, exec) {
      const store = deps.storeFor(exec)
      if (!(await store.exists())) {
        throw new Error(`这里还没有书：${store.root} 里没有 project.json。先新建或导入一本。`)
      }
      const items = await readPending(store.root)

      if (args.action === 'list') {
        return {
          report: describeQueue(items, store.root),
          waiting: items.length,
          applied: 0,
          skipped: 0,
        }
      }

      const picked = args.all === true ? items : selectById(items, args.ids)
      if (picked.length === 0) {
        return {
          report:
            items.length === 0
              ? '队列是空的。写完一章之后派 novel_dispatch action="keeper"，它会把建议放进这里。'
              : `没有选中任何一条。队列里有 ${items.length} 条；用 all=true 全收，或 ids="p-0003" 指定。`,
          waiting: items.length,
          applied: 0,
          skipped: 0,
        }
      }

      if (args.action === 'reject') {
        await removePending(store.root, picked.map((item) => item.id))
        const left = items.length - picked.length
        return {
          report: [`丢掉 ${picked.length} 条，队列还剩 ${left} 条。`, '', '书里什么都没有改。'].join('\n'),
          waiting: left,
          applied: 0,
          skipped: picked.length,
        }
      }

      const result = await applyPendingBatch(store, picked)
      // Approved items leave the queue; the ones that failed stay, so a bad date
      // can be fixed instead of silently disappearing.
      const done = result.applied.map((item) => item.id)
      if (done.length > 0) await removePending(store.root, done)
      const waiting = items.length - done.length
      return {
        report: describeApprove(result.applied, result.skipped, waiting),
        waiting,
        applied: result.applied.length,
        skipped: result.skipped.length,
      }
    },
  }))
}

/** Resolve `ids="p-1,p-2"` against the queue. */
function selectById(items: readonly PendingItem[], raw: string | undefined): PendingItem[] {
  const wanted = new Set(
    String(raw ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== ''),
  )
  if (wanted.size === 0) return []
  return items.filter((item) => wanted.has(item.id))
}

/**
 * The list view: grouped by chapter, with the quote that justifies each line.
 *
 * Grouping by chapter is not cosmetic — the author approves chapter by chapter,
 * because that is the unit they just wrote and can still remember.
 *
 * @param items - the queue.
 * @param root - project directory, for the footer.
 * @returns the report.
 */
function describeQueue(items: readonly PendingItem[], root: string): string {
  if (items.length === 0) {
    return [
      '队列是空的。',
      '写完一章之后派 novel_dispatch action="keeper"，它读这一章、提出该记的东西，放进这里等你点头。',
    ].join('\n')
  }
  const byChapter = new Map<number, PendingItem[]>()
  for (const item of items) {
    const list = byChapter.get(item.sourceChapter) ?? []
    list.push(item)
    byChapter.set(item.sourceChapter, list)
  }
  const lines = [`待审 ${items.length} 条（最多留 ${PENDING_KEEP} 条，更早的会被挤掉）。`, '']
  for (const chapter of [...byChapter.keys()].sort((a, b) => a - b)) {
    lines.push(`第${chapter}章：`)
    for (const item of byChapter.get(chapter)!) {
      lines.push(`  ${item.id}  ${describePending(item)}`)
    }
    lines.push('')
  }
  lines.push(
    '全收：novel_pending action="approve" all=true',
    '只收几条：novel_pending action="approve" ids="p-0003,p-0004"',
    '不收：novel_pending action="reject" ids="…"（全丢用 all=true）',
    '',
    `队列在 ${root}/pending/queue.json，可以当普通文件看。`,
  )
  return lines.join('\n')
}

/**
 * The approval report: one line per write, then what is left.
 *
 * @param applied - what landed.
 * @param skipped - what did not, with the reason.
 * @param waiting - how many are still queued.
 * @returns the report.
 */
function describeApprove(applied: readonly Applied[], skipped: readonly { line: string }[], waiting: number): string {
  const lines: string[] = [`收下 ${applied.length} 条，写进书里了。`]
  const created = applied.filter((item) => item.created).length
  if (created > 0) lines.push(`其中 ${created} 条是新建的（之前书里没有）。`)
  lines.push('', ...applied.map((item) => `  ✓ ${item.line}`))
  if (skipped.length > 0) {
    lines.push('', `有 ${skipped.length} 条没写进去，还留在队列里：`, ...skipped.map((item) => `  ✗ ${item.line}`))
  }
  lines.push(
    '',
    waiting === 0
      ? '队列空了。'
      : `队列还剩 ${waiting} 条：novel_pending action="list"`,
  )
  return lines.join('\n')
}
