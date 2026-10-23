# 交接文档 · dsh-inkwell

> 给下一位接手的人（或下一次会话）一份能冷启动的完整说明。
> 最后更新：2026-10-23，对应 release v0.3.0。

## 一句话

dsh-inkwell（墨井）是 DeepSeek Harness 的长篇小说插件。它**不替你写**，而是管住写的那双手：阶段闸门、事实账本、章纲合同、确定性扫描、预算内上下文包，外加一套指挥官流水线（v0.2）与按会话解析的项目根（v0.3）。原则是**代码强制 > 提示词自律**——靠模型自觉守的规则，写到 40 万字一定失守。

## 仓库现状

- 地址：https://github.com/The-Architect-Li/- （仓库名是 `-`，可改名）
- 默认分支：`main`
- 已发 tag：`v0.1.0`（约束内核）、`v0.2.0`（指挥官流水线）、`v0.3.0`（多工作区 + 推理档位 + 可安装）
- 提交历史按 conventional commits 拆开（feat/fix/test/docs/chore）
- git 身份：`MegaLord <chinali521@outlook.com>`（全局已设）
- 本地开发副本：`E:/dshplugin`

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

### v0.3 多工作区 + 推理档位 + 真的能装

- **项目根按会话解析**：`src/domain/scope.ts` 的 `resolveSessionRoot(exec, config, baseStore)` 取代了挂载期的一次性 `resolve`。`exec.agent.session.header.cwd` 是权威答案；绝对 `root` 仍钉死一本书；读不到 cwd 退回共享 store；`perWorkspace: false` 完整回到 v0.2。
- **`ToolDeps` 不再持有 store**，改为 `storeFor(exec)`。九个工具与门禁用同一份解析结果，杜绝「在这本批准、往那本写」。
- **推理档位**：角色路由四字段 `provider/model/maxTokens/reasoningEffort`，原样塞进 `agentOptions`。`ReasoningEffortId` 是 branded string，取值由供应商适配器决定，插件不校验。
- **三态字段覆盖**：`src/domain/fields.ts` 的 `mergeField` / `mentioned` / `concrete`。工具层用空串（`maxTokens` 用 `0`）表达「本书显式不设」，落盘为 `null`，压住全局默认且不连累同角色其它字段。
- **可安装**：`package.json` 补 `prepare: npm run build`，`files` 只发 `lib/` 的老问题不再致命；新增 `scripts/verify-install.mjs` + `npm run verify`，挂载**构建产物**断言 9 工具 + 1 门禁都在。

## 怎么本地跑

```sh
cd dsh-inkwell
npm install --legacy-peer-deps      # 必须带这个，见下文"依赖说明"
npm run check                        # typecheck + 125 个测试 + build + 打包冒烟
```

装进真实 DSH（**v0.3 已在本机验证过，用独立 profile**）：

```sh
dsh plugin --profile inkwell-verify add E:\dshplugin
# 非 desktop 的 profile 会自动初始化（模板 DEFAULT_PROFILE_BUNDLES = dsh-base）
# 装完必须重启 dsh 进程（插件在启动时装载）
```

**不要拿 `--profile desktop` 做验证**——那是用户正在用的 profile，装上去会改动 `dsh.profile.bundles`（`reconcile` 会把新 bundle 自动写进去）。

从 git 安装必须先在 profile 的 `pnpm-workspace.yaml` 放行构建：

```yaml
allowBuilds:
  dsh-inkwell: true
```

否则 pnpm 拦住 `prepare`，装上去的包没有 `lib/`，装载期报错且原因不直观。

## 依赖说明（容易踩的坑）

`devDependencies` 里那一串 `@deepseek-ai/dsh-*` 是 `@deepseek-ai/dsh-tools` 的**对等依赖闭包**，只为让测试能 import 到真实的 `defineTool`。运行时宿主自带，不会重复装。装时必须 `--legacy-peer-deps`，否则 npm 会去装一个未发布的包（`dsh-type-meta`）而 404。CI 里也是这条命令。

npm 走外网很慢（装 43 个包要 4 分钟左右），不是卡死，耐心等。

## 已验证到什么程度

- ✅ 类型检查零错误（`tsc --noEmit`，strict）
- ✅ 125 个用例全过（vitest，12 个文件），含完整流水线端到端、双工作区互不干扰（走真实工具与真实门禁）、三态合并、推理档位透传
- ✅ `npm run verify`：用假上下文挂载 `lib/index.js`，9 工具 + 1 门禁 + 18 个配置键全部就位
- ✅ **真实 DSH 实装**：`dsh plugin --profile inkwell-verify add E:\dshplugin` 成功，profile 里 `dsh-inkwell: link:E:/dshplugin`，装载后工具清单与仓库内构建产物一致
- ✅ `npm pack` 体积 83.6 kB / 101 个文件，文件树正确
- ❌ 侧边栏面板仍未做（客户端 React 插件）

## DSH 关键 API 速查（已核实源码级，别再从头查）

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

**会话 cwd**（v0.3 的地基）：
- `exec.agent.session.header.cwd`（`dsh-session` 的 `SessionHeader.cwd?: string`，会话创建时的绝对工作目录）
- `Agent` 上有 `readonly session: Session`、`readonly options: AgentOptions`、`readonly ctx`
- `@deepseek-ai/dsh-util-workspace-path` 提供 `resolveWorkspacePath(cwd, path)`、`isAbsoluteWorkspacePath` 等；**本插件故意不依赖它**，`node:path` 的 `isAbsolute` + `resolve` 足够，少一层运行时依赖

**预执行门禁**：
```ts
ctx.on('tools/pre-execute', async (exec, next) => {
  if (该拦) return { kind:'deny', reason }
  return next()
})
```
被拒调用不产生副作用，reason 作为工具结果回给模型。`exec.arguments` 是原始参数，`exec` 上也带着 `agent`。

**子智能体**（`@deepseek-ai/dsh-subagent`，ctx 键 `subagents`）：
```ts
const run = await ctx.subagents.start('spawn', {
  label, prompt: [{type:'text', text}], parent: exec.agent, signal: exec.signal,
  persona,                          // 覆盖子代人格
  toolFilter: { allow: [] },        // 工具白名单；allow:[] = 纯文本生成
  agentOptions: { provider, model, maxTokens, reasoningEffort },  // 覆盖模型
})
const result = await run.result     // { output: ContentBlock[], stopReason }
```
- **`AgentOptions` 现在有 `reasoningEffort?: ReasoningEffortId`**（`dsh-agent/lib/types/runtime-types.d.ts`）。v0.2 交接里「没有 effort 字段」的说法已过时。
- `ReasoningEffortId` 来自 `@deepseek-ai/dsh-llm` 的 brand，`ReasoningEffortId(id)` 只是品牌转换，**不校验取值**。
- 角色不必注册成预设——一次 start 全配齐。

**包装与安装**：
- `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`（也可以是**数组**，多文件叠加）
- 安装 spec 分 registry/path/tarball/git，**path 必须是绝对路径**
- 兼容性判定走 `peerDependencies` 里 `@deepseek-ai/dsh*` 的 semver 区间，`dsh.compatibility.dsh` 字段**不参与**运行时判定
- 安装成功后 `reconcile` 会把新 bundle 自动写进 `dsh.profile.bundles`，不用手改

**预设**（侧边栏/多角色隔离才用得上）：是 bundle patch 插一行 `@deepseek-ai/dsh-agent-preset`，`config.plugins` 是一组插件行（persona 用 `@deepseek-ai/dsh-persona`，模型用 `@deepseek-ai/dsh-agent-default-model`）。openwrite 的 `presets/openwrite/agent.cordis.yml` 是最佳参照。

**GLM 等模型**：DSH 供应商体系原生覆盖 Z.ai（智谱）、Anthropic、OpenAI、Moonshot；密钥在 Settings → Models，插件只引用 provider/model 名字。

## 设计上不能破的几条

1. **`src/domain/` 里不许出现 `ctx`**——约束逻辑必须是纯函数，能脱离 Harness 单测。这是项目立身之本，`scope.ts` 也遵守（它只收 `unknown` 的 exec 和纯函数式参数）。
2. **区分"判决"和"提醒"**：阶段/角色缺失/账本冲突=拒绝（拦）；节拍覆盖/复读/套路词=warn（只报告）。写死成拒绝会误杀 3000 字稿子。
3. **审核只报告不改正文**——全流水线只有写手动笔，否则三个模型把稿子揉成浆糊。
4. **密钥永远不进插件**——只存 provider/model 名字，key 留在 DSH 设置。
5. **阈值进 `src/config.ts`**，别写死在函数里。
6. **新增"会拒绝"的规则，测试要断言拒绝的"理由"**，不只是 `ok===false`。
7. **「哪本书」必须由调用上下文回答**——不要在挂载期把 root 拍成常量，那正是 v0.2 串书的根因。

## 下一步（v0.4 候选，按性价比排序）

1. **侧边栏「小说工坊」面板**（工作量最大）：客户端 React 插件，第四个入口 + 建项目选目录。前置：核实客户端插槽 API（`dsh-client-ui-slots`），参照 openwrite 的 `studio-panel`。注意 `apps/web` 侧改动必须重建并按现有 URL 验证。
2. **章节级并发写保护**：同一章被两个会话同时 `write` 时后者覆盖。做带版本号的乐观锁（`chapters/index.json` 里存 `revision`），冲突时拒绝并提示先 `read`。
3. **审稿 DAG 落盘**：把 `novel_dispatch` 的 findings 存成结构化记录（谁提的、哪条、改了没有），支持跨会话追溯。
4. **草稿审核面板化**：chief 的裁决做成面板里可逐条勾选 必改/建议改/可忽略。
5. **`novel_briefing` 的预算自适应**：按模型上下文窗口算预算，而不是固定 6000 字。

## 续作第一天做什么

1. `git clone` 仓库，`npm install --legacy-peer-deps`，`npm run check` 确认 125 测试 + 打包冒烟全过。
2. 起一个独立 profile 装本机副本：`dsh plugin --profile inkwell-verify add E:\dshplugin`，看 `node_modules/dsh-inkwell` 是不是 link，再跑 `node scripts/verify-install.mjs <profile>/node_modules/dsh-inkwell`。
3. 读 `docs/architecture.md`（设计取舍，含「根目录属于会话」与「三态路由」两节）+ `src/index.ts`（挂载）+ `src/domain/scope.ts`（哪本书）+ `src/roles.ts`（角色定义）+ `src/gate.ts`（门禁）。
4. 决定先做上面 v0.4 列表的哪一项。

## 项目记忆

v0.1/v0.2 阶段的会话级工作日志在 `C:/Users/admin/WorkBuddy/2026-10-23-14-20-23/.workbuddy/memory/2026-10-23.md`（**本机不存在，历史路径**）。v0.3 的实现细节以本文件 + `CHANGELOG.md` + `docs/architecture.md` 为准。
