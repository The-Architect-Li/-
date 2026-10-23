/**
 * Studio roles and the prompts that drive them.
 *
 * A role is data, not a registered preset: the persona, tool allowlist (empty,
 * so a role is a pure text generator with no leaked tools), and model route are
 * packed into one `ctx.subagents.start` call. Keeping roles as data means a new
 * role is a prompt edit, not a bundle republish.
 */
import { buildBriefing } from './domain/briefing.ts'
import { mergeField } from './domain/fields.ts'
import { activeEntries, factsAbout, formatFact } from './domain/ledger.ts'
import { countChars } from './domain/text.ts'
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
  '- 没有意见就输出 []。只读不改，不提改写建议，只报告问题。',
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
      '你是角色一致性审核员。你对照角色卡的 voice、性格、秘密，检查本章有没有让角色做出脱离人设的言行（语气突变、动机跳跃、泄露不该知道的事）。每条意见指到角色名和原文。',
    outputContract: REVIEWER_CONTRACT,
    timeoutMs: 120_000,
  },
  chief: {
    id: 'chief',
    label: '总审核',
    persona:
      '你是总审核。你汇总其他审核员的意见，裁决他们的分歧，按 必改(error)/建议改(warn)/可忽略(info) 分级。你不重读全文做二次校验，你只裁决和分级。如果不同审核员对同一处意见冲突，你判定谁对。',
    outputContract: REVIEWER_CONTRACT,
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
): string {
  const plan = snapshot.plans.find((item) => item.number === chapter)
  const pack = buildBriefing(snapshot, drafts, chapter, config)
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
 * Build a reviewer's self-contained prompt. The draft text and the relevant
 * canon are embedded so the reviewer needs no parent context and no tools.
 */
export function buildReviewerPrompt(
  roleId: 'logic' | 'character' | 'chief',
  draft: ChapterDraft,
  snapshot: Snapshot,
  config: InkwellConfig,
  directive: string,
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
        `- ${card.name}（${card.role}）：${[card.voice ? `说话方式：${card.voice}` : '', card.goal ? `目标：${card.goal}` : '', card.secret ? `隐秘：${card.secret}` : ''].filter(Boolean).join('｜')}`,
      ),
    )
  }

  sections.push('', '## 指挥官的特别要求', directive.trim() || '按章纲合同和事实核对本章。', '', role.outputContract)

  return sections.join('\n')
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
): string {
  const role = ROLES.chief
  const findingsText = findings
    .map((group) => {
      const label = ROLES[group.role]?.label ?? group.role
      if (group.items.length === 0) return `### ${label}：无意见`
      return ['### ' + label, ...group.items.map((item) => `- [${item.severity}] ${item.message}｜证据：${item.evidence}`)].join('\n')
    })
    .join('\n\n')

  return [
    role.persona,
    '',
    `## 待裁决章节（第${draft.number}章《${draft.title}》，${draft.words} 字，共 ${countChars(draft.text)} 非空字符）`,
    draft.text,
    '',
    '## 各审核员意见',
    findingsText || '（其他审核员暂未提交意见）',
    '',
    '## 指挥官的特别要求',
    directive.trim() || '裁决上述意见，去重、定级、解决冲突。',
    '',
    role.outputContract,
  ].join('\n')
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
      items.push({
        severity,
        code: typeof record.code === 'string' ? record.code : 'review/unnamed',
        message: typeof record.message === 'string' ? record.message : '',
        evidence: typeof record.evidence === 'string' ? record.evidence : '',
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
