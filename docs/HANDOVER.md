# 交接文档 · dsh-inkwell

> 给下一位接手的人（或下一次会话）一份能冷启动的完整说明。
> 最后更新：2026-10-24，对应 release v0.8.0。

## 一句话

dsh-inkwell（墨井）是 DeepSeek Harness 的长篇小说插件。它**不替你写**，而是管住写的那双手：阶段闸门、事实账本、章纲合同、确定性扫描、预算内上下文包，外加一套指挥官流水线（v0.2）、按会话解析的项目根（v0.3）、右侧栏的小说工坊面板（v0.4）、面板里的抽屉树 + 选目录建书（v0.5）、面板里的智能体团队与模型选择（v0.6）抽屉里点开即看的人物／设定／章节详情页（v0.7）和可随手编辑的二级页面（v0.8）。原则是**代码强制 > 提示词自律**——靠模型自觉守的规则，写到 40 万字一定失守。

## 仓库现状

- 地址：https://github.com/The-Architect-Li/- （仓库名是 `-`，可改名）
- 默认分支：`main`
- 已发 tag：`v0.1.0`（约束内核）、`v0.2.0`（指挥官流水线）、`v0.3.0`（多工作区 + 推理档位 + 可安装）、`v0.4.0`（小说工坊面板）、`v0.5.0`（抽屉树 + 面板建书）、`v0.5.1`（三条安装通道打通）、`v0.6.0`（面板里的智能体团队与模型选择）、`v0.6.1`（设置入口搬到抽屉树底部）、`v0.7.0`（详情页 + 打开即折叠）
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

### v0.4 小说工坊面板（右侧栏）

- **面板宿主侧**：`src/panel/model.ts`（纯函数投影：阶段/卡点/字数进度/章表含草稿轮次/出场最多角色/待回收线索/最近事实）+ `src/panel/serve.ts`（`GET /api/inkwell[/snapshot]`，可带 `?session=<id>`）。`webServer` 经 `ctx.inject(['webServer'])` 等，headless profile 里没有它就只装工具不装面板。
- **面板浏览器侧**：`client.js`（手写，**不许打包**——它是 `__ModuleLoader__.load` 信封）注册侧栏 tab 类型 `ctx.sidebarRightTabs.register`，每 5 秒重取快照。只读，没有写操作。
- **入口形状修复（重要）**：删掉 `export default apply`。装载器按 `exports.default ?? exports` 规整模块，`default` 导出会把 `inject` 挡在外面，真机启动报 `cannot get property "tools" without inject`。新增 `test/plugin-shape.test.ts` 钉住装载器看到的形状，`verify-install.mjs` 对构建产物再断一次。
- **包声明**：`dsh.client`（`platform: web` + 依赖的客户端包 id）、`exports["./client"]`、`files` 增加 `client.js`。

### v0.5 抽屉树 + 面板里选目录建书

- **抽屉树**：`src/panel/tree.ts`（纯函数）把书投影成四个抽屉——世界 `◎`／人物设计 `◍`／剧情设计 `◷`／正文 `✎`，各自带计数、可折叠、可选中。人物按结构角色分组（概览/主角/反派/配角/路人，空组也保留一行，形状不跳）；剧情设计拆成「全书故事线（分卷→章数）／剧情点（beats 总数）／伏笔总览（hooks 总数）／章卡（章纲，标已批准/待批准）」；正文按分卷挂章，每章 `已完成／N 稿／可写／未写` + 字数。长列表截断到 25 行并补一行「还有 N 条」。
- **面板建书**：`POST /api/inkwell/init` 调 `ProjectStore.init`——与 `novel_project action="init"` 同一个函数，两条路字节相同。只认带 `x-dsh-plugin: inkwell` 头的 POST；目录必须绝对路径（相对路径 400）；插件 `root` 是绝对路径时 409 并提示改用工具。目录里已有书则回报 `existing: true`，不覆盖。
- **选目录**：优先 `ctx.uiWorkspace.pickDirectory()`（`dsh-client-ui-workspace` 提供，会走桌面桥或宿主 OS 选择框）；客户端用**惰性** `ctx.get('uiWorkspace')` 取它，不写进 `inject`，没有这个服务时退回面板自带的目录浏览器（`GET /api/inkwell/dirs?path=`，含盘符切换、每层最多 200 条）。
- **指定书**：`GET /api/inkwell/snapshot?root=<绝对路径>`；面板把上次选中的 root 记在 `sessionStorage`（键 `inkwell.root.<sessionId>`）。
- **验证**：164 个用例（v0.4 是 150）。真机：`/api/inkwell/dirs?path=E:\dshplugin` 返回 8 个目录、`/init` 无头 403、shell 预加载的 `plugins/??dsh-inkwell/client.js` 含新端点。

### v0.6 面板里的智能体团队与模型选择

- **团队页**（`◍ 智能体团队`，在 `⚙ 设置` 里的第一个入口）：四个角色各一张卡——写手／逻辑审／角色审／裁决，写明它只做什么（`src/panel/roles.ts` 的 `DUTY`）、现在实际跑在哪条路由上（`effective`）、这条路由来自哪一层（`book` 本书指定／`global` 全局默认／`inherit` 跟随会话）。指挥官不是可派角色（它就是对话中的那个模型），只陈述不给选择器。
- **`GET /api/inkwell/roles`**：返回 `{ roles, providers, catalogUnavailable, noBook, root }`。接口与模型清单来自宿主的 `llm` 服务（`src/panel/catalog.ts`：`listProviders` / `listModels` / `resolveModelInfo`，60 秒缓存、每 provider 最多 80 个模型、单个元数据查询 2.5 秒超时后降级为「不列思考档位」）。
- **`POST /api/inkwell/roles`**：`{ role, provider?, model?, reasoningEffort?, maxTokens?, reset? }`。与 `novel_roles action="set"` 写同一个 `project.json.roles`，同一个三态语义（省略＝不管、有值＝钉住、空串＝清掉这一层）；`reset: true` 清掉整条本书覆写。`checkRouteAgainstCatalog` 是**顾问式**校验：只有宿主确实认识那个 provider 时才拒绝不存在的 model。
- **思考档位**：模型的适配器报了什么 `efforts` 就只列什么档位，默认项显示 `defaultEffort`。
- **修掉的标签谎**：配置 schema 会把四个角色物化成 `{}`，旧判据 `config.roles[id] !== undefined` 因此把四个角色全标成 `全局默认`（实际是 `inherit`）。改为 `hasFields(config.roles?.[id])`——**空对象不是一层**。
- **验证**：197 个用例（v0.5 是 164）。真机：`GET /roles` 返回 2 个 provider／4 个角色；`POST` 把写手指定成 `deepseek-official/deepseek-flash` 后 `source` 从 `inherit`→`book`、`effective` 变该路由；`reset` 回到 `inherit`；无头 403、错头 403、对头 200。

### v0.7 抽屉里点开就是那一页

- **打开即折叠**：`client.js` 的 `collapsed` 初值从空集合改为 `new Set(['world','cast','plot','text'])`。面板一打开是目录，不是九十四章。折叠状态在面板会话内保留。
- **详情页**：树里每个带 `kind` 的行（`src/panel/tree.ts` 写入 `kind` + `key`）点开都走 `GET /api/inkwell/entry?kind=&key=&session=&root=`。`src/panel/entry.ts` 的 `buildEntry(snapshot, kind, key, drafts, root)` 产出**通用载荷** `{ kind, title, subtitle, chip?, fields[], lists[], root }`：
  - `character`：说话方式／外貌／目标／秘密／最近改动 + 出场章节（从 `plans[].characters` 反查）+ 账本里的事实（`supersedes === null` 的活事实）。
  - `world`：类别／细节／最近改动 + 相关事实。
  - `chapter`：状态／分卷／视点／章纲是否批准／字数 + 出场人物／必写节拍／章末钩子／最新一稿的自动发现（`autoFindings` 前 5 条）。草稿轮次由路由用 `store.draftsOf(number)` 现读后传入。
  - 找不到就是 `undefined` → 路由 404（「刷新一下」），**不是空白页**：浏览器里挂着一张十分钟前的树时，空白卡比一句解释更糟。
- **点行两种行为**：有 `kind` 的行 → 进详情；有 `children` 的分组行（主角、第N卷）→ 就地展开收起，不必瞄准 6 像素的三角。
- **验证**：211 个用例（v0.6.1 是 197；新增 `test/entry.test.ts` 9 例 + `/entry` 路由 5 例）。`client bundle : ./client.js 51937 bytes`。

### v0.8 二级页面就地编辑 + 章节预览／编辑

- **一条落盘路径**：新增 `src/domain/save.ts` 的 `saveChapterBody(store, config, input)`。`src/tools/chapter.ts` 的 write 分支改为调用它，`POST /api/inkwell/entry` 也调用它——空正文、没章纲、合同 error 三种拒绝在两处逐字一致。`ChapterBlockedError` 带 `blockers: Finding[]`，工具侧包成长句，面板侧转 409。
- **`src/panel/edit.ts`**：`readCharacterPatch`／`readWorldPatch`／`readChapterPatch`，上限 `MAX_FIELD_CHARS=4000`、`MAX_CHAPTER_CHARS=200_000`、`MAX_TITLE_CHARS=120`，全部抛 `PanelInputError`（400）。角色名不可改（名字是 key，改名是 `novel_canon` 的活）。
- **`src/panel/entry.ts` 增量**：`EntryPayload` 多了 `breadcrumb: string[]`、`edit: { inputs: EntryInput[]; body?: {key,label,value} }`、可选 `blocked?: string`；`buildEntry(snapshot, kind, key, drafts, root, body?)` 多收一个正文参数（预览用）。已写章节的标题以 `chapter.title` 为准，没写才用章纲标题。
- **`src/panel/serve.ts`**：新增 `POST /entry`（`writeEntry`）。章节写之前先跑 `gateToolCall('novel_chapter', {action:'write', number}, …)`，非空原样 409。`MAX_WRITE_BYTES=1MB`，`readJson(req, limit)` 支持大正文。
- **`client.js`**：`Detail` 变成整页编辑器——`编辑`／`取消`／`保存中…`、面包屑、章节的「预览正文／改正文」两态（预览按 `/\n\s*\n/` 分段、首行缩进 2em；编辑器下方实时字数）、`data.blocked` 提示框、保存后 `POST /entry` 并用回传数据重画 + `refresh()` 让抽屉树重读。
- **验证**：237 个用例（17 个文件；新增 `test/edit.test.ts` 14 例、`/entry` 写路由 9 例、页面投影 5 例）。真机（隔离 profile `inkwell-verify`，端口 19411）：`GET /entry` 带 `breadcrumb`／`edit`；`POST /entry` 改角色目标后读回一致；无头写 403；未批准的章 409（「第4章的章纲还没批准…」）；组合 bundle 451,534 字节含「预览正文／改正文／保存中／breadcrumb／api/inkwell/entry」。

## 怎么本地跑

```sh
cd dsh-inkwell
npm install                          # 无需任何 flag，见下文"依赖说明"
npm run check                        # typecheck + 237 个测试 + build + 打包冒烟
```

装进真实 DSH（v0.3 起，用独立 profile 验证）：

```sh
dsh plugin --profile inkwell-verify add E:\dshplugin
# 非 desktop 的 profile 会自动初始化（模板 DEFAULT_PROFILE_BUNDLES = dsh-base）
# 装完必须重启 dsh 进程（插件在启动时装载）
```

**不要拿 `--profile desktop` 做验证**——那是用户正在用的 profile，而且 CLI 直接拒绝它（`error: profile "desktop" is managed exclusively by the Electron application`，见 `dsh/lib/bin.js:36` 的 `rejectElectronProfile`）。要装进桌面版，只能走应用自己的插件页；它的 Remote 接口是 `pluginManager/installBundle(spec)`，认同样的 spec。

三条通道 v0.5.1 都实测过：

| spec | 结果 |
| --- | --- |
| `E:\dshplugin`（绝对路径） | 装上即用（pnpm link） |
| `npm pack` 的 tgz | 干净 profile 里装出 `lib/`、`client.js`、`cordis.patch.yml` |
| `git+https://github.com/The-Architect-Li/-.git` | 放行构建后现场 `npm install && tsc` 成功 |

从 git 安装必须先在 profile 的 `pnpm-workspace.yaml` 放行构建，**键是 pnpm 打印的那一整串**（带 commit 的 codeload URL），不是包名：

```yaml
allowBuilds:
  dsh-inkwell@https://codeload.github.com/The-Architect-Li/-/tar.gz/<commit>: true
```

否则 pnpm 拦住 `prepare`，装上去的包没有 `lib/`，装载期报错且原因不直观。

## 依赖说明（容易踩的坑）

源码只 import 四个宿主包：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-subagent`、`@deepseek-ai/schemastery`。v0.5.1 之前 `devDependencies` 里还挂着一整串 `@deepseek-ai/dsh-*`（对等依赖闭包），其中 18 个根本没被 import，却互相 peer 打架——**从 git 装时 `prepare` 跑 `npm install` 会 ERESOLVE 退出**，`lib/` 永远生成不出来。现在只剩真正用到的包，`npm install` 不需要任何 flag，也不再需要 `--legacy-peer-deps`。改 devDependencies 前先 grep 一遍 `from '@deepseek-ai/`，别凭印象加。

npm 走外网很慢（装 58 个包约 8 秒到几分钟不等），不是卡死，耐心等。

## 已验证到什么程度

- ✅ 类型检查零错误（`tsc --noEmit`，strict）
- ✅ 237 个用例全过（vitest，17 个文件），含完整流水线端到端、双工作区互不干扰（走真实工具与真实门禁）、三态合并、推理档位透传、面板投影与抽屉树、面板路由（200/403/404/405、按会话分书、选目录建书）、详情页（角色/设定/章节、草稿轮次、404、400）、团队路由（读/写/还原/顾问式校验/目录不可用降级）、模块装载形状
- ✅ `npm run verify`：用假上下文挂载 `lib/index.js`，9 工具 + 1 门禁 + 1 条面板路由 + 18 个配置键全部就位，并检查浏览器半边的声明与文件
- ✅ **真实 DSH 实装**（v0.5.1 三条通道，每条都启动进程取过 `/api/inkwell`）：
  - 本地路径 `add E:\dshplugin` → `dsh-inkwell: link:E:/dshplugin`
  - `npm pack` 的 tgz（114.8 kB / 118 文件）→ 干净 profile 里装出 `lib/`、`client.js`、`cordis.patch.yml`，`dsh.profile.bundles` 自动补条目
  - `add git+https://github.com/The-Architect-Li/-.git` → 放行构建后现场构建成功
- ✅ **真机 boot**（v0.4 起）：独立 profile 带 `@deepseek-ai/dsh-web-app` 启动后，shell 里出现 `plugins/??dsh-inkwell/client.js` 预加载；`GET /api/inkwell` 返回真实书的快照（HTTP 200，JSON）；`/api/inkwell/snapshot` 同样 200；`POST /init` 能建书
- ✅ `npm view dsh-inkwell` → 404，包名空着，`npm publish` 之后 `add dsh-inkwell` 即可用（本机没登录 npm，此路未实测）
- ✅ 面板的**视觉效果**在 v0.7 由用户截图确认：抽屉树、计数徽章、底部「⚙ 设置」行、详情页都能正常渲染（渲染结果仍以用户的实际主题为准）
- ✅ `/entry` 真机验证：`kind=character&key=沈砚` 返回 200 与完整字段；不存在的名字 404；缺 key 400；非 GET 405
- ✅ **面板写入门真机验证**（v0.8，隔离 profile + 演示书）：`POST /entry` 把沈砚的目标改成「把妹妹带回岸上」后读回一致（改的是磁盘上的 `canon/characters.json`）；无 `x-dsh-plugin` 头 403；写未批准的第四章 409 并回传门禁原话；组合客户端 bundle 451,534 字节里含「预览正文／改正文／保存中／breadcrumb／api/inkwell/entry」

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

**客户端插件（v0.4 核实的一手结论，别再重查）**：

- 声明：`package.json` 里 `dsh.client = { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-sidebar-right', …] }`，`exports["./client"]` 指向 `./client.js`，且 `client.js` 必须在 `files` 里。
- 文件形状：手写的 `__ModuleLoader__.load({ id, factory })`，factory 里 `const exports = {}; exports.apply = …; exports.inject = ['slots','sidebarRightTabs','sidebarRight']; return exports`。**不能过打包器**，任何构建都会改写这层信封。
- 右侧栏服务（`dsh-client-ui-sidebar-right` 的 `SidebarRightTabRegistry`）：`ctx.sidebarRightTabs.register({ id, title, icon, order, render })`。右侧列**只有一个**（`rightbar`），没有第二个右手座位，所以扩面板的正确姿势是加一个 tab **类型**，不是抢占整栏。
- `ctx.slots` 是静态槽位表（`dsh-client-ui-slots`），`inject` 里列的是**客户端包 id**，不是服务名——列错不会报错，只会静默不生效。
- 加载路径：shell 以 `plugins/??<pkg>/client.js&rev=<hash>` 预加载；HMR 走 `/plugins/events` SSE。
- DSH 版本核对：本机 0.2.0-rc.2。`dsh plugin` 对 `desktop` profile 有额外保护（要求该 profile 已被 Desktop 初始化过）。

**GLM 等模型**：DSH 供应商体系原生覆盖 Z.ai（智谱）、Anthropic、OpenAI、Moonshot；密钥在 Settings → Models，插件只引用 provider/model 名字。

## 设计上不能破的几条

1. **`src/domain/` 里不许出现 `ctx`**——约束逻辑必须是纯函数，能脱离 Harness 单测。这是项目立身之本，`scope.ts` 也遵守（它只收 `unknown` 的 exec 和纯函数式参数）。
2. **区分"判决"和"提醒"**：阶段/角色缺失/账本冲突=拒绝（拦）；节拍覆盖/复读/套路词=warn（只报告）。写死成拒绝会误杀 3000 字稿子。
3. **审核只报告不改正文**——全流水线只有写手动笔，否则三个模型把稿子揉成浆糊。
4. **密钥永远不进插件**——只存 provider/model 名字，key 留在 DSH 设置。
5. **阈值进 `src/config.ts`**，别写死在函数里。
6. **新增"会拒绝"的规则，测试要断言拒绝的"理由"**，不只是 `ok===false`。
7. **「哪本书」必须由调用上下文回答**——不要在挂载期把 root 拍成常量，那正是 v0.2 串书的根因。

## 下一步（v0.9 候选，按性价比排序）

1. **面板里批准章纲**：v0.5 开了「建书」，v0.6 开了「挑模型」，v0.8 开了「改已有条目」，三者都等价于一个本来就存在的工具调用。再往前一步到「批准章纲」只剩一个障碍：批准需要理由，而理由要落进 `plans`。做法是让面板的批准表单必填一句理由，再走与 `novel_outline action="approve_chapter"` 相同的写入——**门禁的唯一性不是「只有工具能写」，而是「只有一条代码路径能写」**。
2. **章节级并发写保护**：同一章被两个会话（或面板 + 工具）同时写时后者覆盖。做带版本号的乐观锁（`chapters/index.json` 里存 `revision`），冲突时 409 并提示先刷新。
3. **审稿 DAG 落盘**：把 `novel_dispatch` 的 findings 存成结构化记录（谁提的、哪条、改了没有），支持跨会话追溯；详情页的「最新一稿的自动发现」正是这个数据的第一个消费者。
4. **`novel_briefing` 的预算自适应**：按模型上下文窗口算预算，而不是固定 6000 字。团队页已经有了「这个角色跑在哪个模型上」，上下文窗口就不该再靠猜。
5. **面板里的搜索**：抽屉树截断在 25 行，94 章的书要靠折叠去找。给树加一个「搜角色／搜章节」输入框，仍然是纯函数投影。

## 续作第一天做什么

1. `git clone` 仓库，`npm install`，`npm run check` 确认 237 测试 + 打包冒烟全过。
2. 起一个独立 profile 装本机副本：`dsh plugin --profile inkwell-verify add E:\dshplugin`，看 `node_modules/dsh-inkwell` 是不是 link，再跑 `node scripts/verify-install.mjs <profile>/node_modules/dsh-inkwell`。
3. 想验证面板，得让 profile 的 `dsh.profile.bundles` 里同时有 `@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-web-app`（只有 base 的 profile 没有 `webServer`，面板路由不会挂），然后 `dsh --profile inkwell-verify --port <port>`，用启动日志里的 `?token=` 进 shell、再 `GET /api/inkwell`。**注意**：`package.json` 必须是无 BOM 的 UTF-8，PowerShell 的 `Set-Content -Encoding utf8` 会写 BOM，启动时报 `SyntaxError: Unexpected token '\uFEFF'`。
4. 读 `docs/architecture.md`（含「根目录属于会话」「三态路由」「面板为什么不走 Remote」「面板写操作只开三扇门」「右侧栏只有一条」「入口形状是个陷阱」六节）+ `src/index.ts`（挂载）+ `src/domain/scope.ts`（哪本书）+ `src/domain/save.ts`（正文的唯一落盘口）+ `src/panel/`（面板：model/tree/entry/edit/dirs/roles/catalog + serve）+ `client.js`（浏览器半边：树、详情页编辑器、建书、设置、团队）+ `src/gate.ts`（门禁）。
5. 决定先做上面 v0.9 列表的哪一项。

## 项目记忆

v0.1/v0.2 阶段的会话级工作日志在 `C:/Users/admin/WorkBuddy/2026-10-23-14-20-23/.workbuddy/memory/2026-10-23.md`（**本机不存在，历史路径**）。v0.3 的实现细节以本文件 + `CHANGELOG.md` + `docs/architecture.md` 为准。
