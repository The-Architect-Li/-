# 变更日志

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

[0.1.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.1.0
