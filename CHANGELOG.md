# 变更日志

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

- 侧边栏「小说工坊」入口与项目创建面板（客户端 React 插件）。
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

[0.3.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.3.0
[0.2.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.2.0
[0.1.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.1.0
