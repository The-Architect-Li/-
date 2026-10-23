# dsh-inkwell · 墨井

> 给 DeepSeek Harness 的长篇小说约束内核。把「请别写崩」变成「写崩了存不进去」。

写长篇最难的不是写出一段好文字，是写到第 40 万字时还记得第 3 章那只眼睛是什么颜色。模型不会记得，也不会承认自己不记得。**提示词管不住这件事，代码可以。**

墨井不生成文字，它管住生成文字的那双手：阶段闸门、事实账本、章纲合同、复读与套路扫描、预算内上下文包。全部是确定性函数，零 token 消耗。

## 设计原则

**代码强制 > 提示词自律。** 凡是「靠模型自觉」能守住的规则，都会在长跑里失守。所以这里的每条约束都落在一个能被拒绝的位置上：

- 阶段不对，`tools/pre-execute` 直接 deny，工具体根本不执行；
- 章纲没批准，正文写不进去；
- 章纲要求出场的人没在正文里出现，这一章**不保存**；
- 写的事实和账本冲突，这条记录**写不进账本**，除非你指名替换哪一条。

## 三层栈的落地

墨井参考了社区里成熟的做法（novel-forge 的门禁与账本、OpenWrite 的审稿 DAG、memory-evolve 的跨会话记忆、subagent-model 的分任务路由），但把三层压进一个内核里，第一版只做最硬的那层：

| 层 | 常见做法 | 墨井 v0.1 |
|---|---|---|
| ① 谁在写 | 多角色 agent 团队预设 | 暂不做。角色的差异先靠 `voice` 字段落到数据层 |
| ② 怎么不出错 | 门禁 + 事实账本 + 审稿 DAG | **全部做**：五阶状态机、事实账本、章纲合同、五项确定性扫描 |
| ③ 记得住 / 省钱 | 会话记忆 + 分任务选模型 | 项目目录即记忆（跨会话、跨机器）；上下文包按预算装配 |

第 ③ 层有个刻意的选择：**记忆放在项目磁盘上，不放在会话里。** 会话日志是给人复盘看的事件流，不是给模型检索的库；而且换一个会话、换一台机器，设定得还在。

## 安装

```sh
dsh plugin --profile web add dsh-inkwell
```

装完**必须重启 dsh 进程**（客户端 bundle 在启动时快照），硬刷新页面后，会话里就能看到 7 个 `novel_*` 工具。

从源码开发：

```sh
git clone <repo> && cd dsh-inkwell
npm install --legacy-peer-deps
npm run check          # typecheck + test + build
```

## 一条完整的工作流

```text
premise ──→ canon ──→ outline ──→ drafting ──→ review ──→ done
  前提       角色/世界     分卷/章纲      写正文       体检
```

每一步都有关卡，过不去会告诉你差什么：

```text
你：novel_project action="init" title="雾港"
你：novel_project action="premise" premise="一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。"
你：novel_project action="advance"          # 前提不足 80 字会被拒绝，并告诉你还差多少

你：novel_canon action="upsert_character" name="沈砚" role="protagonist" voice="短句，回答前先停顿"
你：novel_canon action="upsert_character" name="阿鸢" role="supporting" voice="语速快，爱用反问"
你：novel_canon action="upsert_world" name="雾港" kind="地点" detail="终年起雾"
你：novel_project action="advance"          # 缺主角、缺 voice 都会被逐条列出

你：novel_outline action="add_volume" number=1 title="入港"
你：novel_outline action="approve_volume" number=1
你：novel_outline action="add_chapter" number=1 pov="沈砚" characters=["沈砚","阿鸢"] \
      beats=["沈砚发现船底藏着尸体","阿鸢承认改过航向"]
你：novel_outline action="approve_chapter" number=1
你：novel_project action="advance"

你：novel_briefing chapter=1                # 拿上下文包，不要自己翻全稿
你：novel_chapter action="write" number=1 text="……"
你：novel_ledger action="record" subject="沈砚" predicate="左眼颜色" value="黑" chapter=1 quote="他的左眼黑得像井"
```

## 七个工具

| 工具 | 作用 | 会拒绝你的情况 |
|---|---|---|
| `novel_project` | 初始化、看状态、写前提、推进阶段 | 前提太短、角色不够、章纲不全 |
| `novel_canon` | 角色卡与世界观 | 缺 name；世界观缺 detail |
| `novel_outline` | 分卷、章纲、批准 | 章纲少于 2 个节拍、引用不存在的角色 |
| `novel_chapter` | write 直接写 / propose 落草稿 / commit 定稿 / read 读 / list 列 | write 漏角色不保存；propose/commit 需已批准章纲 |
| `novel_ledger` | 记事实、查事实、全量体检 | 与已有设定冲突且未指名替换 |
| `novel_briefing` | 预算内装配上下文包 | 不会拒绝，会说「这章还没有章纲」 |
| `novel_check` | 确定性体检（零 token） | 不会拒绝，只报告 |
| `novel_roles` | 查看/设置各角色用的模型 | set 缺 role |
| `novel_dispatch` | 按角色派子智能体（写手/逻辑审核/角色一致性/总审核） | 阶段不对、章纲未批准、审核时无草稿 |

## 小说工坊流水线（v0.2）

v0.2 把"直写"升级成指挥官流水线：主会话就是指挥官，它派子智能体干活，你只裁决最后一道。

```text
你 ⇄ 指挥官（主会话）充分沟通
        ├─ novel_dispatch writer    → 出初稿
        ├─ novel_chapter propose    → 落草稿 + 跑确定性体检（不挡）
        ├─ novel_dispatch logic     → 逻辑审核（带证据）
        ├─ novel_dispatch character → 角色一致性审核
        ├─ novel_dispatch chief     → 总审核裁决分歧
        └─ 你点头 → novel_chapter commit → 才算一章
```

**按角色配模型：** 写手用 GLM、审核用 DeepSeek，随你。`novel_roles set` 把选择存进**这本书**的 `project.json`，不动全局；没设的角色继承当前会话模型。模型密钥永远留在 DSH 设置里，插件只记 provider/model 名字——它不知道你的 key。

设计要点：审核只报告不改正文，全流水线只有写手动笔；确定性体检免费先跑（账本能拦的时间地点冲突不用花 token），模型审核只判代码判不了的（出戏、因果）；草稿和章节是两个状态，没点头不进 chapters。

## 确定性检查都查什么

`novel_check` 与写入时的自动扫描共用一套纯函数：

- **复读**：与前面每一章做 8 字片段重合率比较，超阈值就指出重合的是哪几句；
- **句式**：同一开头（两个字）出现 3 次以上；
- **节奏**：句长离散度太低（长短句太均匀）；
- **套路词**：可配置的词典，按千字密度计；
- **对话占比、段落长度、章末钩子**。

这些是**启发式**，用来定位问题，不替代人判断。它们的价值在于：同样的稿子跑两次结论一样，而且不花钱。

## 配置

改 `cordis.patch.yml` 里 `inkwell` 的 `config`，或写进你自己 profile 的 patch 层：

```yaml
- id: inkwell
  config:
    root: .novel
    premiseMinChars: 80
    chapterMinWords: 1800
    chapterMaxWords: 4200
    briefingBudgetChars: 6000
    repeatShingleSize: 8
    repeatWarnRatio: 0.06
    aiToneWarnPer1000: 2
    aiToneWords: ["仿佛", "似乎", "不禁", "微微", "嘴角勾起"]
```

阈值没有写死在代码里——每个项目对「套路」的定义不一样。

## 它不做什么

- **不续写、不代笔。** 它没有生成文字的模型调用，一个字都不替你写。
- **不判断文学质量。** 「这段好不好」不是确定性函数能回答的，所以它不装作能。
- **不做平台敏感词审核。** 各平台规则不同且常变，硬编码在插件里很快会过期。
- **不带 UI 面板。** v0.1 只有工具，全部能力在对话里可完成。

## 已知边界

- 节拍覆盖率用二元字组估算，是提醒不是判决；它宁可漏报也不误杀。
- 没有并发写保护：同一个项目目录同时被两个会话写会互相覆盖。
- 账本只防「同一属性给出不同值」，不防逻辑矛盾（比如一个人同时出现在两地）。

## 开发

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest，74 个用例，含端到端流程
npm run build       # 产出 lib/
```

架构细节见 [docs/architecture.md](docs/architecture.md)，贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

MIT
