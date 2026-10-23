# 变更日志

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

[0.2.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.2.0
[0.1.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.1.0
