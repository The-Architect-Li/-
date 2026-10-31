/**
 * Studio roles and the prompts that drive them.
 *
 * A role is data, not a registered preset: the persona, tool allowlist (empty,
 * so a role is a pure text generator with no leaked tools), and model route are
 * packed into one `ctx.subagents.start` call. Keeping roles as data means a new
 * role is a prompt edit, not a bundle republish.
 */
import { buildBriefing } from './domain/briefing.ts'
import type { SkillExcerpt } from './domain/skills.ts'
import { mergeField } from './domain/fields.ts'
import { activeEntries, factsAbout, formatFact } from './domain/ledger.ts'
import { countChars } from './domain/text.ts'
import type { ReviewWindow } from './domain/review-window.ts'
import type {
  ChapterDraft,
  ChapterPlan,
  Finding,
  InkwellConfig,
  ProjectRoles,
  RoleId,
  RoleRoute,
  Snapshot,
} from './domain/types.ts'

/** One studio role's fixed identity. */
export interface RoleDef {
  id: RoleId
  /** Human label. */
  label: string
  /** System persona, sent as the child's scoped persona. */
  persona: string
  /** Output contract appended to every task prompt. */
  outputContract: string
  /** Cooperative timeout for this role's dispatch call. */
  timeoutMs: number
}

/** Reviewer finding shape as documented to the model. */
export interface ReviewerFinding {
  severity: 'error' | 'warn' | 'info'
  code: string
  message: string
  evidence: string
  /**
   * A ready-made turn, when the finding is "is this a deliberate change?".
   *
   * The question and the record are the same sentence seen from two sides: the
   * reviewer already holds the before, the after and the evidence. Making the
   * author retype those into four arguments is where a good review quietly dies,
   * so the finding carries the call itself and `novel_canon action="shift"`
   * only has to say yes.
   */
  shift?: {
    name: string
    chapter: number
    from: string
    to: string
    cause: string
  }
}

const WRITER_CONTRACT = [
  '输出契约：',
  '- 直接输出正文，不要标题、不要章号、不要前言或后记、不要解释。',
  '- 覆盖章纲里全部必出场角色，遵循各角色的 voice。',
  '- 按节拍顺序推进，每个节拍都要落到画面上，不要概述带过。',
  '- 结尾按章纲钩子留悬念。',
  '- 不要新增章纲里没有的角色或设定。',
].join('\n')

const REVIEWER_CONTRACT = [
  '输出契约：',
  '- 严格输出一个 JSON 数组，不要 ```json 围栏，不要任何解释或前后缀。',
  '- 每条形如 {"severity":"error|warn|info","code":"<短码>","message":"<一句话>","evidence":"<原文片段或第N章>"}。',
  '- 如果这一条问的是「他是不是真的变了」，再加一个 shift 对象，把该记的东西一次填好：',
  '  {"code":"character/shift", ..., "shift":{"name":"<角色卡上的名字>","chapter":<这一章的章号，数字>,"from":"<原来是什么样>","to":"<这一章成了什么样>","cause":"<是什么事让他变的>"}}。',
  '  from / to / cause 用作者自己的话，不要用你的评价；cause 填不出来就别写 shift 对象，改报 character/drift。',
  '- 没有意见就输出 []。只读不改，不提改写建议，只报告问题。',
].join('\n')

/**
 * What the keeper must answer in, and why it is a list rather than prose.
 *
 * Every entry maps to exactly one existing write door — ledger, place, stage,
 * anchor, or chapter card. A proposal the commander cannot turn into a tool
 * call without deciding anything is the only kind worth paying for; anything
 * vaguer would come back as "update the setting" and be useless.
 */
const KEEPER_CONTRACT = [
  '输出契约：',
  '- 严格输出一个 JSON 数组，不要 ```json 围栏，不要解释。',
  '- 每条形如 {"kind":"ledger|place|stage|anchor|card","subject":"<人/地点/世界>","key":"<属性>","value":"<值>","chapter":<章号>,"quote":"<原文片段>"}。',
  '- kind 的含义：ledger=该记进账本的一条事实；place=这个地点在这一章变成了什么样；stage=这个人进入了哪个阶段；anchor=这一章的日期；card=章卡的故事梗概/关键事件/场景。',
  '- 每一条都必须有你摘的原文片段作为依据；摘不出来就不要提。',
  '- 没有该记的东西就输出 []。记多了比记漏了更坏。',
].join('\n')

/** The four studio roles. The commander is the main session, not listed here. */
export const ROLES: Record<RoleId, RoleDef> = {
  writer: {
    id: 'writer',
    label: '写手',
    persona:
      '你是小说写手，只为长篇小说写正文。你不评论、不记设定、不碰账本。你按给你的章纲合同和上下文包写出一章正文，覆盖所有必出场角色，遵循每个人的说话方式。',
    outputContract: WRITER_CONTRACT,
    timeoutMs: 300_000,
  },
  logic: {
    id: 'logic',
    label: '逻辑审核',
    persona:
      '你是逻辑审核员。你只读，从不改稿。你检查本章与已知事实（账本）、章纲、时间线、地点是否冲突，是否按章纲节拍顺序写到位。每条意见必须能指到原文和章节号。',
    outputContract: REVIEWER_CONTRACT,
    timeoutMs: 120_000,
  },
  character: {
    id: 'character',
    label: '角色一致性审核',
    persona:
      '你是角色一致性审核员。你对照角色卡的 voice、性格、秘密，检查本章有没有让角色做出脱离人设的言行（语气突变、动机跳跃、泄露不该知道的事）。每条意见指到角色名和原文。\n\n'
      + '但人会长。卡上写着「现在」，也写着「怎么变成现在」：同一个人在第 40 章之后不像第 10 章的他，那不是错误，是这本书最好的部分。所以当本章的言行和卡不一致时，你不是直接判错，而是分两种报：\n'
      + '① 没有铺垫的偏离（上一段就这脾气，这一章忽然另一个人，卡上也没有对应的转变记录）→ severity=error，code 用 character/drift，写清「卡上是什么、这一章是什么、原文在哪」。\n'
      + '② 像是有意的转变（有触发的事件、有可追溯的原因，只是卡还没跟上）→ severity=warn，code 用 character/shift，把问题写成一句话问作者：「他在这里变了：原来是 X，这一章成了 Y（原文）。这是有意为之吗？」并在 message 里给出可用的转变记录：建议 call novel_canon action="shift"，name、chapter、from、to、cause 四个参数各填什么。\n'
      + '两种都用角色名 + 原文说话，不要凭印象。',
    outputContract: REVIEWER_CONTRACT,
    timeoutMs: 120_000,
  },
  chief: {
    id: 'chief',
    label: '总审核',
    persona:
      '你是总审核，也是这本书唯一一个必须把「这一章和前面对不对得上」当回事的人。长篇小说的一章不是独立散文：句子再漂亮，只要和前面的章节对不上，就是废的。给你待审的这一章、前面几章的正文与更早几章的梗概，你亲自读，判断它有没有和前文冲突（人死了又出现、伤换了一边、时间倒退、关系突变、上一章埋的钩子被无声吞掉）。同时汇总其他审核员的意见，裁决分歧，按 必改(error)/建议改(warn)/可忽略(info) 分级。前文没给你，就说不知道，不要猜。',
    outputContract: REVIEWER_CONTRACT,
    timeoutMs: 120_000,
  },
  keeper: {
    id: 'keeper',
    label: '状态维护',
    persona:
      '你是状态维护员，不写正文、不改稿、不做文笔评价。你只做一件事：读完这一章，指出「书里的状态该往后走一格」的地方——账本要记的事实、地点这一章变成了什么样、人物走到了哪个阶段、这一章该有哪个日期、章卡该补什么。你只提案，不落盘：写入由指挥官拿着你的清单去调工具。你说不出原文依据的，就不要提。',
    outputContract: KEEPER_CONTRACT,
    timeoutMs: 120_000,
  },
}

/**
 * Resolve a role's model route.
 *
 * Three layers, strongest first: the book's own override, the plugin's global
 * config, then the child inheriting the parent session's model. Each field is
 * merged on its own, so a book can pin the model and still inherit the global
 * `maxTokens`.
 *
 * A book override may carry `null` for a field: that is an explicit "unset",
 * which beats the global default and keeps it out of the result. Without that
 * third state, clearing one field would silently delete the rest of the route.
 *
 * @param roleId - which studio role.
 * @param config - resolved plugin configuration.
 * @param projectRoles - the book's overrides from `project.json`.
 * @returns the merged route, or `undefined` when the child should inherit.
 */
export function resolveRoleRoute(
  roleId: RoleId,
  config: InkwellConfig,
  projectRoles?: ProjectRoles,
): RoleRoute | undefined {
  const project = projectRoles?.[roleId]
  const global = config.roles?.[roleId]
  const layers = [project, global]
  const merged: RoleRoute = {}
  const provider = mergeField(layers, 'provider')
  const model = mergeField(layers, 'model')
  const maxTokens = mergeField(layers, 'maxTokens')
  const reasoningEffort = mergeField(layers, 'reasoningEffort')
  if (typeof provider === 'string' && provider !== '') merged.provider = provider
  if (typeof model === 'string' && model !== '') merged.model = model
  if (typeof maxTokens === 'number') merged.maxTokens = maxTokens
  if (typeof reasoningEffort === 'string' && reasoningEffort !== '') merged.reasoningEffort = reasoningEffort
  if (Object.keys(merged).length === 0) return undefined
  return merged
}

/** A flattened description of a role's resolved route, for the roles tool. */
export function describeRoute(route: RoleRoute | undefined): string {
  if (!route) return '继承当前会话模型'
  const parts = [route.provider ? `${route.provider}/${route.model ?? '?'}` : route.model ?? '?']
  if (route.maxTokens) parts.push(`maxTokens=${route.maxTokens}`)
  if (route.reasoningEffort) parts.push(`effort=${route.reasoningEffort}`)
  return parts.join(' ')
}

/**
 * Build the writer's self-contained prompt: the full context pack plus the
 * chapter contract plus the commander's specific directive.
 */
export function buildWriterPrompt(
  snapshot: Snapshot,
  drafts: ChapterDraft[],
  chapter: number,
  config: InkwellConfig,
  directive: string,
  skills: readonly SkillExcerpt[] = [],
): string {
  const plan = snapshot.plans.find((item) => item.number === chapter)
  const pack = buildBriefing(snapshot, drafts, chapter, config, skills)
  return [
    `${ROLES.writer.persona}`,
    '',
    '## 本章上下文包',
    pack.markdown,
    '',
    '## 你的任务',
    directive.trim() || '按上下文包和章纲合同写本章正文。',
    '',
    ROLES.writer.outputContract,
  ].join('\n')
}

/**
 * The writer's prompt plus what the pack could not fit.
 *
 * Separate from {@link buildWriterPrompt} because the prompt is handed to a
 * child that has no way to report back what it never received, while the
 * warnings belong to whoever asked for the dispatch — the author.
 *
 * @param args - same arguments as {@link buildWriterPrompt}.
 * @returns the prompt, and one sentence per rule that did not make it in.
 */
export function buildWriterBrief(args: {
  snapshot: Snapshot
  drafts: ChapterDraft[]
  chapter: number
  config: InkwellConfig
  directive: string
  skills: readonly SkillExcerpt[]
}): { text: string; warnings: string[] } {
  const pack = buildBriefing(args.snapshot, args.drafts, args.chapter, args.config, args.skills)
  const text = [
    `${ROLES.writer.persona}`,
    '',
    '## 本章上下文包',
    pack.markdown,
    '',
    '## 你的任务',
    args.directive.trim() || '按上下文包和章纲合同写本章正文。',
    '',
    ROLES.writer.outputContract,
  ].join('\n')
  return { text, warnings: pack.warnings }
}

/**
 * Build a reviewer's self-contained prompt. The draft text and the relevant
 * canon are embedded so the reviewer needs no parent context and no tools.
 */
export function buildReviewerPrompt(
  roleId: 'logic' | 'character' | 'chief',
  draft: ChapterDraft,
  snapshot: Snapshot,
  config: InkwellConfig,
  directive: string,
  window?: ReviewWindow,
): string {
  const role = ROLES[roleId]
  const plan = snapshot.plans.find((item) => item.number === draft.number)
  const cast = plan?.characters ?? []
  const facts = cast.length > 0
    ? cast.flatMap((name) => factsAbout(snapshot.ledger, name))
    : activeEntries(snapshot.ledger)

  const characterCards = cast
    .map((name) => snapshot.characters.find((item) => item.name === name))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))

  const sections = [
    role.persona,
    '',
    `## 待审章节（第${draft.number}章《${draft.title}》，${draft.words} 字）`,
    draft.text,
  ]

  if (plan) {
    sections.push('', '## 章纲合同（你按它核对是否照写）', [
      `视角：${plan.pov || '未定'}`,
      `出场：${plan.characters.join('、') || '未填'}`,
      '节拍：',
      ...plan.beats.map((beat, index) => `  ${index + 1}. ${beat}`),
      plan.hooks.length > 0 ? `章末钩子：${plan.hooks.join('；')}` : '',
    ].filter(Boolean).join('\n'))
  }

  if (facts.length > 0) {
    sections.push('', '## 相关已确立事实', facts.map((entry) => `- ${formatFact(entry)}`).join('\n'))
  }

  if (roleId === 'character' && characterCards.length > 0) {
    sections.push(
      '',
      '## 角色卡（你按 voice 核对语气）',
      ...characterCards.map((card) =>
        `- ${card.name}（${card.role}）：${[
          card.aliases && card.aliases.length > 0 ? `别称：${card.aliases.join('、')}` : '',
          card.voice ? `说话方式：${card.voice}` : '',
          card.personality ? `性格：${card.personality}` : '',
          card.goal ? `目标：${card.goal}` : '',
          card.secret ? `隐秘：${card.secret}` : '',
          card.status ? `当前状态：${card.status}` : '',
          card.relations && card.relations.length > 0
            ? `关系：${card.relations.map((relation) => `${relation.name}（${relation.kind}）`).join('、')}`
            : '',
        ].filter(Boolean).join('｜')}`,
      ),
    )
  }

  if (window) sections.push(...renderReviewWindow(window))

  sections.push('', '## 指挥官的特别要求', directive.trim() || '按章纲合同和事实核对本章。', '', role.outputContract)

  return sections.join('\n')
}

/**
 * The recent chapters, as text a reviewer can compare against.
 *
 * Two sections on purpose: the last few chapters are quoted, because continuity
 * breaks at the seam — a name spelled two ways three chapters apart, a man who
 * died and then spoke. Older chapters arrive as one-line recaps, because "did
 * this contradict something ten chapters ago" is a question a summary can answer
 * and a full chapter costs a thousand times more to ask.
 *
 * A stale recap is labelled as such rather than hidden: the reviewer still needs
 * to know what the book *thought* happened, but it must not treat it as fact.
 *
 * @param window - chapters chosen by `buildReviewWindow`.
 * @returns prompt sections, or an empty array when there is no history.
 */
export function renderReviewWindow(window: ReviewWindow): string[] {
  const sections: string[] = []
  if (window.full.length > 0) {
    sections.push('', '## 前面几章的正文（对照这里查连续性）')
    for (const chapter of window.full) {
      sections.push(`### 第${chapter.number}章　${chapter.title}（${chapter.words} 字）`, chapter.text)
    }
  }
  if (window.recaps.length > 0) {
    sections.push('', '## 更早几章的梗概（只有梗概，没有正文）')
    for (const recap of window.recaps) {
      const marks = [
        recap.stale ? '⚠ 正文改过，这条梗概可能过期' : '',
        recap.source === 'tail' ? '（取自正文末尾，不是人写的梗概）' : '',
      ].filter(Boolean)
      sections.push(`- 第${recap.number}章　${recap.title}：${recap.summary}${marks.length > 0 ? `　${marks.join('，')}` : ''}`)
    }
    sections.push('', '⚠ 标记过期的梗概不要当事实用：它描述的是改之前的正文。以正文与账本为准，并可以把「这条梗概要重写」记成一条意见。')
  }
  if (window.omitted > 0) {
    sections.push('', `更早的 ${window.omitted} 章不在这次审稿范围内。不知道就说不确定，不要猜。`)
  }
  return sections
}

/**
 * Build the chief reviewer's prompt, with the other reviewers' findings
 * already folded in so the chief only adjudicates.
 */
export function buildChiefPrompt(
  draft: ChapterDraft,
  findings: { role: RoleId; items: ReviewerFinding[] }[],
  snapshot: Snapshot,
  config: InkwellConfig,
  directive: string,
  window?: ReviewWindow,
): string {
  const role = ROLES.chief
  const findingsText = findings
    .map((group) => {
      const label = ROLES[group.role]?.label ?? group.role
      if (group.items.length === 0) return `### ${label}：无意见`
      return ['### ' + label, ...group.items.map((item) => `- [${item.severity}] ${item.message}｜证据：${item.evidence}`)].join('\n')
    })
    .join('\n\n')

  const sections = [
    role.persona,
    '',
    `## 待裁决章节（第${draft.number}章《${draft.title}》，${draft.words} 字，共 ${countChars(draft.text)} 非空字符）`,
    draft.text,
  ]

  // The chief is the one role whose job is literally "does this fit what came
  // before", so it gets the same window the reviewers get. Adjudicating two
  // opinions about continuity without the earlier chapters is guessing.
  if (window) sections.push(...renderReviewWindow(window))

  sections.push(
    '',
    '## 各审核员意见',
    findingsText || '（其他审核员暂未提交意见）',
    '',
    '## 指挥官的特别要求',
    directive.trim() || '裁决上述意见，去重、定级、解决冲突；再拿前文对一遍，冲突处指出是第几章。',
    '',
    role.outputContract,
  )
  return sections.join('\n')
}

/** One state update the keeper proposes; the commander turns it into a tool call. */
export interface KeeperProposal {
  kind: 'ledger' | 'place' | 'stage' | 'anchor' | 'card'
  subject: string
  key: string
  value: string
  chapter: number
  quote: string
}

/**
 * What the keeper is allowed to know, and it is deliberately less than a reviewer.
 *
 * The keeper reads the new chapter and the *state*, never the previous prose —
 * that is the whole economic argument for having a state layer: if maintaining
 * the state required re-reading the book, the timeline would cost as much as
 * the reviewers it is meant to replace.
 *
 * @param draft - the chapter just written.
 * @param snapshot - the book's state as it stands before this chapter is folded in.
 * @param window - this chapter's computed time window, already formatted.
 * @param directive - the commander's extra instruction.
 * @returns the prompt for the keeper role.
 */
export function buildKeeperPrompt(
  draft: ChapterDraft,
  snapshot: Snapshot,
  window: string,
  directive: string,
): string {
  const role = ROLES.keeper
  const facts = snapshot.ledger
    .slice(-24)
    .map((entry) => `- ${entry.subject}·${entry.predicate}：${entry.value}（第${entry.chapter}章）`)
  const places = snapshot.places.map((place) => {
    const last = [...place.states].sort((a, b) => a.chapter - b.chapter).at(-1)
    return `- ${place.name}：${last ? `第${last.chapter}章 ${last.detail}` : '还没有状态记录'}`
  })
  const stages = snapshot.characters.map((card) => {
    const last = (card.stages ?? []).at(-1)
    return `- ${card.name}：${last ? `${last.label} —— ${last.text}` : '还没有阶段记录'}${card.status ? `（现状：${card.status}）` : ''}`
  })

  const sections = [
    role.persona,
    '',
    `## 这一章（第${draft.number}章《${draft.title}》，${draft.words} 字）`,
    draft.text,
    '',
    '## 这一章的时间',
    window,
  ]
  if (facts.length > 0) sections.push('', '## 账本里最近记下的事实', ...facts)
  if (places.length > 0) sections.push('', '## 地点现在还停在哪里', ...places)
  if (stages.length > 0) sections.push('', '## 人物现在走到哪一步', ...stages)
  sections.push(
    '',
    '## 指挥官的特别要求',
    directive.trim() || '按这一章实际写出来的内容提增量：谁做了什么、哪儿变了、什么时候、这一章讲了什么。没变化的不要提。',
    '',
    role.outputContract,
  )
  return sections.join('\n')
}

/** Parse the keeper's output, dropping entries that could never become a tool call. */
export function parseKeeperOutput(output: string): { items: KeeperProposal[]; parsed: boolean } {
  const cleaned = output
    .replace(/^[\s\S]*?(\[)/, '$1')
    .replace(/(\])[\s\S]*$/, '$1')
    .replace(/```json|```/g, '')
    .trim()
  try {
    const value = JSON.parse(cleaned) as unknown
    if (!Array.isArray(value)) return { items: [], parsed: false }
    const items: KeeperProposal[] = []
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      const kind = record.kind
      if (kind !== 'ledger' && kind !== 'place' && kind !== 'stage' && kind !== 'anchor' && kind !== 'card') continue
      const subject = typeof record.subject === 'string' ? record.subject.trim() : ''
      const value_ = typeof record.value === 'string' ? record.value.trim() : ''
      if (subject === '' || value_ === '') continue
      items.push({
        kind,
        subject,
        key: typeof record.key === 'string' ? record.key.trim() : '',
        value: value_,
        chapter: typeof record.chapter === 'number' ? Math.max(1, Math.trunc(record.chapter)) : 0,
        quote: typeof record.quote === 'string' ? record.quote.trim() : '',
      })
    }
    return { items, parsed: true }
  } catch {
    return { items: [], parsed: false }
  }
}

/**
 * Read a finding's ready-made turn, if it has one worth recording.
 *
 * A half-filled shift is worse than none: `novel_canon action="shift"` refuses
 * missing before/after/cause, so anything incomplete is dropped here and the
 * finding survives as a plain question. That keeps the reviewer's answer honest
 * — either it can name all four, or it is asking rather than proposing.
 *
 * @param value - the raw `shift` field from the model's JSON.
 * @param code - the finding's code, used only to keep the two shapes apart.
 * @returns the turn, or `undefined` when it is not one.
 */
function readShift(value: unknown, code: unknown): ReviewerFinding['shift'] {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const from = typeof record.from === 'string' ? record.from.trim() : ''
  const to = typeof record.to === 'string' ? record.to.trim() : ''
  const cause = typeof record.cause === 'string' ? record.cause.trim() : ''
  const chapter = typeof record.chapter === 'number' ? Math.trunc(record.chapter) : 0
  if (name === '' || from === '' || to === '' || cause === '' || chapter < 1) return undefined
  if (code !== 'character/shift') return undefined
  return { name, chapter, from, to, cause }
}

/** Parse a reviewer's output into findings, degrading gracefully on garbage. */
export function parseReviewerOutput(output: string): { items: ReviewerFinding[]; parsed: boolean } {
  const cleaned = output
    .replace(/^[\s\S]*?(\[)/, '$1')
    .replace(/(\])[\s\S]*$/, '$1')
    .replace(/```json|```/g, '')
    .trim()
  try {
    const value = JSON.parse(cleaned) as unknown
    if (!Array.isArray(value)) return { items: [], parsed: false }
    const items: ReviewerFinding[] = []
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      const severity = record.severity
      if (severity !== 'error' && severity !== 'warn' && severity !== 'info') continue
      const shift = readShift(record.shift, record.code)
      items.push({
        severity,
        code: typeof record.code === 'string' ? record.code : 'review/unnamed',
        message: typeof record.message === 'string' ? record.message : '',
        evidence: typeof record.evidence === 'string' ? record.evidence : '',
        ...(shift === undefined ? {} : { shift }),
      })
    }
    return { items, parsed: true }
  } catch {
    return { items: [], parsed: false }
  }
}

/** The fallback finding when a reviewer's output could not be parsed. */
export function unparsedFinding(roleId: RoleId, output: string): ReviewerFinding {
  return {
    severity: 'info',
    code: `review/${roleId}-unparsed`,
    message: `${ROLES[roleId]?.label ?? roleId} 的输出无法解析为 JSON，原文已附上`,
    evidence: output.slice(0, 200),
  }
}

/** Coerce reviewer findings to the project's Finding type. */
export function toFindings(role: RoleId, items: ReviewerFinding[]): Finding[] {
  return items.map((item) => ({
    code: item.code,
    severity: item.severity,
    message: `[${ROLES[role]?.label ?? role}] ${item.message}`,
    evidence: item.evidence,
  }))
}

export type { ChapterPlan }
