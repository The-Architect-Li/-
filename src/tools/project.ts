/** `novel_project`: create, inspect, and advance the project. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { evaluateAdvance, nextPhase, requirementsFor } from '../domain/phase.ts'
import { countChars } from '../domain/text.ts'
import type { ToolDeps } from './deps.ts'

/**
 * Register the project lifecycle tool.
 *
 * @param ctx - plugin context with the tool registry.
 * @param deps - store and resolved config.
 */
export function registerProjectTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'novel_project',
    description:
      '长篇小说的项目入口。init 建立项目目录；status 汇报当前阶段与卡点；premise 写入一句话前提；advance 推进到下一阶段（不够条件会被拒绝并列出缺什么）。任何写作开始前先调用 status。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['init', 'status', 'premise', 'advance'],
        description: 'init 初始化 / status 查看状态 / premise 写前提 / advance 推进阶段',
      },
      title: { type: 'string', description: 'init 时的书名' },
      targetWords: { type: 'number', description: 'init 时的目标总字数，默认 800000' },
      premise: { type: 'string', description: 'premise 时的一句话前提：主角是谁、想要什么、被什么阻拦' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          phase: { type: 'string' },
          title: { type: 'string' },
          next: { type: 'string' },
          blockers: { type: 'array', items: { type: 'string' } },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    async execute(args) {
      if (args.action === 'init') {
        const title = args.title?.trim() || '未命名'
        const project = await deps.store.init(title, args.targetWords ?? 800000)
        return {
          phase: project.phase,
          title: project.title,
          next: 'canon',
          blockers: [],
          report: [
            `已创建项目《${project.title}》于 ${deps.store.root}`,
            `阶段：${project.phase}`,
            '',
            '接下来：用 novel_project action="premise" 写一句话前提（主角/欲望/阻力），再 advance 进入 canon。',
          ].join('\n'),
        }
      }

      if (args.action === 'premise') {
        const project = await deps.store.readProject()
        const premise = args.premise?.trim()
        if (!premise) {
          throw new Error('premise 不能为空。')
        }
        await deps.store.writeProject({ ...project, premise })
        const length = countChars(premise)
        const ok = length >= deps.config.premiseMinChars
        return {
          phase: project.phase,
          title: project.title,
          next: 'canon',
          blockers: ok ? [] : [`前提至少 ${deps.config.premiseMinChars} 字（当前 ${length} 字）`],
          report: [
            `已写入前提（${length} 字）。`,
            ok
              ? '字数达标，可以 advance 进入 canon 阶段。'
              : `还差 ${deps.config.premiseMinChars - length} 字。前提要包含：主角是谁、他想要什么、什么在阻挡他。`,
          ].join('\n'),
        }
      }

      const snapshot = await deps.store.snapshot()

      if (args.action === 'advance') {
        const result = evaluateAdvance(snapshot, deps.config)
        if (result.done) {
          return {
            phase: snapshot.project.phase,
            title: snapshot.project.title,
            next: '',
            blockers: [],
            report: '已经是最后一个阶段。',
          }
        }
        if (!result.ok || !result.next) {
          return {
            phase: snapshot.project.phase,
            title: snapshot.project.title,
            next: result.next ?? '',
            blockers: result.blockers,
            report: [
              `不能进入「${result.next}」阶段，还缺：`,
              ...result.blockers.map((item) => `- ${item}`),
            ].join('\n'),
          }
        }
        await deps.store.writeProject({ ...snapshot.project, phase: result.next })
        const upcoming = nextPhase(result.next)
        return {
          phase: result.next,
          title: snapshot.project.title,
          next: upcoming ?? '',
          blockers: [],
          report: [
            `已进入「${result.next}」阶段。`,
            upcoming ? describeNext(upcoming, snapshot, deps) : '',
          ].filter(Boolean).join('\n'),
        }
      }

      const upcoming = nextPhase(snapshot.project.phase)
      const requirements = upcoming ? requirementsFor(upcoming, snapshot, deps.config) : []
      const written = snapshot.chapters.length
      return {
        phase: snapshot.project.phase,
        title: snapshot.project.title,
        next: upcoming ?? '',
        blockers: requirements.filter((item) => !item.ok).map((item) => item.label),
        report: [
          `《${snapshot.project.title}》　阶段：${snapshot.project.phase}`,
          `角色 ${snapshot.characters.length} ｜ 世界观 ${snapshot.world.length} ｜ 分卷 ${snapshot.volumes.length} ｜ 章纲 ${snapshot.plans.length} ｜ 已写 ${written} 章 ｜ 账本 ${snapshot.ledger.length} 条`,
          snapshot.project.premise ? `\n前提：${snapshot.project.premise}` : '\n前提：还没写',
          upcoming
            ? [
                '',
                `下一阶段「${upcoming}」要求：`,
                ...requirements.map((item) => `${item.ok ? '✓' : '✗'} ${item.label}`),
              ].join('\n')
            : '',
        ].filter(Boolean).join('\n'),
      }
    },
  }))
}

function describeNext(target: string, snapshot: Awaited<ReturnType<ToolDeps['store']['snapshot']>>, deps: ToolDeps): string {
  switch (target) {
    case 'canon':
      return '接下来用 novel_canon 建立角色卡（至少 1 主角 + 1 配角，每人要有 voice）和世界观条目。'
    case 'outline':
      return '接下来用 novel_outline 建分卷，再逐章写章纲（每章至少 2 个必写节拍）。'
    case 'drafting':
      return '接下来用 novel_briefing 取本章上下文包，再 novel_chapter action="write" 落笔。'
    case 'review':
      return `共 ${snapshot.chapters.length} 章待审。用 novel_check action="all" 做确定性体检。`
    default:
      return `可以继续，也可以随时用 novel_project action="status" 查看卡点（root=${deps.store.root}）。`
  }
}
