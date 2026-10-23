/** `novel_canon`: character cards and world entries. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CharacterCard, CharacterRole } from '../domain/types.ts'
import { CHARACTER_ROLES } from '../domain/types.ts'
import type { ToolDeps } from './deps.ts'

function asRole(value: string | undefined): CharacterRole {
  if (value && (CHARACTER_ROLES as readonly string[]).includes(value)) return value as CharacterRole
  return 'supporting'
}

/**
 * Register the canon tool.
 *
 * @param ctx - plugin context with the tool registry.
 * @param deps - store and resolved config.
 */
export function registerCanonTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'novel_canon',
    description:
      '管理角色卡与世界观。upsert_character 写角色（name 必填，voice 是说话方式，必须填，用来防止所有角色一个腔调）；upsert_world 写地点/势力/规则/物品；list 列出当前全部设定。同一个 name 会覆盖旧卡。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['upsert_character', 'upsert_world', 'list'],
        description: 'upsert_character 写角色 / upsert_world 写世界观 / list 列表',
      },
      name: { type: 'string', description: '角色名或设定名，同名覆盖' },
      role: {
        type: 'string',
        enum: ['protagonist', 'antagonist', 'supporting', 'minor'],
        description: '角色位置，默认 supporting',
      },
      voice: { type: 'string', description: '说话方式：句子长短、用词、口癖、情绪外露程度' },
      appearance: { type: 'string', description: '外形特征，越具体越能防止前后矛盾' },
      goal: { type: 'string', description: '这个角色想要什么' },
      secret: { type: 'string', description: '不愿被人知道的事' },
      kind: { type: 'string', description: '世界观条目类型：地点/势力/规则/物品/历史' },
      detail: { type: 'string', description: '世界观条目的内容' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          name: { type: 'string' },
          characters: { type: 'array', items: { type: 'string' } },
          world: { type: 'array', items: { type: 'string' } },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    async execute(args) {
      const project = await deps.store.readProject()

      if (args.action === 'upsert_character') {
        const name = args.name?.trim()
        if (!name) throw new Error('upsert_character 需要 name。')
        const card: CharacterCard = {
          name,
          role: asRole(args.role),
          voice: args.voice?.trim() ?? '',
          appearance: args.appearance?.trim() ?? '',
          goal: args.goal?.trim() ?? '',
          secret: args.secret?.trim() ?? '',
          updatedAt: new Date().toISOString(),
        }
        const list = await deps.store.upsertCharacter(card)
        const warnings = card.voice.trim() === ''
          ? ['\n注意：voice 为空。没有说话方式的角色，写出来会和别人一个腔调，建议补上。']
          : []
        return {
          action: args.action,
          name,
          characters: list.map((item) => item.name),
          world: (await deps.store.world()).map((item) => item.name),
          report: [`已写入角色「${name}」（${card.role}），当前 ${list.length} 个角色。`, ...warnings].join('\n'),
        }
      }

      if (args.action === 'upsert_world') {
        const name = args.name?.trim()
        if (!name) throw new Error('upsert_world 需要 name。')
        const detail = args.detail?.trim() ?? ''
        if (detail === '') throw new Error('upsert_world 需要 detail，写清楚这条设定的内容。')
        const list = await deps.store.upsertWorld({
          name,
          kind: args.kind?.trim() || '设定',
          detail,
          updatedAt: new Date().toISOString(),
        })
        return {
          action: args.action,
          name,
          characters: (await deps.store.characters()).map((item) => item.name),
          world: list.map((item) => item.name),
          report: `已写入设定「${name}」，当前 ${list.length} 条世界观。`,
        }
      }

      const characters = await deps.store.characters()
      const world = await deps.store.world()
      return {
        action: 'list',
        name: '',
        characters: characters.map((item) => item.name),
        world: world.map((item) => item.name),
        report: [
          `《${project.title}》　阶段：${project.phase}`,
          '',
          `角色（${characters.length}）：`,
          ...characters.map((item) => `- ${item.name}（${item.role}）${item.voice ? ` 说话方式：${item.voice}` : ' ⚠ voice 未填'}`),
          '',
          `世界观（${world.length}）：`,
          ...world.map((item) => `- ${item.name}［${item.kind}］${item.detail.slice(0, 60)}`),
        ].join('\n'),
      }
    },
  }))
}
