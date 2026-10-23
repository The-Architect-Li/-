/** `novel_roles`: inspect and set per-book model routes for studio roles. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { describeRoute, resolveRoleRoute, ROLES } from '../roles.ts'
import { ROLE_IDS, type RoleId, type RoleRoute } from '../domain/types.ts'
import type { ToolDeps } from './deps.ts'

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
      '查看或设置小说工坊各角色用哪个模型。list 看当前四个角色（写手/逻辑审核/角色一致性/总审核）的解析结果（每本书的覆盖优先于全局 config）；set 给某角色设 provider/model/maxTokens，只存进这本书的 project.json，不动全局。不设就继承当前会话模型。模型供应商和密钥都在 DSH 设置里管，这里只记名字。',
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
      provider: { type: 'string', description: 'DSH 里已注册的供应商 id，如 deepseek-account、zai' },
      model: { type: 'string', description: '该供应商下的模型 id' },
      maxTokens: { type: 'number', description: '该角色每次调用的输出上限' },
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
    async execute(args) {
      const project = await deps.store.readProject()
      const projectRoles = project.roles ?? {}

      if (args.action === 'set') {
        const roleId = args.role as RoleId | undefined
        if (!roleId || !(ROLE_IDS as readonly string[]).includes(roleId)) {
          throw new Error('set 需要 role（writer/logic/character/chief）。')
        }
        const next: RoleRoute = {}
        if (args.provider) next.provider = args.provider
        if (args.model) next.model = args.model
        if (args.maxTokens) next.maxTokens = args.maxTokens

        const merged: Partial<Record<RoleId, RoleRoute>> = { ...projectRoles }
        // Clearing a role: pass no provider/model/maxTokens → drop the override.
        if (args.provider === undefined && args.model === undefined && args.maxTokens === undefined) {
          delete merged[roleId]
        } else {
          merged[roleId] = next
        }
        await deps.store.writeProject({ ...project, roles: merged })
        return {
          action: 'set',
          roles: ROLE_IDS.map((id) => `${id}: ${describeRoute(resolveRoleRoute(id, deps.config, merged))}`),
          report: `${ROLES[roleId]?.label ?? roleId} 已设为 ${describeRoute(next)}（存进本书）。`,
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
          '改某个：novel_roles action="set" role="writer" provider="zai" model="glm-..."。',
          '清掉本书对某角色的覆盖：set 时三个字段都不填。',
        ].join('\n'),
      }
    },
  }))
}
