/** `novel_ledger`: record, query, and audit the fact ledger. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { activeEntries, checkLedgerWrite, formatFact } from '../domain/ledger.ts'
import { foldKey } from '../domain/text.ts'
import { describeThreads, dropThread, payThread, plantThread } from '../domain/threads.ts'
import type { Finding, LedgerEntry } from '../domain/types.ts'
import { formatFindings, type ToolDeps } from './deps.ts'

/** Structural audit of the whole ledger. */
export function auditLedger(entries: LedgerEntry[], writtenChapters: number): Finding[] {
  const findings: Finding[] = []
  const active = activeEntries(entries)
  const byKey = new Map<string, LedgerEntry[]>()

  for (const entry of active) {
    const key = `${foldKey(entry.subject)}::${foldKey(entry.predicate)}`
    const bucket = byKey.get(key)
    if (bucket) bucket.push(entry)
    else byKey.set(key, [entry])
  }

  for (const bucket of byKey.values()) {
    if (bucket.length < 2) continue
    const values = new Set(bucket.map((entry) => foldKey(entry.value)))
    if (values.size < 2) continue
    const first = bucket[0]
    findings.push({
      code: 'ledger/multi-active',
      severity: 'error',
      message: `${first?.subject}·${first?.predicate} 同时存在 ${bucket.length} 条互相冲突的有效设定`,
      evidence: bucket.map((entry) => formatFact(entry)).join('；'),
    })
  }

  const ids = new Map(entries.map((entry) => [entry.id, entry]))
  for (const entry of entries) {
    if (!entry.supersedes) continue
    const target = ids.get(entry.supersedes)
    if (!target) {
      findings.push({
        code: 'ledger/dangling-supersedes',
        severity: 'error',
        message: `${entry.id} 声称替换 ${entry.supersedes}，但那条不存在`,
        evidence: formatFact(entry),
      })
      continue
    }
    if (target.chapter > entry.chapter) {
      findings.push({
        code: 'ledger/time-reversal',
        severity: 'error',
        message: `${entry.id}（第${entry.chapter}章）替换了更晚的 ${target.id}（第${target.chapter}章）`,
        evidence: `${formatFact(target)} → ${formatFact(entry)}`,
      })
    }
  }

  for (const entry of active) {
    if (writtenChapters > 0 && entry.chapter > writtenChapters) {
      findings.push({
        code: 'ledger/future-chapter',
        severity: 'warn',
        message: `${entry.id} 写的是第${entry.chapter}章，但只写到第${writtenChapters}章`,
        evidence: formatFact(entry),
      })
    }
    if (entry.quote.trim() === '') {
      findings.push({
        code: 'ledger/no-quote',
        severity: 'info',
        message: `${entry.id} 没有原文依据，后面很难判断该信哪条`,
        evidence: formatFact(entry),
      })
    }
  }

  return findings
}

/**
 * Register the ledger tool.
 *
 * A contradicting fact is refused, not overwritten. Changing canon requires
 * naming the entry being replaced, which is what makes the change reviewable.
 *
 * @param ctx - plugin context with the tool registry.
 * @param deps - store and resolved config.
 */
export function registerLedgerTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'novel_ledger',
    description:
      '事实账本。record 记录一条确定的事实（subject 主体、predicate 属性、value 值、chapter 出现在第几章、quote 原文依据）；与已有设定冲突时会被拒绝，除非用 supersedes 指名替换哪一条；query 查某个主体的所有有效设定；check 全量体检。写完一章就把新设定记进来。plant/pay/drop/threads 管的是另一类账：欠读者的伏笔——第 38 章埋了一封信，第 200 章拆开，或者永远忘了。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['record', 'query', 'check', 'plant', 'pay', 'drop', 'threads'],
        description: 'record 记事实 / query 查事实 / check 体检 / plant 埋一条伏笔 / pay 收一条伏笔 / drop 放弃一条（不再提醒）/ threads 列出全部伏笔',
      },
      subject: { type: 'string', description: '主体：角色名、地点名，或「世界」' },
      predicate: { type: 'string', description: '属性，如「左眼颜色」「佩刀」「与主角的关系」' },
      value: { type: 'string', description: '具体的值' },
      chapter: { type: 'number', description: '这条设定出现在第几章；设定阶段用 0' },
      quote: { type: 'string', description: '原文依据，摘一句正文' },
      supersedes: { type: 'string', description: '要替换的旧条目 id，如 f-0003' },
      label: { type: 'string', description: 'plant 时：这一条伏笔是什么，一句话（如「那封没拆的信」）' },
      id: { type: 'string', description: 'pay 或 drop 时：伏笔 id，如 t-0003' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          id: { type: 'string' },
          count: { type: 'number' },
          conflicts: { type: 'array', items: { type: 'string' } },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    async execute(args, exec) {
      const store = deps.storeFor(exec)
      const entries = await store.ledger()

      if (args.action === 'plant') {
        const thread = await plantThread(store, {
          label: args.label ?? args.value ?? '',
          chapter: Number(args.chapter ?? 0),
          ...(args.quote === undefined ? {} : { quote: args.quote }),
          ...(args.predicate === undefined ? {} : { notes: args.predicate }),
        })
        return {
          action: args.action,
          id: thread.id,
          count: (await store.threads()).length,
          conflicts: [],
          report: `埋下 ${thread.id}：第${thread.planted}章「${thread.label}」。收的时候：novel_ledger action="pay" id="${thread.id}" chapter=N。`,
        }
      }

      if (args.action === 'pay') {
        const id = (args.id ?? '').trim()
        if (id === '') throw new Error('pay 需要 id：哪一条伏笔收掉了。')
        const thread = await payThread(store, id, Number(args.chapter ?? 0), args.value)
        return {
          action: args.action,
          id: thread.id,
          count: (await store.threads()).length,
          conflicts: [],
          report: `收掉 ${thread.id}「${thread.label}」：第${thread.planted}章埋，第${thread.paid}章收${thread.payoff === undefined ? '' : `（${thread.payoff}）`}。`,
        }
      }

      if (args.action === 'drop') {
        const id = (args.id ?? '').trim()
        if (id === '') throw new Error('drop 需要 id：放弃哪一条。')
        const thread = await dropThread(store, id, args.value)
        return {
          action: args.action,
          id: thread.id,
          count: (await store.threads()).length,
          conflicts: [],
          report: `放弃 ${thread.id}「${thread.label}」，以后不再提醒。这不是"收掉了"——它只是不再欠着了。`,
        }
      }

      if (args.action === 'threads') {
        const all = await store.threads()
        const last = (await store.chapters()).reduce((max, chapter) => Math.max(max, chapter.number), 0)
        return {
          action: args.action,
          id: '',
          count: all.length,
          conflicts: [],
          report: describeThreads(all, last),
        }
      }

      if (args.action === 'record') {
        const chapter = args.chapter
        if (chapter === undefined) throw new Error('record 需要 chapter（设定阶段用 0）。')
        const check = checkLedgerWrite(entries, {
          subject: args.subject ?? '',
          predicate: args.predicate ?? '',
          value: args.value ?? '',
          chapter,
          quote: args.quote,
          supersedes: args.supersedes,
        })

        if (check.kind === 'invalid') throw new Error(check.message)
        if (check.kind === 'conflict') {
          throw new Error([check.message, '', check.hint].join('\n'))
        }
        if (check.kind === 'duplicate') {
          return {
            action: 'record',
            id: check.existing.id,
            count: activeEntries(entries).length,
            conflicts: [],
            report: `这条已经记过了：${formatFact(check.existing)}。没有重复写入。`,
          }
        }

        const record = await store.appendLedger({
          subject: args.subject?.trim() ?? '',
          predicate: args.predicate?.trim() ?? '',
          value: args.value?.trim() ?? '',
          chapter,
          quote: args.quote?.trim() ?? '',
          supersedes: args.supersedes?.trim() || null,
        })
        return {
          action: 'record',
          id: record.id,
          count: activeEntries([...entries, record]).length,
          conflicts: [],
          report: `已记账 ${formatFact(record)}${record.supersedes ? `（替换 ${record.supersedes}）` : ''}`,
        }
      }

      if (args.action === 'query') {
        const subject = args.subject?.trim()
        const pool = subject
          ? activeEntries(entries).filter((entry) => foldKey(entry.subject) === foldKey(subject))
          : activeEntries(entries)
        return {
          action: 'query',
          id: '',
          count: pool.length,
          conflicts: [],
          report: pool.length === 0
            ? `账本里没有${subject ? `「${subject}」的` : ''}有效设定。`
            : [`有效设定 ${pool.length} 条：`, ...pool.map((entry) => `- ${formatFact(entry)}`)].join('\n'),
        }
      }

      const written = (await store.chapters()).length
      const findings = auditLedger(entries, written)
      const errors = findings.filter((item) => item.severity === 'error')
      return {
        action: 'check',
        id: '',
        count: activeEntries(entries).length,
        conflicts: errors.map((item) => item.message),
        report: [
          `账本 ${entries.length} 条，其中有效 ${activeEntries(entries).length} 条，已废弃 ${entries.length - activeEntries(entries).length} 条。`,
          findings.length === 0 ? '体检通过，没有发现冲突。' : '',
          formatFindings(findings),
        ].filter(Boolean).join('\n'),
      }
    },
  }))
}
