/**
 * The panel's view of the agent team, and its one write: a role's model route.
 *
 * Four studio roles are dispatched as separate subagents — a writer, two
 * reviewers, and a chief who rules on their disagreements. Their prompts are
 * fixed; their *models* are not, and choosing them is the difference between a
 * reviewer that catches continuity errors and one that agrees with everything.
 * Until now that choice existed only as a conversation-side tool call
 * (`novel_roles`); this module gives the panel the same lever, over the same
 * stored shape.
 *
 * The route a role runs on has three layers, strongest first: the book's
 * override, the plugin's global config, then inheriting the session's model.
 * The panel edits layer one and reports which layer is winning, because "the
 * writer is on glm-4" means one thing when the book pinned it and another when
 * the deployment did.
 */
import { describeRoute, resolveRoleRoute, ROLES } from '../roles.ts'
import { ROLE_IDS, type ProjectFile, type ProjectRoles, type RoleId, type RoleRoutePatch } from '../domain/types.ts'
import type { InkwellConfig } from '../domain/types.ts'
import { PanelInputError } from './dirs.ts'

/** Where a role's effective route comes from. */
export type RouteSource = 'book' | 'global' | 'inherit'

/** One role, as the team page shows it. */
export interface RoleView {
  id: RoleId
  /** Human label, e.g. 写手. */
  label: string
  /** One line on what this agent is for. */
  duty: string
  /** What this book stores for the role; `null` when it stores nothing. */
  override: RoleRoutePatch | null
  /** Which layer is actually supplying the route. */
  source: RouteSource
  /** The route in one line, e.g. `zai/glm-4 maxTokens=8192 effort=high`. */
  effective: string
}

/** One line per role, in dispatch order. */
const DUTY: Record<RoleId, string> = {
  writer: '只写正文：按章纲合同和上下文包落笔，不改设定。',
  logic: '只读：对照账本、章纲、时间线、地点找矛盾。',
  character: '只读：对照角色卡的 voice、性格、秘密，找脱离人设的言行。',
  chief: '汇总裁决：把两位审核员的意见分级并裁决分歧。',
}

/** Longest value one route field may carry. */
const MAX_FIELD_CHARS = 160

/** One parsed `POST /roles` request. */
export interface RoleChoice {
  role: RoleId
  /** `true` drops the book's override and falls back to the global layer. */
  reset: boolean
  /** Field patch; `null` clears that field so no lower layer fills it back in. */
  patch: RoleRoutePatch
}

/**
 * Whether one role's stored override would change anything.
 *
 * @param patch - the book's override for the role, if any.
 * @returns true when at least one field is present.
 */
function hasFields(patch: RoleRoutePatch | null | undefined): boolean {
  if (patch === null || patch === undefined) return false
  return (
    patch.provider !== undefined ||
    patch.model !== undefined ||
    patch.maxTokens !== undefined ||
    patch.reasoningEffort !== undefined
  )
}

/**
 * Describe every role for the team page.
 *
 * @param config - resolved plugin configuration.
 * @param projectRoles - the book's stored overrides.
 * @returns four rows in dispatch order.
 */
export function roleViews(config: InkwellConfig, projectRoles?: ProjectRoles): RoleView[] {
  return ROLE_IDS.map((id) => {
    const override = projectRoles?.[id]
    const stored = hasFields(override) ? { ...override } : null
    let source: RouteSource = 'inherit'
    if (stored !== null) source = 'book'
    // A schema with defaults hands back `{ writer: {}, logic: {}, … }`: the entry
    // exists but says nothing. Only a layer with a real field is the source.
    else if (hasFields(config.roles?.[id])) source = 'global'
    return {
      id,
      label: ROLES[id]?.label ?? id,
      duty: DUTY[id],
      override: stored,
      source,
      effective: describeRoute(resolveRoleRoute(id, config, projectRoles)),
    }
  })
}

/**
 * Read one string route field.
 *
 * An empty string is a clear, not a value: a picker that submits `''` after the
 * user chose "unset" means the same thing as `null`, and treating it as a value
 * would store a provider named ''.
 *
 * @param raw - the body value.
 * @param field - field name, for the error message.
 * @returns the trimmed value, `null` to clear, or `undefined` when absent.
 * @throws {PanelInputError} when the value is neither a string nor null.
 */
function readTextField(raw: unknown, field: string): string | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'string') throw new PanelInputError(`${field} 必须是字符串。`)
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (trimmed.length > MAX_FIELD_CHARS) throw new PanelInputError(`${field} 太长。`)
  return trimmed
}

/**
 * Read the `maxTokens` field.
 *
 * @param raw - the body value.
 * @returns the token ceiling, `null` to clear, or `undefined` when absent.
 * @throws {PanelInputError} when it is not a positive integer.
 */
function readMaxTokens(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new PanelInputError('maxTokens 必须是正整数。')
  }
  return Math.floor(raw)
}

/**
 * Validate one `POST /roles` body.
 *
 * @param body - the parsed request body.
 * @returns the role, and either a reset flag or the field patch.
 * @throws {PanelInputError} for an unknown role, or a body with nothing to do.
 */
export function readRoleChoice(body: Record<string, unknown>): RoleChoice {
  const rawRole = body.role
  if (typeof rawRole !== 'string' || !(ROLE_IDS as readonly string[]).includes(rawRole)) {
    throw new PanelInputError(`role 必须是 ${ROLE_IDS.join(' / ')} 之一。`)
  }
  const role = rawRole as RoleId
  if (body.reset === true) return { role, reset: true, patch: {} }
  const patch: RoleRoutePatch = {}
  const provider = readTextField(body.provider, 'provider')
  const model = readTextField(body.model, 'model')
  const reasoningEffort = readTextField(body.reasoningEffort, 'reasoningEffort')
  const maxTokens = readMaxTokens(body.maxTokens)
  if (provider !== undefined) patch.provider = provider
  if (model !== undefined) patch.model = model
  if (reasoningEffort !== undefined) patch.reasoningEffort = reasoningEffort
  if (maxTokens !== undefined) patch.maxTokens = maxTokens
  if (Object.keys(patch).length === 0) {
    throw new PanelInputError('没有要改的字段：给 provider/model/maxTokens/reasoningEffort 之一，或用 reset。')
  }
  return { role, reset: false, patch }
}

/**
 * Fold one choice into a project.
 *
 * @param project - the current project file.
 * @param choice - what the panel asked for.
 * @returns a new project file with the role's override updated.
 */
export function withRoleOverride(project: ProjectFile, choice: RoleChoice): ProjectFile {
  const roles: ProjectRoles = { ...(project.roles ?? {}) }
  if (choice.reset) {
    delete roles[choice.role]
  } else {
    const merged: RoleRoutePatch = { ...(roles[choice.role] ?? {}), ...choice.patch }
    if (hasFields(merged)) roles[choice.role] = merged
    else delete roles[choice.role]
  }
  const next: ProjectFile = { ...project, roles, updatedAt: new Date().toISOString() }
  if (Object.keys(roles).length === 0) delete next.roles
  return next
}

/**
 * Check a role's route against the catalog the panel just offered.
 *
 * Advisory by design: the host routes unlisted model ids happily, so a miss is
 * only rejected when the catalog actually knows the provider — otherwise a
 * provider whose endpoint was down for a minute would lock the picker.
 *
 * @param choice - the requested change.
 * @param providers - known provider ids.
 * @param modelsOfProvider - the models known for one provider.
 * @throws {PanelInputError} when the provider is known but the model is not.
 */
export function checkRouteAgainstCatalog(
  choice: RoleChoice,
  providers: readonly string[],
  modelsOfProvider: (provider: string) => readonly string[],
): void {
  if (choice.reset) return
  const provider = choice.patch.provider
  const model = choice.patch.model
  if (providers.length === 0) return
  if (typeof provider === 'string' && !providers.includes(provider)) {
    throw new PanelInputError(`宿主没有 ${provider} 这个 provider。`)
  }
  if (typeof provider === 'string' && typeof model === 'string') {
    const models = modelsOfProvider(provider)
    if (models.length > 0 && !models.includes(model)) {
      throw new PanelInputError(`${provider} 没有 ${model} 这个模型。`)
    }
  }
}
