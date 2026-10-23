/** `novel_roles`: inspect and set per-book model routes for studio roles. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { describeRoute, resolveRoleRoute, ROLES } from '../roles.ts'
import { ROLE_IDS, type ProjectRoles, type RoleId, type RoleRoutePatch } from '../domain/types.ts'
import type { ToolDeps } from './deps.ts'

/** The route fields one `set` call can touch, in reporting order. */
const ROUTE_FIELDS = ['provider', 'model', 'maxTokens', 'reasoningEffort'] as const

/** What one `set` call asks for. An empty value clears the field. */
interface SetRequest {
  provider?: string
  model?: string
  maxTokens?: number
  reasoningEffort?: string
}

/**
 * Turn the tool arguments into the book's stored patch for one role.
 *
 * Three cases per field, and they are genuinely three:
 * - omitted → leave it alone, lower layers may supply it.
 * - a value → pin it in this book.
 * - empty (`''`, or `0` for the token ceiling) → clear it here, so the global
 *   default stays out.
 *
 * "Empty" rather than a boolean, because the model-facing parameter schema only
 * admits strings and numbers: an argument that failed validation would never
 * reach this function at all.
 *
 * @param args - the tool arguments.
 * @param previous - the role's current override, merged over.
 * @returns the next override for this role.
 */
function nextPatch(args: SetRequest, previous: RoleRoutePatch | undefined): RoleRoutePatch {
  const next: RoleRoutePatch = { ...previous }
  if (args.provider !== undefined) next.provider = args.provider === '' ? null : args.provider
  if (args.model !== undefined) next.model = args.model === '' ? null : args.model
  if (args.maxTokens !== undefined) next.maxTokens = args.maxTokens <= 0 ? null : args.maxTokens
  if (args.reasoningEffort !== undefined) {
    next.reasoningEffort = args.reasoningEffort === '' ? null : args.reasoningEffort
  }
  return next
}

/** Whether a patch still says anything; an all-clear patch is dropped. */
function isEmptyPatch(patch: RoleRoutePatch): boolean {
  return ROUTE_FIELDS.every((field) => patch[field] === undefined)
}

/**
 * Register the roles tool.
 *
 * @param ctx - plugin context with the tool registry.
 * @param deps - store and resolved config.
 */
export function registerRolesTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'novel_roles',
    description:
      '查看或设置小说工坊各角色用哪个模型。list 看当前四个角色（写手/逻辑审核/角色一致性/总审核）的解析结果（每本书的覆盖优先于全局 config）；set 给某角色设 provider/model/maxTokens/reasoningEffort，只存进这本书的 project.json，不动全局。某个字段传空字符串（maxTokens 传 0）表示「这本书这一项显式不设」——它会盖住全局默认，但不会动同角色的其他字段。不传的字段继承上一级，全都不设就继承当前会话模型。模型供应商和密钥都在 DSH 设置里管，这里只记名字。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'set'],
        description: 'list 查看 / set 设置',
      },
      role: {
        type: 'string',
        enum: ['writer', 'logic', 'character', 'chief'],
        description: 'set 时要改的角色',
      },
      provider: {
        type: 'string',
        description: 'DSH 里已注册的供应商 id，如 deepseek-account、zai；传空字符串清掉本书对这一项的覆盖',
      },
      model: { type: 'string', description: '该供应商下的模型 id；传空字符串清掉' },
      maxTokens: { type: 'number', description: '该角色每次调用的输出上限；传 0 清掉' },
      reasoningEffort: {
        type: 'string',
        description: '推理档位，取值由供应商/模型适配器决定（如 off/minimal/low/medium/high）；传空字符串清掉，不填则继承',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          roles: { type: 'array', items: { type: 'string' } },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    async execute(args, exec) {
      const store = deps.storeFor(exec)
      const project = await store.readProject()
      const projectRoles: ProjectRoles = project.roles ?? {}

      if (args.action === 'set') {
        const roleId = args.role as RoleId | undefined
        if (!roleId || !(ROLE_IDS as readonly string[]).includes(roleId)) {
          throw new Error('set 需要 role（writer/logic/character/chief）。')
        }

        const merged: ProjectRoles = { ...projectRoles }
        const patch = nextPatch(args as SetRequest, projectRoles[roleId])
        if (isEmptyPatch(patch)) delete merged[roleId]
        else merged[roleId] = patch

        await store.writeProject({ ...project, roles: merged })
        const resolved = resolveRoleRoute(roleId, deps.config, merged)
        return {
          action: 'set',
          roles: ROLE_IDS.map((id) => `${id}: ${describeRoute(resolveRoleRoute(id, deps.config, merged))}`),
          report: [
            `${ROLES[roleId]?.label ?? roleId} 解析结果：${describeRoute(resolved)}（存进本书）。`,
            '想彻底回到继承：provider/model/reasoningEffort 传空字符串、maxTokens 传 0。',
          ].join('\n'),
        }
      }

      const lines = ROLE_IDS.map((id) => {
        const route = resolveRoleRoute(id, deps.config, projectRoles)
        const overridden = projectRoles[id] !== undefined
        return `- ${ROLES[id]?.label ?? id}（${id}）：${describeRoute(route)}${overridden ? '  ← 本书覆盖' : ''}`
      })
      return {
        action: 'list',
        roles: lines,
        report: [
          `《${project.title}》各角色模型：`,
          ...lines,
          '',
          '改某个：novel_roles action="set" role="writer" provider="zai" model="glm-..." reasoningEffort="high"。',
          '清掉本书对某一项的覆盖：把那一项传 false（其余项保持不变）。',
        ].join('\n'),
      }
    },
  }))
}
