# 变更日志

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.5.1] - 2026-10-24

让「装」这件事真的成立：三条安装通道全部实测通过，并且修掉了从 git 装必然失败的那个断点。

### 修复

- **从 git 装必失败**：`prepare` 要跑构建，pnpm 在临时目录里执行 `npm install`，而 22 个
  devDependencies 里有 18 个源码根本没 import 过（`dsh-agent`、`dsh-invariants`、`vite` 等），
  它们的 peer 约束互相打架，`npm install` 直接 ERESOLVE 退出，`lib/` 永远生成不出来。现在只留
  源码真正 import 的四个宿主包（cordis／dsh-tools／dsh-subagent／schemastery）+ 工具链，
  `npm install` 不再需要 `--legacy-peer-deps`。
- `@deepseek-ai/dsh-subagent` 补进 optional peerDependencies：`ctx.subagents` 的类型来自它，
  而运行时由宿主提供。

### 变更

- `package.json` 版本 0.5.1。
- README 的安装段改成三种 spec 的对照表（registry／本地绝对路径／git），并把 git 装那一步说明
  白：第一次失败是 pnpm 的供应链策略，抄它打印的那个键进 `allowBuilds` 再跑一遍；Desktop 的
  profile 归应用自己管，要装进桌面版得走应用的插件页。

### 验证

三条通道都实测过，每条都启动进程、取 `/api/inkwell`：

| 通道 | 结果 |
| --- | --- |
| 本地绝对路径 `add E:\dshplugin` | 装上即用，9 工具 + 面板路由 + 客户端模块都在 |
| 打包 `npm pack` → `add dsh-inkwell-0.5.1.tgz` | 干净 profile 里装出 `lib/`、`client.js`、`cordis.patch.yml`，`dsh.profile.bundles` 自动加条目 |
| `add git+https://github.com/The-Architect-Li/-.git` | 放行构建后现场 `npm install && tsc` 成功，启动后面板路由 200、客户端模块被预加载 |

`npm view dsh-inkwell` 返回 404，**包名还没被占**，`npm publish` 之后 `add dsh-inkwell` 就能用。

## [0.5.0] - 2026-10-23

侧边栏成了一张工作台：书按抽屉摆开，也能在里面自己选目录建一本，不必先回对话框。

### 新增

- **抽屉树**（`src/panel/tree.ts`，纯函数）：世界 `◎`／人物设计 `◍`／剧情设计 `◷`／正文 `✎`
  四个抽屉，各自带计数徽章、可折叠、可选中；人物按结构角色分组（概览／主角／反派／配角／
  路人），剧情设计按「全书故事线／剧情点／伏笔总览／章卡」拆开，正文按分卷挂章，每章带
  `已完成／N 稿／可写／未写` 状态与字数。长列表截断到 25 行并补一行「还有 N 条」，面板不会
  因为一本 300 章的书变成一堵墙。
- **在面板里建书**：`POST /api/inkwell/init` 与 `novel_project action="init"` 走同一个
  `ProjectStore.init`，所以两条路建出来的书字节相同。可以先点「选择目录…」调系统目录选择框
  （`ctx.uiWorkspace.pickDirectory()`），也可以直接用面板里的目录浏览器逐层点，Windows 上还
  能切盘符。目录里已经有书时它报「已经有《…》」并给一个「打开这本书」，不会覆盖。
- **目录浏览**：`GET /api/inkwell/dirs?path=<绝对路径>` 列一层子目录（每层最多 200 条）、
  父目录与可用盘符，同时回报该目录里是否已经有书。
- **指定书**：`GET /api/inkwell/snapshot?root=<绝对路径>` 读任意一本已存在的书；面板把上一个
  选中的 root 记在 `sessionStorage` 里，刷新还在。相对路径一律 400——绝不让宿主进程的 cwd
  替用户猜。
- **写路由的门**：`/init` 只认带 `x-dsh-plugin: inkwell` 头的 POST。简单表单跨站提交带不上这个
  头，同源读之外没有第二个入口。

### 变更

- 面板从「只读仪表盘」变成「能建书、能翻目录」：`/snapshot` 仍只读，写只有 `/init` 一个。
- `package.json` 版本 0.5.0。

### 验证

- 164 个用例（v0.4 是 150）。新增：抽屉树的计数/分组/状态/截断、`?root=` 覆盖、目录浏览、
  无头建书、已存在不覆盖、相对路径 400、绝对 root 下 409、`/init` 只认 POST。
- 真机验证：独立 profile boot 后 `/api/inkwell/dirs?path=E:\dshplugin` 返回 8 个目录；
  `/init` 无头 403；shell 预加载 `plugins/??dsh-inkwell/client.js` 且含新端点与抽屉样式。

### 仍不做

- 面板里推进阶段、改章纲、写正文：这些仍然只有工具能做，门禁只有一个。
- 章节级并发写：同一本书同一章同时写会被后写覆盖。

## [0.4.0] - 2026-10-23

右侧栏有了「小说工坊」：不开对话框也能看见这本书现在在哪、卡在哪、下一步做什么。

### 新增

- **小说工坊面板**（`client.js` + `/api/inkwell`）：注册成右侧 Sidebar 的一个 tab 类型
  （`ctx.sidebarRightTabs.register`），每 5 秒随会话切换重取一次快照。面板只读，不提供
  写操作——阶段推进仍然走工具，这样「谁能改」还是那一个门禁。
- **面板投影**（`src/panel/model.ts`，纯函数）：标题、阶段、下一阶、卡点、字数进度、
  章表（章纲/草稿轮次/定稿状态）、出场最多的角色、待回收线索、最近的事实。全部零 token，
  由磁盘数据算得。
- **路由**（`src/panel/serve.ts`）：`GET /api/inkwell[/snapshot]`，可带 `?session=<id>`；
  `perWorkspace` 开启时按该会话的 `cwd` 定位书，否则回落到进程那一本。非 GET 一律 403/405，
  面板是只读的。
- **`webServer` 是可选服务**：面板路由经 `ctx.inject(['webServer'])` 挂载，headless
  profile 里没有这个服务，插件照样装载工具，只是没有面板。

### 变更

- **入口不再有 `default` 导出**。装载器会把模块规整成 `exports.default ?? exports`，一个
  `default` 导出会把 `inject` 一起挡在外面，插件于是在服务就绪前访问 `ctx.tools`，真机启动
  报 `cannot get property "tools" without inject`。这个错误在单测里看不见（单测直接调
  `apply`），现在有 `test/plugin-shape.test.ts` 把装载器看到的形状钉住。
- 包声明补 `dsh.client`（`platform: web`、依赖的客户端包 id）与 `exports["./client"]`，
  `files` 增加 `client.js`。

### 验证

- 150 个用例（v0.3 是 125）。新增：面板投影、路由（200/403/405）、按会话 id 查 cwd、
  模块装载形状、九个工具在只有声明过的服务可用时仍能挂载。
- 真机验证：独立 profile（`inkwell-verify`）boot 后，`/api/inkwell` 返回真实书的快照；
  客户端模块被 shell 以 `plugins/??dsh-inkwell/client.js` 预加载。

### 仍不做

- 面板里的写操作（推进阶段、改章纲）：面板是仪表盘，不是第二个入口。
- 章节级并发写：同一本书同一章同时写会被后写覆盖。

## [0.3.0] - 2026-10-23

一本书跟着一个工作区走：多工作区不再互相串书，模型路由多了推理档位，从 git 安装终于能用。

### 新增

- **多工作区路径解析**：项目根不再在插件装载时一次性解析，而是每次调用按**会话自己记录的
  `cwd`** 解析（`exec.agent.session.header.cwd`）。同一个 dsh 进程里开两个工作区，两个
  `.novel` 各归各的书；门禁和工具用的是同一个解析结果，所以批准和落笔永远在同一本书上。
  - `perWorkspace`（默认 `true`）：相对 `root` 按会话工作区解析。绝对 `root` 仍然固定为
    一本书，`perWorkspace: false` 可回到 v0.2 的「进程目录那一本」。
  - 找不到项目时的拒绝理由会**带上解析出的目录**，不再是含糊的「还没有项目」。
- **推理档位**（`novel_roles` 的 `reasoningEffort`）：每个角色可设 provider/model/
  maxTokens/reasoningEffort，原样传给子智能体。取值由供应商适配器决定（如 `off`/
  `minimal`/`low`/`medium`/`high`），插件只透传、不校验。
- **三态字段覆盖**：角色路由的每个字段现在是三种状态——不填（继承下一级）、填值（本书钉住）、
  填空（本书显式不设，压住全局默认）。此前「清掉一项」会连累同一角色的其它字段。
- **git 安装可用**：补上 `prepare` 脚本，从 git 托管的仓库安装时会先构建出 `lib/`。
  此前 `files` 只发 `lib/`，而 `prepare` 缺失，git 装上去是一个没有 `lib/` 的空壳。

### 变更

- `perWorkspace` 默认开启。v0.2 的书写在「dsh 进程工作目录」下；如果你的书在别处，
  把 `root` 设成绝对路径，或设 `perWorkspace: false`。
- 清空角色路由的写法改为传空字符串（`maxTokens` 传 `0`）。原来的「什么都不填」语义是
  「删掉整个覆盖」，和三态覆盖冲突。
- 全局 `config.roles` 的字段改为可选：可以只钉 `model`，其余继承。

### 验证

- 125 个用例（v0.2 是 90）。新增：三态合并、会话路径解析、双工作区互不干扰（走真实工具
  和真实门禁）、推理档位透传到 `agentOptions`。
- 真机验证：装进一个**独立的** DSH profile（`dsh plugin --profile inkwell-verify add
  <绝对路径>`），不碰正在使用的 `desktop` profile。

### 仍不做（留给后续）

- 章节级并发写：同一本书同一章同时写会被后写覆盖（账本与章纲仍是单写者模型）。

## [0.2.0] - 2026-10-23

指挥官流水线：从"直写"升级为"沟通 → 派写手 → 审核 → 你点头 → 定稿"。

### 新增

- **角色派发**（`novel_dispatch`）：按角色起子智能体，一次调用带上人格、
  工具白名单（全空=纯文本生成，无工具泄漏）和模型路由。`writer` 出初稿，
  `logic`/`character` 出带证据的 findings，`chief` 裁决汇总。底层走
  `ctx.subagents.start('spawn', …)`，子智能体不共享父会话上下文。
- **按角色配模型**（`novel_roles`）：`list` 看四个角色的解析路由，`set` 给某角色
  设 provider/model/maxTokens，只存进本书 `project.json`，不动全局。未设的角色继承
  当前会话模型。**密钥永远留在 DSH 设置里，插件只记名字。**
- **草稿态**（`novel_chapter propose`/`commit`）：写手的稿子先进 `drafts/`（不进
  chapters），跑确定性体检但**不挡**，留待审核；你点头后 `commit` 才定稿进 chapters。
  原始 `write` 保留，作为绕过流水线的直接落笔。
- **角色定义数据化**：四个角色的 persona、输出契约写在 `src/roles.ts`，新增角色是
  改一段提示词，不用重发预设。
- **门禁覆盖新动作**：`propose` 与 `write` 同等要求（章纲已批准、阶段 drafting）；
  审核类派发要求该章已有草稿，没草稿在 pre-execute 就被拒。

### 验证

- 90 个用例（含一个走完整流水线的端到端，用假 subagents 服务断言派发参数正确）。
- 用真实 Cordis 内核 + subagents 服务挂载，9 个工具全部注册。

### 仍不做（留给后续）

- 侧边栏「小说工坊」入口与项目创建面板（客户端 React 插件）。
- 多工作区时 `.novel` 路径跟着会话工作区解析（v0.1 是相对 dsh 进程）。

## [0.1.0] - 2026-10-23

首个版本：约束内核。

### 新增

- **五阶状态机**（`premise → canon → outline → drafting → review`），每次推进由磁盘
  数据判定，拒绝时逐条列出缺什么。
- **七个工具**：`novel_project`、`novel_canon`、`novel_outline`、`novel_chapter`、
  `novel_ledger`、`novel_briefing`、`novel_check`。
- **预执行门禁**（`tools/pre-execute`）：阶段不符、章纲未批准、章纲缺失的写正文请
  求在工具执行前被拒，不产生副作用。
- **事实账本**：同主体同属性的矛盾断言被拒绝；跨章改动必须用 `supersedes` 显式替换
  旧条目。
- **章纲合同**：必出场角色缺失时正文不保存；视角、字数、节拍覆盖、章末钩子作为提醒。
- **确定性扫描**：8 字片段跨章复读、句首重复、句长离散度、套路词密度、对话占比、
  段落长度、章末形态。全部零 token。
- **预算内上下文包**：章纲、出场角色、上一章结尾、相关事实、前情摘要、待回收线索，
  按优先级装入固定字数预算，并报告哪些被挤掉。
- **项目目录即记忆**：`.novel/` 下纯 JSON + Markdown，跨会话、跨机器可用。
- 全部阈值可经 `cordis.patch.yml` 配置。

### 已知边界

- 节拍覆盖按二元字组估算，是提醒不是判决。
- 无并发写保护：同一项目目录被两个会话同时写会互相覆盖。
- 账本只防同属性取值冲突，不防逻辑矛盾（如同时出现在两地）。

[0.5.1]: https://github.com/The-Architect-Li/-/releases/tag/v0.5.1
[0.5.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.5.0
[0.4.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.4.0
[0.3.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.3.0
[0.2.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.2.0
[0.1.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.1.0
