/**
 * `novel_timeline`: the book's clock, written down where the prose said it.
 *
 * The tool stores only statements the manuscript made — an anchor date, a
 * span ("过了两三个月"), a recall with a date on it — and reads back computed
 * dates. Nothing here invents a date: if the book never says when it is, `at`
 * answers "还不知道" instead of guessing, because a guessed date is exactly the
 * kind of thing a later chapter will contradict.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  ClockFormatError,
  describeWindow,
  parseDuration,
  parseWhen,
  resolveTimeline,
  windowAt,
} from '../domain/clock.ts'
import type { TimelineAnchor, TimelineFile, TimelineRecall, TimelineSpan } from '../domain/types.ts'
import { setBookStart } from '../domain/book-start.ts'
import { buildSpine } from '../domain/spine.ts'
import { scanProseTimes } from '../domain/prose-time.ts'
import { addAnchor, adoptClock } from '../domain/timeline-edit.ts'
import type { ToolDeps } from './deps.ts'

/** Next free id for one list, keeping anchors/spans/recalls in separate namespaces. */
function nextId(prefix: string, ids: readonly string[]): string {
  const highest = ids.reduce((max, id) => {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id)
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  return `${prefix}-${String(highest + 1).padStart(3, '0')}`
}

/**
 * The highest chapter the clock should resolve to.
 *
 * @param file - the stored clock.
 * @param fallback - fallback when the clock is empty.
 * @returns the highest chapter mentioned by any entry.
 */
function horizonOf(file: TimelineFile, fallback: number): number {
  const chapters = [
    ...file.anchors.map((anchor) => anchor.chapter),
    ...file.spans.map((span) => Math.max(span.fromChapter, span.toChapter)),
    ...(file.recalls ?? []).map((recall) => Math.max(recall.chapter, recall.eventChapter ?? 0)),
  ]
  return Math.max(fallback, ...chapters)
}

/**
 * Register the timeline tool.
 *
 * @param ctx - plugin context with the tool registry.
 * @param deps - store and resolved config.
 */
export function registerTimelineTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'novel_timeline',
    description:
      '故事时间线。anchor 记「第几章是什么时候」（2019、2019-03、2019-03-07 三种精度都行）；span 记「从第几章到第几章过了多久」（原文照抄，例如「过了两三个月」，会算成区间）；recall 记「第几章有人回忆第几章的事，说成什么日期」，用来核对回忆有没有记错月份或年份；at 查某一章的故事时间；scan 只读正文、报出里面写了哪些日期（不写盘）；adopt 把 scan 报的那些日期真写进时间线；check 体检；list 列出全部；start 给全书钉一个起点（时间轴从那一天开始，每十二个月一个点），不钉就退回到第一个锚点。正文里每出现一次时间推进就记一次，别事后补。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['anchor', 'span', 'recall', 'at', 'scan', 'adopt', 'check', 'list', 'start'],
        description: 'anchor 时间锚点 / span 时间跨度 / recall 回忆 / at 查某章时间 / scan 读正文找日期（只报告）/ adopt 把读到的日期写进时间线 / check 体检 / list 列表 / start 全书起点',
      },
      chapter: { type: 'number', description: 'anchor、recall 发生的章号；at 是查询章号；scan、adopt 指定某一章（不给就整本）' },
      when: { type: 'string', description: 'anchor 用：2019 / 2019-03 / 2019-03-07；start 用：全书起点，同样的格式，传空字符串清掉' },
      label: { type: 'string', description: 'anchor 用：这个时间点发生了什么，一句话' },
      from: { type: 'number', description: 'span 用：从第几章开始算' },
      to: { type: 'number', description: 'span 用：到第几章时已经过去了这么久' },
      text: { type: 'string', description: 'span、recall 用：原文里那句话' },
      about: { type: 'string', description: 'recall 用：回忆的是什么事' },
      eventChapter: { type: 'number', description: 'recall 用：那件事发生在第几章' },
      claimed: { type: 'string', description: 'recall 用：回忆里说的日期，2019 / 2019-02 / 2019-02-03' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          at: { type: 'string' },
          findings: { type: 'number' },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    async execute(args, exec) {
      const store = deps.storeFor(exec)
      const file = await store.timeline()
      const horizon = horizonOf(file, Math.max(1, Math.trunc(args.chapter ?? args.to ?? 1)))

      if (args.action === 'anchor') {
        const chapter = Math.max(0, Math.trunc(args.chapter ?? 0))
        const when = args.when?.trim() ?? ''
        // One write path for every road to the clock (v0.23): a person typing
        // an anchor, the scanner reading prose, the importer seeding a whole
        // book. The tool only decorates the result.
        let anchor: TimelineAnchor
        try {
          anchor = await addAnchor(store, { chapter, when, label: args.label?.trim() ?? '' })
        } catch (error) {
          throw new Error((error as ClockFormatError).message)
        }
        const next = await store.timeline()
        const resolution = resolveTimeline(next, horizonOf(next, horizon))
        const window = windowAt(resolution, chapter)
        return {
          action: args.action,
          at: window ? describeWindow(window) : '',
          findings: resolution.findings.length,
          report: `第 ${chapter} 章的时间是 ${anchor.when}。${resolution.findings.length > 0 ? `\n警告 ${resolution.findings.length} 条：\n${resolution.findings.map((finding) => `- ${finding.message}`).join('\n')}` : ''}`,
        }
      }

      if (args.action === 'scan' || args.action === 'adopt') {
        const chapter = Math.max(0, Math.trunc(args.chapter ?? 0))
        const targets = chapter > 0 ? [chapter] : (await store.allChapters()).map((draft) => draft.number)
        if (targets.length === 0) throw new Error('这本书还没有正文可读。novel_chapter action="write" 写过再来。')
        const lines: string[] = []
        const written = { anchors: 0, spans: 0, start: '' }
        for (const number of [...targets].sort((a, b) => a - b)) {
          const draft = await store.chapter(number)
          if (draft === undefined) continue
          if (args.action === 'scan') {
            const mentions = scanProseTimes(draft.text)
            if (mentions.length === 0) continue
            lines.push(
              `第${number}章：${mentions
                .map((item) =>
                  item.kind === 'absolute' ? item.text : `${item.text}（${item.days?.min}–${item.days?.max} 天）`,
                )
                .join('、')}`,
            )
            continue
          }
          const run = await adoptClock(store, number, draft.text)
          written.anchors += run.anchors.length
          written.spans += run.spans.length
          if (written.start === '' && run.start !== undefined) written.start = run.start
          for (const anchor of run.anchors) lines.push(`第${number}章 → ${anchor.when}（正文里写的）`)
          for (const conflict of run.conflicts) lines.push(conflict)
          for (const skipped of run.skipped) lines.push(skipped)
        }
        if (args.action === 'scan') {
          return {
            action: args.action,
            chapters: targets.length,
            report: [
              lines.length === 0
                ? '这些正文里没有任何明确的日期。季节和「多日后」不算——猜一个日期，后面会撞车。'
                : `扫到 ${lines.length} 章提到日期，还没写进时间线：`,
              ...lines,
              '',
              '要写进去就 action="adopt"（同一份读数，只写你点头的这些）。',
            ].join('\n'),
          }
        }
        return {
          action: args.action,
          chapters: targets.length,
          report: [
            written.anchors + written.spans === 0
              ? '没有可以写进时间线的日期。'
              : `写进时间线：${written.anchors} 个锚点、${written.spans} 段跨度${written.start === '' ? '' : `，起点定在 ${written.start}`}。`,
            ...lines,
          ].join('\n'),
        }
      }

      if (args.action === 'span') {
        const from = Math.trunc(args.from ?? args.chapter ?? 0)
        const to = Math.trunc(args.to ?? 0)
        if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || from < 1) {
          throw new Error('span 需要 from 和 to，to 不能小于 from。')
        }
        const text = args.text?.trim() ?? ''
        const days = parseDuration(text)
        if (!days) {
          throw new Error(`从「${text}」里读不出时长。把原文那句连着数字一起贴进来，例如「过了两三个月」。`)
        }
        const span: TimelineSpan = { id: nextId('ts', file.spans.map((item) => item.id)), fromChapter: from, toChapter: to, days, text }
        const next = await store.writeTimeline({ ...file, spans: [...file.spans, span] })
        const resolution = resolveTimeline(next, horizonOf(next, to))
        const window = windowAt(resolution, to)
        return {
          action: args.action,
          at: window ? describeWindow(window) : '',
          findings: resolution.findings.length,
          report: [
            `已记下：第 ${from} 章到第 ${to} 章之间过去了 ${days.min === days.max ? `${days.min}` : `${days.min}–${days.max}`} 天（「${text}」）。`,
            window ? `第 ${to} 章的故事时间约为 ${describeWindow(window)}。` : '第 1 章还没有锚点，先记 anchor 才能算出具体日期。',
          ].join('\n'),
        }
      }

      if (args.action === 'recall') {
        const chapter = Math.max(1, Math.trunc(args.chapter ?? 0))
        const about = args.about?.trim()
        if (!about) throw new Error('recall 需要 about，写清回忆的是什么事。')
        const claimed = args.claimed?.trim() ?? ''
        try {
          parseWhen(claimed)
        } catch (error) {
          throw new Error((error as ClockFormatError).message)
        }
        const eventChapter = args.eventChapter === undefined ? null : Math.max(1, Math.trunc(args.eventChapter))
        const recall: TimelineRecall = {
          id: nextId('tr', (file.recalls ?? []).map((item) => item.id)),
          chapter,
          about,
          eventChapter,
          claimed,
          text: args.text?.trim() ?? '',
        }
        const next = await store.writeTimeline({ ...file, recalls: [...(file.recalls ?? []), recall] })
        const resolution = resolveTimeline(next, horizonOf(next, chapter))
        const mine = resolution.findings.filter((finding) => finding.code.startsWith('timeline/recall'))
        return {
          action: args.action,
          at: '',
          findings: mine.length,
          report: mine.length === 0
            ? `已记下第 ${chapter} 章对「${about}」的回忆（说的是 ${claimed}），与时间线不矛盾。`
            : [`已记下第 ${chapter} 章对「${about}」的回忆，但有问题：`, ...mine.map((finding) => `- ${finding.severity === 'error' ? '错误' : '提醒'}：${finding.message}`)].join('\n'),
        }
      }

      if (args.action === 'at') {
        const chapter = Math.max(1, Math.trunc(args.chapter ?? 1))
        const resolution = resolveTimeline(file, horizonOf(file, horizon))
        const window = windowAt(resolution, chapter)
        if (!window) {
          return { action: args.action, at: '', findings: 0, report: `第 ${chapter} 章的故事时间还不知道：全书还没有任何日期锚点。` }
        }
        const anchored = resolution.byChapter.get(chapter)?.anchored ?? false
        return {
          action: args.action,
          at: describeWindow(window),
          findings: 0,
          report: `第 ${chapter} 章的故事时间：${describeWindow(window)}${anchored ? '（有锚点）' : '（由「过了多久」累加得到）'}。`,
        }
      }

      if (args.action === 'start') {
        const when = args.when?.trim() ?? ''
        const pinned = await setBookStart(store, when)
        const snapshot = await store.snapshot()
        const spine = buildSpine(snapshot)
        return {
          action: args.action,
          at: pinned ?? '',
          findings: 0,
          report: pinned === undefined
            ? ['起点清掉了，时间轴改从第一个锚点开始。', spine.report].join('\n')
            : [`起点定在 ${pinned}：时间轴从这里开始，每十二个月一个点。`, spine.report].join('\n'),
        }
      }

      if (args.action === 'check') {
        const resolution = resolveTimeline(file, horizonOf(file, horizon))
        return {
          action: args.action,
          at: '',
          findings: resolution.findings.length,
          report: resolution.findings.length === 0
            ? '时间线没有矛盾。'
            : [`时间线有 ${resolution.findings.length} 处问题：`, ...resolution.findings.map((finding) => `- [${finding.severity}] ${finding.message}\n  证据：${finding.evidence}`)].join('\n'),
        }
      }

      const resolution = resolveTimeline(file, horizonOf(file, horizon))
      return {
        action: 'list',
        at: '',
        findings: resolution.findings.length,
        report: [
          `锚点（${file.anchors.length}）：`,
          ...file.anchors
            .slice()
            .sort((a, b) => a.chapter - b.chapter)
            .map((anchor) => `- 第 ${anchor.chapter} 章：${anchor.when}${anchor.label ? ` ${anchor.label}` : ''}`),
          '',
          `跨度（${file.spans.length}）：`,
          ...file.spans
            .slice()
            .sort((a, b) => a.toChapter - b.toChapter)
            .map((span) => `- 第 ${span.fromChapter} → ${span.toChapter} 章：${span.days.min === span.days.max ? `${span.days.min}` : `${span.days.min}–${span.days.max}`} 天（${span.text}）`),
          '',
          `回忆（${(file.recalls ?? []).length}）：`,
          ...(file.recalls ?? []).map((recall) => `- 第 ${recall.chapter} 章回忆${recall.eventChapter === null ? '' : `第 ${recall.eventChapter} 章的`}「${recall.about}」，说成 ${recall.claimed}`),
          '',
          `按章对照（前 ${Math.min(horizon, 12)} 章）：`,
          ...Array.from({ length: Math.min(horizon, 12) }, (_, index) => index + 1).map((chapter) => {
            const window = windowAt(resolution, chapter)
            return window ? `- 第 ${chapter} 章：${describeWindow(window)}` : `- 第 ${chapter} 章：？（还没有锚点）`
          }),
        ].join('\n'),
      }
    },
  }))
}
