/** `novel_outline`: volumes, chapter contracts, and their approval. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { updateCard, type CardPatch } from '../domain/cards.ts'
import type { ChapterPlan } from '../domain/types.ts'
import type { ToolDeps } from './deps.ts'

function requireNumber(value: number | undefined, field: string): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} 必须是正整数。`)
  }
  return value
}

/**
 * Register the outline tool.
 *
 * @param ctx - plugin context with the tool registry.
 * @param deps - store and resolved config.
 */
export function registerOutlineTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'novel_outline',
    description:
      '分卷与章纲。add_volume 建分卷；add_chapter 写章纲（number/pov/characters/beats/hooks，beats 是这一章必须发生的 2–5 件事）；card 补这一章的章卡（summary 故事梗概、events 关键事件、scene 场景、hooks 钩子、characters 出场人物），只改你给的字段，别的留着；approve_volume 与 approve_chapter 批准后才算数，未批准的章纲不允许写正文；list 列出全部。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['add_volume', 'approve_volume', 'add_chapter', 'approve_chapter', 'card', 'list'],
        description: '操作类型',
      },
      number: { type: 'number', description: '分卷号或章号，从 1 开始' },
      volume: { type: 'number', description: '该章属于第几卷，默认 1' },
      title: { type: 'string', description: '分卷标题或章节标题' },
      summary: { type: 'string', description: '分卷梗概；card 动作里是这一章的故事梗概，传空字符串清掉' },
      events: { type: 'array', items: { type: 'string' }, description: 'card 动作用：关键事件，按发生顺序，一行一件' },
      scene: { type: 'string', description: 'card 动作用：这一章发生在哪里，尽量与地点卡同名；传空字符串清掉' },
      pov: { type: 'string', description: '本章视角人物' },
      characters: { type: 'array', items: { type: 'string' }, description: '本章出场人物，必须与角色卡同名' },
      beats: { type: 'array', items: { type: 'string' }, description: '本章必须发生的节拍，2–5 条，每条一句具体的事' },
      hooks: { type: 'array', items: { type: 'string' }, description: '章末想留的钩子' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          volumes: { type: 'array', items: { type: 'string' } },
          chapters: { type: 'array', items: { type: 'string' } },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    async execute(args, exec) {
      const store = deps.storeFor(exec)
      const snapshot = await store.snapshot()

      if (args.action === 'add_volume') {
        const number = requireNumber(args.number, 'number')
        const title = args.title?.trim()
        if (!title) throw new Error('add_volume 需要 title。')
        await store.upsertVolume({
          number,
          title,
          summary: args.summary?.trim() ?? '',
          approved: false,
        })
        const volumes = await store.volumes()
        return {
          action: args.action,
          volumes: volumes.map((item) => `${item.number}. ${item.title}${item.approved ? '（已批准）' : ''}`),
          chapters: snapshot.plans.map((item) => `第${item.number}章 ${item.title}`),
          report: `已写入第${number}卷《${title}》。确认后用 approve_volume 批准。`,
        }
      }

      if (args.action === 'approve_volume') {
        const number = requireNumber(args.number, 'number')
        const target = snapshot.volumes.find((item) => item.number === number)
        if (!target) throw new Error(`第${number}卷不存在。`)
        await store.upsertVolume({ ...target, approved: true })
        const volumes = await store.volumes()
        return {
          action: args.action,
          volumes: volumes.map((item) => `${item.number}. ${item.title}${item.approved ? '（已批准）' : ''}`),
          chapters: [],
          report: `第${number}卷已批准。`,
        }
      }

      if (args.action === 'add_chapter') {
        const number = requireNumber(args.number, 'number')
        const characters = (args.characters ?? []).map((item) => item.trim()).filter(Boolean)
        const beats = (args.beats ?? []).map((item) => item.trim()).filter(Boolean)
        const hooks = (args.hooks ?? []).map((item) => item.trim()).filter(Boolean)

        const canonNames = new Set(snapshot.characters.map((item) => item.name))
        const unknown = characters.filter((name) => !canonNames.has(name))
        if (unknown.length > 0) {
          throw new Error(
            `章纲引用了角色卡里不存在的角色：${unknown.join('、')}。先用 novel_canon 建卡，或者改掉名字。`,
          )
        }
        if (beats.length < 2) {
          throw new Error('章纲至少要有 2 个必写节拍（beats），否则这一章没有可验证的目标。')
        }

        const existing = snapshot.plans.find((item) => item.number === number)
        const plan: ChapterPlan = {
          number,
          volume: args.volume ?? existing?.volume ?? 1,
          title: args.title?.trim() || existing?.title || `第${number}章`,
          pov: args.pov?.trim() ?? existing?.pov ?? '',
          characters,
          beats,
          hooks,
          // Any edit invalidates the approval: the contract must be re-read after it changes.
          approved: false,
          // The card is not part of the contract, so an outline edit carries it
          // over untouched instead of dropping it on the floor.
          ...(existing?.summary === undefined ? {} : { summary: existing.summary }),
          ...(existing?.events === undefined ? {} : { events: existing.events }),
          ...(existing?.scene === undefined ? {} : { scene: existing.scene }),
        }
        await store.upsertPlan(plan)
        const plans = await store.plans()
        return {
          action: args.action,
          volumes: snapshot.volumes.map((item) => `${item.number}. ${item.title}`),
          chapters: plans.map((item) => `第${item.number}章 ${item.title}${item.approved ? '（已批准）' : ''}`),
          report: [
            `已写入第${number}章章纲《${plan.title}》，${beats.length} 个节拍，出场：${characters.join('、') || '未填'}。`,
            '确认后用 approve_chapter 批准；在此之前不能写正文。',
          ].join('\n'),
        }
      }

      if (args.action === 'approve_chapter') {
        const number = requireNumber(args.number, 'number')
        const target = snapshot.plans.find((item) => item.number === number)
        if (!target) throw new Error(`第${number}章还没有章纲。`)
        await store.upsertPlan({ ...target, approved: true })
        const plans = await store.plans()
        return {
          action: args.action,
          volumes: [],
          chapters: plans.map((item) => `第${item.number}章 ${item.title}${item.approved ? '（已批准）' : ''}`),
          report: `第${number}章章纲已批准，可以写了。先取 novel_briefing，再 novel_chapter action="write"。`,
        }
      }

      if (args.action === 'card') {
        const number = requireNumber(args.number, 'number')
        const events = (args.events ?? []).map((item) => item.trim()).filter(Boolean)
        const characters = args.characters === undefined ? undefined : args.characters.map((item) => item.trim()).filter(Boolean)
        const hooks = args.hooks === undefined ? undefined : args.hooks.map((item) => item.trim()).filter(Boolean)
        if (characters !== undefined) {
          const canonNames = new Set(snapshot.characters.map((item) => item.name))
          const unknown = characters.filter((name) => !canonNames.has(name))
          if (unknown.length > 0) {
            throw new Error(`章卡里写了角色卡上没有的人：${unknown.join('、')}。先用 novel_canon 建卡，或者改掉名字。`)
          }
        }
        const patch: CardPatch = {}
        if (args.summary !== undefined) patch.summary = args.summary.trim()
        if (args.scene !== undefined) patch.scene = args.scene.trim()
        if (args.pov !== undefined) patch.pov = args.pov.trim()
        if (args.title !== undefined) patch.title = args.title.trim()
        if (args.events !== undefined) patch.events = events
        if (characters !== undefined) patch.characters = characters
        if (hooks !== undefined) patch.hooks = hooks
        if (Object.keys(patch).length === 0) {
          throw new Error('card 至少要给一个字段：summary / events / scene / hooks / characters / pov / title。')
        }
        const card = await updateCard(store, number, patch)
        return {
          action: args.action,
          volumes: [],
          chapters: [`第${card.number}章 ${card.title}`],
          report: [
            `第${number}章《${card.title}》的章卡已更新。`,
            `故事梗概：${card.summary ?? '（未写）'}`,
            `场景：${card.scene ?? '（未写）'}`,
            `关键事件 ${card.events?.length ?? 0} 条｜出场人物：${card.characters.join('、') || '未填'}｜钩子 ${card.hooks.length} 条`,
            '这只是记录，不改变章纲合同，也不需要重新批准。',
          ].join('\n'),
        }
      }

      return {
        action: 'list',
        volumes: snapshot.volumes.map((item) => `${item.number}. ${item.title}${item.approved ? '（已批准）' : '（待批）'}　${item.summary}`),
        chapters: snapshot.plans.map((item) =>
          `第${item.number}章《${item.title}》${item.approved ? '已批准' : '待批'}｜视角 ${item.pov || '未定'}｜${item.beats.length} 拍｜${item.characters.join('、') || '无人物'}`,
        ),
        report: [
          `分卷（${snapshot.volumes.length}）：`,
          ...snapshot.volumes.map((item) => `- ${item.number}. ${item.title}${item.approved ? '（已批准）' : '（待批）'}`),
          '',
          `章纲（${snapshot.plans.length}）：`,
          ...snapshot.plans.map((item) => `- 第${item.number}章《${item.title}》${item.approved ? '已批准' : '待批'}，${item.beats.length} 拍`),
        ].join('\n'),
      }
    },
  }))
}
