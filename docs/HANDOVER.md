# 交接文档 · dsh-inkwell

> 给下一位接手的人（或下一次会话）一份能冷启动的完整说明。
> 最后更新：2026-10-23，对应 release v0.2.0。

## 一句话

dsh-inkwell（墨井）是 DeepSeek Harness 的长篇小说插件。它**不替你写**，而是管住写的那双手：阶段闸门、事实账本、章纲合同、确定性扫描、预算内上下文包，外加一套指挥官流水线（v0.2）。原则是**代码强制 > 提示词自律**——靠模型自觉守的规则，写到 40 万字一定失守。

## 仓库现状

- 地址：https://github.com/The-Architect-Li/- （仓库名是 `-`，可改名）
- 默认分支：`main`，最新提交 `899d114`，**已与远端同步，工作区干净**
- 已发 tag：`v0.1.0`（约束内核）、`v0.2.0`（指挥官流水线）
- 提交历史 13 个，按 conventional commits 拆开（feat/fix/test/docs/chore）
- git 身份：`MegaLord <chinali521@outlook.com>`（全局已设）
- 本地路径：`C:/Users/admin/WorkBuddy/2026-10-23-14-20-23/dsh-inkwell`

## 已交付的能力

### v0.1 约束内核（9 工具里的 7 个）

- `novel_project` init/status/premise/advance —— 五阶状态机（premise→canon→outline→drafting→review→done），每次推进由磁盘数据判定，拒绝时逐条列缺项
- `novel_canon` 角色卡（含 voice）、世界观
- `novel_outline` 分卷、章纲（beats/characters/pov/hooks）、批准
- `novel_chapter` write/read/list —— 漏出场角色**不保存**
- `novel_ledger` 事实账本 —— 同章矛盾拒绝，跨章改动必须 `supersedes` 指名替换
- `novel_briefing` 预算内上下文包，按优先级装料并报告被挤掉的
- `novel_check` 确定性体检（复读/句式/节奏/套路词/对话/章末），零 token

### v0.2 指挥官流水线（新增 2 工具 + 草稿态）

- `novel_dispatch` writer/logic/character/chief —— 走 `ctx.subagents.start('spawn',…)`，一次带上 persona+toolFilter+agentOptions
- `novel_roles` list/set —— 按角色配模型，存每本书的 `project.json.roles`，**密钥不进插件**
- `novel_chapter` 新增 `propose`（落草稿，不挡）/ `commit`（你点头后才进 chapters）；`write` 保留为直写

完整流水线：用户⇄指挥官充分沟通 → 派写手 → propose → 逻辑审核/角色审核 → chief 裁决 → 用户点头 → commit。

## 怎么本地跑

```sh
cd dsh-inkwell
npm install --legacy-peer-deps      # 必须带这个，见下文"依赖说明"
npm run check                        # typecheck + 90 个测试 + build
```

装进真实 DSH（**还没在本机验证过**，大概率要踩一两个坑）：

```sh
dsh plugin --profile web add github:The-Architect-Li/-
# 装完必须重启 dsh 进程（客户端 bundle 启动时快照），硬刷新页面
# 会话里应出现 9 个 novel_* 工具
```

## 依赖说明（容易踩的坑）

`devDependencies` 里那一串 `@deepseek-ai/dsh-*` 是 `@deepseek-ai/dsh-tools` 的**对等依赖闭包**，只为让测试能 import 到真实的 `defineTool`。运行时宿主自带，不会重复装。装时必须 `--legacy-peer-deps`，否则 npm 会去装一个未发布的包（`dsh-type-meta`）而 404。CI 里也是这条命令。

npm 走外网很慢（装 43 个包要 4 分钟左右），不是卡死，耐心等。

## 已验证到什么程度

- ✅ 类型检查零错误（`tsc --noEmit`，strict）
- ✅ 90 个用例全过（vitest），含一个走完整流水线的端到端，用假 subagents 服务断言派发参数正确
- ✅ 用**真实 Cordis 内核 + subagents 服务**挂载过，9 个工具全部注册成功
- ✅ `npm pack` 体积 57.8 kB，文件树正确
- ❌ **没在真实 DSH 里装过**（`dsh plugin add` 未执行）
- ❌ 没验证多工作区下 `.novel` 路径解析（v0.1/0.2 仍是相对 dsh 进程，开第二本书会串）

## DSH 关键 API 速查（已核实源码级，别再从头查）

这些是动工前花了很多 round 核实出来的，续作直接用：

**工具注册**（`@deepseek-ai/dsh-tools`）：
```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
ctx.tools.register(defineTool({
  name, description, parameters: { field: { type:'string', required:true } },
  output: { schema: { type:'object', additionalProperties:false, properties:{...} },
             render: (_a, v) => [{ type:'text', text: v.report ?? '' }] },
  async execute(args, exec) { return {...} },
}))
```
- 对象 output **必须写 `additionalProperties: boolean`**；参数用隐式根，每字段 `required: true`
- `exec.agent` 是 `Agent | undefined`，派发类工具要 guard

**预执行门禁**：
```ts
ctx.on('tools/pre-execute', async (exec, next) => {
  if (该拦) return { kind:'deny', reason }
  return next()
})
```
被拒调用不产生副作用，reason 作为工具结果回给模型。

**子智能体**（`@deepseek-ai/dsh-subagent`，ctx 键 `subagents`）：
```ts
const run = await ctx.subagents.start('spawn', {
  label, prompt: [{type:'text', text}], parent: exec.agent, signal: exec.signal,
  persona,                          // 覆盖子代人格
  toolFilter: { allow: [] },        // 工具白名单；allow:[] = 纯文本生成
  agentOptions: { provider, model, maxTokens },  // 覆盖模型
})
const result = await run.result     // { output: ContentBlock[], stopReason }
```
- `SubagentStartRequest` 字段：`label? prompt parent signal agentOptions? outputSchema? maxDepth? toolFilter? persona?`
- **角色不必注册成预设**——一次 start 全配齐，这是 v0.2 能轻量落地的关键
- AgentOptions **没有 reasoningEffort**（文档提到的 effort 在别处），只有 provider/model/maxTokens

**打包**：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，里面 `insert` 一行 `name: dsh-inkwell`。安装 `dsh plugin --profile web add <pkg>`。

**预设**（v0.3 多角色隔离才用得上）：是 bundle patch 插一行 `@deepseek-ai/dsh-agent-preset`，`config.plugins` 是一组插件行（persona 用 `@deepseek-ai/dsh-persona`，模型用 `@deepseek-ai/dsh-agent-default-model`）。openwrite 的 `presets/openwrite/agent.cordis.yml` 是最佳参照。

**GLM 等模型**：DSH 供应商体系原生覆盖 Z.ai（智谱）、Anthropic、OpenAI、Moonshot；密钥在 Settings → Models，插件只引用 provider/model 名字。

## 设计上不能破的几条

1. **`src/domain/` 里不许出现 `ctx`**——约束逻辑必须是纯函数，能脱离 Harness 单测。这是项目立身之本。
2. **区分"判决"和"提醒"**：阶段/角色缺失/账本冲突=拒绝（拦）；节拍覆盖/复读/套路词=warn（只报告）。写死成拒绝会误杀 3000 字稿子。
3. **审核只报告不改正文**——全流水线只有写手动笔，否则三个模型把稿子揉成浆糊。
4. **密钥永远不进插件**——只存 provider/model 名字，key 留在 DSH 设置。
5. **阈值进 `src/config.ts`**，别写死在函数里。
6. **新增"会拒绝"的规则，测试要断言拒绝的"理由"**，不只是 `ok===false`。

## 下一步（v0.3 候选，按性价比排序）

1. **真实 DSH 实装验证**（必做，零开发量）：本机 `dsh plugin add`，重启，看 9 个工具在不在。报错对着改。这步不做，后面都是空中楼阁。
2. **多工作区路径解析**：`.novel` 跟着会话工作区走。前置：读 `dsh-api-workspace-controller` 的 API，看怎么拿到"当前会话的工作区目录"。改 `ProjectStore` 的 root 解析。
3. **侧边栏「小说工坊」面板**：客户端 React 插件，第四个入口+建项目选目录。前置：核实客户端插槽 API（`dsh-client-ui-slots`），参照 openwrite 的 `studio-panel`。工作量最大，返工风险最高。
4. **草稿审核面板化**：现在 chief 的裁决在对话里，可做成面板里可逐条勾选 必改/建议改/可忽略。
5. **按角色配 reasoningEffort**：目前 AgentOptions 没 effort 字段，要查 `dsh-agent-default-model` 怎么在预设里设。

## 续作第一天做什么

1. `git clone` 仓库，`npm install --legacy-peer-deps`，`npm run check` 确认 90 测试全过。
2. 本机 `dsh plugin --profile web add github:The-Architect-Li/-`，重启 dsh，硬刷新，确认会话里有 9 个 `novel_*` 工具。把报错记下来。
3. 读 `docs/architecture.md`（设计取舍）+ `src/index.ts`（挂载）+ `src/roles.ts`（角色定义）+ `src/gate.ts`（门禁）。
4. 决定先做上面 v0.3 列表的哪一项。

## 项目记忆

会话级工作日志在 `C:/Users/admin/WorkBuddy/2026-10-23-14-20-23/.workbuddy/memory/2026-10-23.md`，含每次决策的来龙去脉和"动工前必读"清单的核实结果。冷启动时先读那个文件再读本篇。
