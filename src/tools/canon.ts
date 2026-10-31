/** `novel_canon`: character cards, world entries and place cards. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { currentStage, recordTurn, updateCharacter } from '../domain/characters.ts'
import type { CharacterRelation, CharacterRole, CharacterStage, PlaceCard, PlaceState } from '../domain/types.ts'
import { CHARACTER_ROLES } from '../domain/types.ts'
import { renameWorldKind } from '../domain/kinds.ts'
import type { ToolDeps } from './deps.ts'

function asRole(value: string | undefined): CharacterRole {
  if (value && (CHARACTER_ROLES as readonly string[]).includes(value)) return value as CharacterRole
  return 'supporting'
}

/**
 * Read one `左：右` line into its halves.
 *
 * The colon is the contract: 「刘紫灵：母女」 states something, 「刘紫灵」 alone does
 * not, and guessing which half is missing would put a name in the wrong field.
 *
 * @param line - one entry from the array argument.
 * @param shape - the example quoted back when the line is malformed.
 * @param field - which argument, for the error message.
 * @returns the two halves, trimmed.
 */
function pairOf(line: string, shape: string, field: string): { left: string; right: string } {
  const match = /^([^：:]{1,60})[：:]\s*(.+)$/.exec(line.trim())
  if (match === null) throw new Error(`${field} 每一条都要写成「${shape}」，收到的是：${line}`)
  return { left: match[1]!.trim(), right: match[2]!.trim() }
}

/**
 * Turn the tool's `阶段：发生了什么` lines into stages.
 *
 * @param lines - the array argument as given.
 * @returns stages in the order given.
 */
function asStages(lines: readonly string[]): CharacterStage[] {
  return lines.map((line) => {
    const pair = pairOf(line, '阶段：发生了什么', 'stages')
    return { label: pair.left, text: pair.right }
  })
}

/**
 * Turn the tool's `对方：关系` lines into relations.
 *
 * @param lines - the array argument as given.
 * @returns relations in the order given.
 */
function asRelations(lines: readonly string[]): CharacterRelation[] {
  return lines.map((line) => {
    const pair = pairOf(line, '对方：关系', 'relations')
    return { name: pair.left, kind: pair.right }
  })
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
function foldState(
  previous: PlaceCard | undefined,
  chapter: number,
  detail: string,
  note: string | undefined,
  revision: number | undefined,
): PlaceState[] {
  const states = [...(previous?.states ?? [])]
  const last = states.at(-1)
  if (last && last.detail === detail) {
    const stamped = revision === undefined ? last : { ...last, revision }
    if ((note && note !== last.note) || stamped !== last) states[states.length - 1] = { ...stamped, ...(note ? { note } : {}) }
    return states
  }
  states.push({ chapter, detail, ...(note ? { note } : {}), ...(revision === undefined ? {} : { revision }) })
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
      '管理角色卡、世界观与地点。upsert_character 写角色（name 必填，voice 是说话方式，必须填，用来防止所有角色一个腔调）；shift 记一个人的转变（从什么变成什么、第几章、因为什么事——旧的那一段会留在经历的阶段里，卡上的性格改成现在这个）；upsert_world 写势力/规则/物品/历史；upsert_place 记地点（正文里真正出现过的地点，写清这一章它长什么样、第几章出现的，同一地点再次变化时再写一次，旧状态会留在历史里）；list 列出当前全部设定。同一个 name 会覆盖旧卡。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['upsert_character', 'shift', 'upsert_world', 'upsert_place', 'rename_kind', 'list'],
        description: 'upsert_character 写角色 / shift 记角色转变 / upsert_world 写世界观 / upsert_place 记地点 / rename_kind 改世界观类别的名字或把两类合并 / list 列表',
      },
      chapter: {
        type: 'number',
        description: 'shift 用：转变发生在第几章（正整数），这一章里他已经是「现在」的样子；upsert_place 用：这条地点状态出现在第几章，设定阶段用 0',
      },
      from: { type: 'string', description: 'shift 用：原来是什么样（性格、想法、对人态度），写作者自己的话' },
      to: { type: 'string', description: 'shift 用：现在是什么样；会覆盖卡上的 personality' },
      cause: { type: 'string', description: 'shift 用：是什么事让他变成这样。没有原因的变化不算转变' },
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
        description: '归不到具体字段的材料（给自己看的提示、名字怎么写）；不填则保留原样',
      },
      personality: { type: 'string', description: '性格：脾气、习惯、被逼到墙边时会怎么做' },
      status: { type: 'string', description: '当前状态：到目前这一章为止，这个人处在什么境地' },
      stages: {
        type: 'array',
        items: { type: 'string' },
        description: '经历的阶段，按时间顺序，每条形如「阶段：发生了什么」，例如「工地上：扛水泥，被人叫小名」',
      },
      relations: {
        type: 'array',
        items: { type: 'string' },
        description: '关系，每条形如「对方：关系」——冒号左边是另一个人的名字，右边是从这张卡看过去的那一面，例如「母女，但彼此不认」「师父，十年没再叫过他的名字」；关系是一张表里的一条边（两张卡都能改），这里写的是从这张卡看过去的那一面',
      },
      kind: { type: 'string', description: '世界观条目类型，或地点的类别（室内/街区/机构/城市）' },
      detail: { type: 'string', description: '世界观条目的内容；对地点是它现在长什么样' },
      aliases: {
        type: 'array',
        items: { type: 'string' },
        description: '角色：别称（网名、绰号、别人当面叫的称呼）；地点：其他叫法，避免同一个地方被当成两个',
      },
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
        // A card is a whole object, so anything this call does not mention has
        // to be carried over by hand. `updateCharacter` is that one place: the
        // panel writes through it too, and undefined means "keep the old value"
        // for every field — including the ones only an import ever filled.
        const card = await updateCharacter(store, name, {
          role: args.role === undefined ? undefined : asRole(args.role),
          voice: args.voice,
          appearance: args.appearance,
          goal: args.goal,
          secret: args.secret,
          personality: args.personality,
          status: args.status,
          aliases: args.aliases,
          stages: args.stages === undefined ? undefined : asStages(args.stages),
          relations: args.relations === undefined ? undefined : asRelations(args.relations),
          notes: args.notes,
        })
        const list = await store.characters()
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

      if (args.action === 'shift') {
        const name = args.name?.trim()
        if (!name) throw new Error('shift 需要 name：要记谁的转变。')
        const chapter = Number(args.chapter)
        const card = await recordTurn(store, {
          name,
          chapter,
          before: args.from ?? '',
          after: args.to ?? '',
          cause: args.cause ?? '',
        })
        const turn = currentStage(card)
        return {
          action: args.action,
          name,
          characters: (await store.characters()).map((item) => item.name),
          world: (await store.world()).map((item) => item.name),
          report: [
            `记下「${name}」的转变：第${chapter}章，${turn?.text ?? ''}`,
            '卡上的性格已经改成现在的样子；原来那一段留在「经历的阶段」里，写第' + `${chapter + 1}章的时候他已经是新的人。`,
            '这不是设定改写，是一次有据可查的成长——写后续章节时按新的性格写，不要再按旧卡。',
          ].join('\n'),
        }
      }

      if (args.action === 'rename_kind') {
        // One write, two words: renaming a category and merging two into one are
        // the same operation, and the drawer cannot tell them apart afterwards —
        // which is the point.
        const from = args.name?.trim()
        if (!from) throw new Error('rename_kind 需要 name：被打散的那个类别名。')
        const to = args.kind?.trim()
        if (!to) throw new Error('rename_kind 需要 kind：改成什么名字。')
        const result = await renameWorldKind(store, from, to)
        return {
          action: args.action,
          name: result.to,
          characters: (await store.characters()).map((card) => card.name),
          world: (await store.world()).map((entry) => entry.name),
          places: (await store.places()).map((card) => card.name),
          report:
            result.moved === 0
              ? `书里没有「${from}」这个类别，什么都没改。novel_canon action="list" 看看现有的类别名。`
              : `「${from}」的 ${result.moved} 条全部改到「${result.to}」。世界观抽屉里现在只有一类。`,
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
        // Which version of that chapter this description was read off. Chapter 0
        // is setup — there is no prose behind it, so nothing to be stale against.
        const written = chapter > 0 ? await store.chapter(chapter) : undefined
        const states = foldState(previous, chapter, detail, args.note?.trim(), written?.revision ?? (chapter > 0 ? 1 : undefined))
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
