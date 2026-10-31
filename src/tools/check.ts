/** `novel_check`: deterministic inspection without spending tokens. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { checkProseAgainstClock, resolveTimeline, windowAt } from '../domain/clock.ts'
import { checkContract, rank } from '../domain/contract.ts'
import { staleCards } from '../domain/cards.ts'
import { chapterRanges, describeCoverage, recordCoverage } from '../domain/records.ts'
import { checkRelations } from '../domain/relations.ts'
import { scanChapter } from '../domain/scan.ts'
import { staleRecords } from '../domain/staleness.ts'
import { STALE_AFTER, openThreads, staleThreads } from '../domain/threads.ts'
import type { Finding } from '../domain/types.ts'
import { auditLedger } from './ledger.ts'
import { formatFindings, tally, type ToolDeps } from './deps.ts'

/**
 * Register the check tool.
 *
 * Every check here is a pure function over text already on disk, so it costs no
 * tokens and can be run on every chapter after every revision.
 *
 * @param ctx - plugin context with the tool registry.
 * @param deps - store and resolved config.
 */
export function registerCheckTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'novel_check',
    description:
      '确定性体检，零 token。contract 检查某章正文是否兑现章纲；scan 检查复读、句式、套路词、对话占比、章末钩子；ledger 检查设定冲突；timeline 检查时间线（锚点矛盾、回忆里的日期对不对、正文写死的日期在不在这一章的时间窗内、「这几个月」有没有变成「这几年」）；records 报出哪些章正文没有留下地点/故事点/时间线的记录（「实时更新」靠这条：记录是人写的，它只负责说出哪里漏了）；cards 报出哪些章卡盖的是旧正文的版本（正文改过、梗概没跟上）；stale 把这件事扩到地点状态与人物阶段——凡是「从正文读出来的记录」，都对一遍它是第几版正文的读法；all 全量跑一遍（不给 number 则检查所有已写章节）。这些结论是启发式的，用来定位问题，不替代人判断。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['contract', 'scan', 'ledger', 'timeline', 'records', 'cards', 'stale', 'relations', 'threads', 'all'],
        description: '检查类型；threads 报「埋了超过 30 章还没收」的伏笔',
      },
      number: { type: 'number', description: '章号；all 时可省略，省略则检查全书' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          errors: { type: 'number' },
          warnings: { type: 'number' },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    async execute(args, exec) {
      const store = deps.storeFor(exec)
      const snapshot = await store.snapshot()
      const drafts = await store.allChapters()
      const findings: Finding[] = []

      if (args.action === 'ledger' || args.action === 'all') {
        findings.push(...auditLedger(snapshot.ledger, drafts.length))
      }

      if (args.action === 'all') {
        // Part of the full pass: a promise nobody remembers to keep is exactly
        // the kind of thing a full pass exists to surface.
        const last = snapshot.chapters.reduce((max, chapter) => Math.max(max, chapter.number), 0)
        findings.push(...staleThreads(snapshot.threads ?? (await store.threads()), last))
      }

      const targets = args.number !== undefined
        ? drafts.filter((item) => item.number === args.number)
        : drafts

      if (args.number !== undefined && targets.length === 0) {
        throw new Error(`第${args.number}章还没写，没有可检查的正文。`)
      }

      if (args.action === 'contract' || args.action === 'all') {
        for (const draft of targets) {
          const plan = snapshot.plans.find((item) => item.number === draft.number)
          if (!plan) {
            findings.push({
              code: 'contract/missing-plan',
              severity: 'warn',
              message: `第${draft.number}章有正文但没有章纲，无法核对`,
              evidence: '',
            })
            continue
          }
          findings.push(...checkContract(plan, draft.text, deps.config))
        }
      }

      if (args.action === 'scan' || args.action === 'all') {
        for (const draft of targets) {
          const others = drafts.filter((item) => item.number !== draft.number)
          findings.push(
            ...scanChapter(draft, others, deps.config).map((finding) => ({
              ...finding,
              message: `第${draft.number}章：${finding.message}`,
            })),
          )
        }
      }

      if (args.action === 'timeline' || args.action === 'all') {
        const highest = Math.max(
          drafts.length,
          ...snapshot.chapters.map((chapter) => chapter.number),
          ...snapshot.plans.map((plan) => plan.number),
          1,
        )
        const resolution = resolveTimeline(snapshot.timeline, highest)
        findings.push(...resolution.findings)
        const bookStart = windowAt(resolution, 0) ?? windowAt(resolution, 1)
        for (const draft of targets) {
          const window = windowAt(resolution, draft.number)
          if (!window) {
            if (snapshot.timeline.anchors.length === 0 && draft.number === 1) {
              findings.push({
                code: 'timeline/no-anchor',
                severity: 'info',
                message: '全书还没有任何日期锚点，时间线无法核对（在正文出现第一个具体时间时用 novel_timeline anchor 记一条）',
                evidence: '',
              })
            }
            continue
          }
          findings.push(
            ...checkProseAgainstClock(draft.text, window, bookStart).map((finding) => ({
              ...finding,
              message: `第${draft.number}章：${finding.message}`,
            })),
          )
        }
      }

      if (args.action === 'records') {
        const coverage = recordCoverage(snapshot)
        const described = describeCoverage(coverage)
        return {
          errors: 0,
          warnings: 0,
          report: described === ''
            ? '正文与记录对得上：每一章都有地点、故事点或时间线的痕迹。'
            : described,
        }
      }

      if (args.action === 'relations') {
        const found = checkRelations(snapshot.relations, snapshot.characters)
        return {
          errors: found.filter((item) => item.severity === 'error').length,
          warnings: found.filter((item) => item.severity === 'warn').length,
          report: found.length === 0
            ? `关系表没有冲突：${snapshot.relations.edges.length} 条关系，两端都认得出人。`
            : formatFindings(found),
        }
      }

      if (args.action === 'cards') {
        const stale = staleCards(snapshot)
        return {
          errors: 0,
          warnings: 0,
          report: stale.length === 0
            ? '章卡都对得上现在的正文。'
            : [
                `${stale.length} 张章卡盖的是旧正文的版本：`,
                ...stale.map(
                  (item) =>
                    `  第${item.number}章　卡写在第 ${item.cardRevision} 版，正文现在是第 ${item.revision} 版——故事梗概/关键事件/场景说的可能已经不是正文里的样子。`,
                ),
                '',
                '改法：读一遍正文，novel_outline action="card" 重写 story/events/scene（只改你给的字段）；或者如果你确认卡里写的仍然对，也照样重写一次把它盖成当前版本。',
              ].join('\n'),
        }
      }

      if (args.action === 'threads') {
        const threads = await store.threads()
        const last = snapshot.chapters.reduce((max, chapter) => Math.max(max, chapter.number), 0)
        if (threads.length === 0) {
          return {
            errors: 0,
            warnings: 0,
            report: [
              '这本书还没记过伏笔，所以查不出什么。',
              '埋的时候：novel_ledger action="plant" label="那封没拆的信" chapter=N quote="原文那一句"',
            ].join('\n'),
          }
        }
        const stale = staleThreads(threads, last)
        const open = openThreads(threads).length
        if (stale.length === 0) {
          return {
            errors: 0,
            warnings: 0,
            report: `伏笔 ${threads.length} 条，还欠着 ${open} 条，都在 ${STALE_AFTER} 章以内，没有拖太久。`,
          }
        }
        return {
          errors: 0,
          warnings: stale.length,
          report: [
            `还欠着 ${open} 条伏笔，其中 ${stale.length} 条超过 ${STALE_AFTER} 章没动：`,
            '',
            formatFindings(stale),
            '',
            '收掉：novel_ledger action="pay" id="t-0001" chapter=N',
            '不要了：novel_ledger action="drop" id="t-0001" value="为什么"',
            '一直挂着不是错，只是你要知道自己还欠着——读者记着的，你会忘。',
          ].join('\n'),
        }
      }

      if (args.action === 'stale') {
        const stale = staleRecords(snapshot)
        if (stale.records.length === 0) {
          return { errors: 0, warnings: 0, report: '章卡、地点状态、人物阶段都对得上现在的正文。' }
        }
        const byKind = { card: 0, place: 0, stage: 0 }
        for (const record of stale.records) byKind[record.kind] += 1
        return {
          errors: 0,
          warnings: 0,
          report: [
            `${stale.records.length} 条记录盖的是旧正文的版本（章卡 ${byKind.card}、地点 ${byKind.place}、人物阶段 ${byKind.stage}）：`,
            ...stale.records.map((record) => `  ${record.label}`),
            '',
            '这些记录现在都对得上「某个版本」的正文，不是对得上「现在」这一版——写下一章时它们会被当成事实喂进去。',
            '改法：读一遍改动后的那一章，用对应的工具重写一次（章卡 novel_outline action="card"、地点 novel_canon action="upsert_place"、阶段 novel_canon action="shift" / upsert_character 的 stages）。确认旧的仍然对，也就地重写一次把它盖成当前版本。',
          ].join('\n'),
        }
      }

      if (args.action === 'all') {
        const coverage = recordCoverage(snapshot)
        if (coverage.silent.length > 0) {
          findings.push({
            code: 'records/silent-chapters',
            severity: 'info',
            message: `${coverage.silent.length} 章正文没有留下地点/故事点/时间线记录（${chapterRanges(coverage.silent)}）`,
            evidence: 'novel_check action="records" 看具体该补哪些章。',
          })
        }
        const stale = staleCards(snapshot)
        if (stale.length > 0) {
          findings.push({
            code: 'cards/stale',
            severity: 'info',
            message: `${stale.length} 张章卡盖的是旧正文的版本（${chapterRanges(stale.map((item) => item.number))}）`,
            evidence: 'novel_check action="cards" 看具体哪几张、差了几版。',
          })
        }
        const drifted = staleRecords(snapshot)
        const nonCard = drifted.records.filter((record) => record.kind !== 'card')
        if (nonCard.length > 0) {
          findings.push({
            code: 'records/stale',
            severity: 'info',
            message: `${nonCard.length} 条地点/阶段记录盖的是旧正文的版本（${chapterRanges(drifted.chapters)}）`,
            evidence: 'novel_check action="stale" 看具体哪几条。',
          })
        }
      }

      const ordered = rank(findings)
      const counts = tally(ordered)
      const scope = args.number !== undefined ? `第${args.number}章` : '全书'

      return {
        errors: counts.errors,
        warnings: counts.warnings,
        report: ordered.length === 0
          ? `${scope}体检通过，没有发现问题。`
          : [
              `${scope}体检：${counts.errors} 个错误，${counts.warnings} 个警告，${counts.infos} 条提示。`,
              '',
              formatFindings(ordered),
            ].join('\n'),
      }
    },
  }))
}
