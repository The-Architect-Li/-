/** `novel_canon`: character cards, world entries and place cards. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CharacterCard, CharacterRole, PlaceCard, PlaceState } from '../domain/types.ts'
import { CHARACTER_ROLES } from '../domain/types.ts'
import type { ToolDeps } from './deps.ts'

function asRole(value: string | undefined): CharacterRole {
  if (value && (CHARACTER_ROLES as readonly string[]).includes(value)) return value as CharacterRole
  return 'supporting'
}

/**
 * Fold a newly seen state of a place into its history.
 *
 * A place changes in the text, not on a schedule: the same building is a
 * three-storey walk-up in chapter 1 and a gutted flat in chapter 100. Each
 * distinct description becomes a state stamped with the chapter it appeared in,
 * so later chapters can be written against the right version of the room.
 *
 * @param previous - the card on disk, when there is one.
 * @param chapter - chapter the new state was observed in; 0 means setup.
 * @param detail - what the place looks like from now on.
 * @param note - why it changed, when the text says.
 * @returns the states list, ordered by chapter.
 */
function foldState(previous: PlaceCard | undefined, chapter: number, detail: string, note: string | undefined): PlaceState[] {
  const states = [...(previous?.states ?? [])]
  const last = states.at(-1)
  if (last && last.detail === detail) {
    if (note && note !== last.note) states[states.length - 1] = { ...last, note }
    return states
  }
  states.push({ chapter, detail, ...(note ? { note } : {}) })
  return states.sort((a, b) => a.chapter - b.chapter)
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
      '管理角色卡、世界观与地点。upsert_character 写角色（name 必填，voice 是说话方式，必须填，用来防止所有角色一个腔调）；upsert_world 写势力/规则/物品/历史；upsert_place 记地点（正文里真正出现过的地点，写清这一章它长什么样、第几章出现的，同一地点再次变化时再写一次，旧状态会留在历史里）；list 列出当前全部设定。同一个 name 会覆盖旧卡。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['upsert_character', 'upsert_world', 'upsert_place', 'list'],
        description: 'upsert_character 写角色 / upsert_world 写世界观 / upsert_place 记地点 / list 列表',
      },
      name: { type: 'string', description: '角色名、设定名或地点名，同名覆盖' },
      role: {
        type: 'string',
        enum: ['protagonist', 'antagonist', 'supporting', 'minor'],
        description: '角色位置，默认 supporting',
      },
      voice: { type: 'string', description: '说话方式：句子长短、用词、口癖、情绪外露程度' },
      appearance: { type: 'string', description: '外形特征，越具体越能防止前后矛盾' },
      goal: { type: 'string', description: '这个角色想要什么' },
      secret: { type: 'string', description: '不愿被人知道的事' },
      notes: {
        type: 'string',
        description: '关系网、成长线这类归不到上面几个字段的材料；不填则保留原样',
      },
      kind: { type: 'string', description: '世界观条目类型，或地点的类别（室内/街区/机构/城市）' },
      detail: { type: 'string', description: '世界观条目的内容；对地点是它现在长什么样' },
      aliases: { type: 'array', items: { type: 'string' }, description: '地点的其他叫法，避免同一个地方被当成两个' },
      chapter: { type: 'number', description: '这条地点状态出现在第几章；设定阶段用 0' },
      note: { type: 'string', description: '地点为什么变了，例如「搬走后重新装修」' },
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
          places: { type: 'array', items: { type: 'string' } },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    async execute(args, exec) {
      const store = deps.storeFor(exec)
      const project = await store.readProject()

      if (args.action === 'upsert_character') {
        const name = args.name?.trim()
        if (!name) throw new Error('upsert_character 需要 name。')
        // A card written here replaces the old one wholesale, so anything this
        // call does not mention has to be carried over by hand — the imported
        // `notes` (relationship web, growth lines) would otherwise vanish the
        // first time the model touched the card.
        const previous = (await store.characters()).find((item) => item.name === name)
        const notes = args.notes === undefined ? previous?.notes : args.notes.trim()
        const card: CharacterCard = {
          name,
          role: asRole(args.role),
          voice: args.voice?.trim() ?? '',
          appearance: args.appearance?.trim() ?? '',
          goal: args.goal?.trim() ?? '',
          secret: args.secret?.trim() ?? '',
          ...(notes === undefined || notes === '' ? {} : { notes }),
          updatedAt: new Date().toISOString(),
        }
        const list = await store.upsertCharacter(card)
        const warnings = card.voice.trim() === ''
          ? ['\n注意：voice 为空。没有说话方式的角色，写出来会和别人一个腔调，建议补上。']
          : []
        return {
          action: args.action,
          name,
          characters: list.map((item) => item.name),
          world: (await store.world()).map((item) => item.name),
          report: [`已写入角色「${name}」（${card.role}），当前 ${list.length} 个角色。`, ...warnings].join('\n'),
        }
      }

      if (args.action === 'upsert_world') {
        const name = args.name?.trim()
        if (!name) throw new Error('upsert_world 需要 name。')
        const detail = args.detail?.trim() ?? ''
        if (detail === '') throw new Error('upsert_world 需要 detail，写清楚这条设定的内容。')
        const list = await store.upsertWorld({
          name,
          kind: args.kind?.trim() || '设定',
          detail,
          updatedAt: new Date().toISOString(),
        })
        return {
          action: args.action,
          name,
          characters: (await store.characters()).map((item) => item.name),
          world: list.map((item) => item.name),
          report: `已写入设定「${name}」，当前 ${list.length} 条世界观。`,
        }
      }

      if (args.action === 'upsert_place') {
        const name = args.name?.trim()
        if (!name) throw new Error('upsert_place 需要 name。')
        const detail = args.detail?.trim() ?? ''
        if (detail === '') throw new Error('upsert_place 需要 detail，写清这个地点现在长什么样。')
        const chapter = Math.max(0, Math.trunc(args.chapter ?? 0))
        const previous = (await store.places()).find((item) => item.name === name)
        const states = foldState(previous, chapter, detail, args.note?.trim())
        const firstChapter = previous?.firstChapter === undefined ? chapter : Math.min(previous.firstChapter, chapter)
        const latestChapter = Math.max(previous?.latestChapter ?? 0, chapter)
        const aliases = args.aliases?.map((alias) => alias.trim()).filter((alias) => alias !== '')
        const card: PlaceCard = {
          name,
          aliases: aliases && aliases.length > 0 ? aliases : (previous?.aliases ?? []),
          kind: args.kind?.trim() || previous?.kind || '地点',
          firstChapter,
          latestChapter,
          detail,
          states,
          ...(previous?.notes ? { notes: previous.notes } : {}),
          updatedAt: new Date().toISOString(),
        }
        const list = await store.upsertPlace(card)
        const history = states.length > 1 ? `（第 ${states.length} 个状态，前面还有 ${states.length - 1} 次变化）` : ''
        return {
          action: args.action,
          name,
          characters: (await store.characters()).map((item) => item.name),
          world: (await store.world()).map((item) => item.name),
          places: list.map((item) => item.name),
          report: `已记下地点「${name}」，第 ${chapter} 章的样子已存${history}。当前 ${list.length} 个地点。`,
        }
      }

      const characters = await store.characters()
      const world = await store.world()
      const places = await store.places()
      return {
        action: 'list',
        name: '',
        characters: characters.map((item) => item.name),
        world: world.map((item) => item.name),
        places: places.map((item) => item.name),
        report: [
          `《${project.title}》　阶段：${project.phase}`,
          '',
          `角色（${characters.length}）：`,
          ...characters.map((item) => `- ${item.name}（${item.role}）${item.voice ? ` 说话方式：${item.voice}` : ' ⚠ voice 未填'}`),
          '',
          `世界观（${world.length}）：`,
          ...world.map((item) => `- ${item.name}［${item.kind}］${item.detail.slice(0, 60)}`),
          '',
          `地点（${places.length}）：`,
          ...places.map((item) => `- ${item.name}［第 ${item.firstChapter} 章起，${item.states.length} 个状态］${item.detail.slice(0, 50)}`),
        ].join('\n'),
      }
    },
  }))
}
