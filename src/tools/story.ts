/**
 * `novel_story`: the book's arcs.
 *
 * A story point is the unit a reader would call "一段故事". The point of
 * storing them is negative: a new arc must not quietly inherit the old arc's
 * cast and places, and a character remembering an arc three hundred chapters
 * back must still find that arc's material instead of a blurred average of
 * everything since.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { StoryPoint } from '../domain/types.ts'
import type { ToolDeps } from './deps.ts'

/**
 * Next free story-point id.
 *
 * @param points - existing points.
 * @returns `sp-001`-style id, one past the highest.
 */
function nextPointId(points: readonly StoryPoint[]): string {
  const highest = points.reduce((max, point) => {
    const match = /^sp-(\d+)$/.exec(point.id)
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  return `sp-${String(highest + 1).padStart(3, '0')}`
}

/**
 * The story point a chapter belongs to.
 *
 * @param points - all points.
 * @param chapter - the chapter asked about.
 * @returns the open or covering point, preferring the newest start.
 */
export function pointAt(points: readonly StoryPoint[], chapter: number): StoryPoint | undefined {
  const covering = points.filter((point) => point.startChapter <= chapter && (point.endChapter === null || point.endChapter >= chapter))
  return covering.sort((a, b) => b.startChapter - a.startChapter)[0]
}

/**
 * How a point's chapter range reads in a report.
 *
 * @param point - the point.
 * @returns `第1–11章` when closed, `第1章起` while it runs.
 */
function rangeOf(point: StoryPoint): string {
  return point.closed ? `第${point.startChapter}–${point.endChapter}章` : `第${point.startChapter}章起`
}

/**
 * Register the story-point tool.
 *
 * @param ctx - plugin context with the tool registry.
 * @param deps - store and resolved config.
 */
export function registerStoryTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'novel_story',
    description:
      '故事点：把全书切成一段段故事，防止新故事和旧故事混在一起。add 开一段新故事（第一章是第几章、讲什么、谁在场），后续章节自动归到最新的故事点；close 收尾（写到第几章结束）；at 查某一章属于哪一段；list 列出全部。写完一个故事点就收尾，再开下一个，别让两段故事共用一个故事点。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['add', 'close', 'at', 'list'],
        description: 'add 新故事点 / close 收尾 / at 查某章归属 / list 列表',
      },
      number: { type: 'number', description: 'add 是起始章号，close 是结束章号，at 是查询章号' },
      name: { type: 'string', description: '这一段故事的名字，例如「货单」' },
      premise: { type: 'string', description: '这一段讲什么：谁想要什么、被什么拦住' },
      characters: { type: 'array', items: { type: 'string' }, description: '这一段的主要人物，要和角色卡同名' },
      notes: { type: 'string', description: '这一段的补充说明' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          point: { type: 'string' },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    async execute(args, exec) {
      const store = deps.storeFor(exec)
      const points = await store.storyPoints()

      if (args.action === 'add') {
        const start = Math.max(1, Math.trunc(args.number ?? 1))
        const name = args.name?.trim()
        if (!name) throw new Error('add 需要 name，给这一段起个名字。')
        const open = points.filter((point) => !point.closed)
        if (open.length > 0) {
          const previous = open[0]
          const hint = previous
            ? `上一段「${previous.name}」还开着。如果它已经写完，先 close 它；如果这就是同一段，别 add。`
            : ''
          throw new Error(`已经有一段故事点还没收尾。${hint}`)
        }
        const point: StoryPoint = {
          id: nextPointId(points),
          name,
          startChapter: start,
          endChapter: null,
          premise: args.premise?.trim() ?? '',
          characters: args.characters?.map((item) => item.trim()).filter((item) => item !== '') ?? [],
          closed: false,
          ...(args.notes?.trim() ? { notes: args.notes.trim() } : {}),
          createdAt: new Date().toISOString(),
        }
        await store.upsertStoryPoint(point)
        return {
          action: args.action,
          point: point.id,
          report: `已开故事点「${name}」（${point.id}），从第${start}章起。写到这一段结束时要 close 它。`,
        }
      }

      if (args.action === 'close') {
        const end = Math.max(1, Math.trunc(args.number ?? 0))
        if (!Number.isFinite(end) || end < 1) throw new Error('close 需要 number，写这一段的结束章号。')
        const open = points.filter((point) => !point.closed)
        const target = open.sort((a, b) => b.startChapter - a.startChapter)[0]
        if (!target) throw new Error('没有开着的故事点可以收尾。')
        if (end < target.startChapter) {
          throw new Error(`结束章 ${end} 比开始章 ${target.startChapter} 还早。`)
        }
        const closed: StoryPoint = { ...target, endChapter: end, closed: true }
        await store.upsertStoryPoint(closed)
        return {
          action: args.action,
          point: closed.id,
          report: `已收尾故事点「${closed.name}」（第${closed.startChapter}–${end}章）。下一段用 add 另开。`,
        }
      }

      if (args.action === 'at') {
        const chapter = Math.max(1, Math.trunc(args.number ?? 1))
        const found = pointAt(points, chapter)
        if (!found) {
          return { action: args.action, point: '', report: `第${chapter}章还不在任何故事点里。用 add 开一段。` }
        }
        const range = found.closed ? `第${found.startChapter}–${found.endChapter}章` : `第${found.startChapter}章起（未收尾）`
        return {
          action: args.action,
          point: found.id,
          report: [
            `第${chapter}章属于「${found.name}」（${found.id}，${range}）。`,
            found.premise ? `这一段讲：${found.premise}` : '',
            found.characters.length > 0 ? `在场：${found.characters.join('、')}` : '',
          ].filter((line) => line !== '').join('\n'),
        }
      }

      return {
        action: 'list',
        point: '',
        report: points.length === 0
          ? '还没有故事点。用 add 把全书切开。'
          : [
              `故事点（${points.length}）：`,
              ...points.map((point) => {
                return `- ${point.id}「${point.name}」${rangeOf(point)}${point.closed ? '' : ' ⚠ 未收尾'}${point.premise ? `：${point.premise}` : ''}`
              }),
            ].join('\n'),
      }
    },
  }))
}
