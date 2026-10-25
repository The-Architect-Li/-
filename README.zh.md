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
dsh plugin --profile <你的 profile> add dsh-inkwell
```

装完**必须重启 dsh 进程**（插件在启动时装载），之后会话里就能看到 9 个 `novel_*` 工具。

现在三种装法都通了：

| 装法 | 说明 |
| --- | --- |
| `dsh-inkwell` | 走 npm registry（发布之后） |
| `E:\path\to\checkout` | 本地检出，必须是绝对路径 |
| `git+https://github.com/The-Architect-Li/-.git` | 安装时现场构建，见下 |

从 git 装会走 `prepare` 构建，而 pnpm 默认拦构建脚本。第一次 `add` 会失败并**打印它要的那个键**，把那一行抄进 profile 的 `pnpm-workspace.yaml` 再跑一遍：

```yaml
allowBuilds:
  dsh-inkwell@https://codeload.github.com/The-Architect-Li/-/tar.gz/<commit>: true
```

不放行的话装上去是没有 `lib/` 的空壳。**Desktop 的 profile 归应用自己管**——`dsh plugin --profile desktop` 会被 CLI 拒绝，这是设计如此——要装进桌面版请在应用的插件页里装，它认同样的 spec。

从源码开发：

```sh
git clone <repo> && cd dsh-inkwell
npm install
npm run check          # typecheck + test + build + 打包冒烟
```

## 一本书跟一个工作区走

一个 dsh 进程同时开着几个工作区是常态。墨井的项目根**按会话自己的工作目录解析**，不是按进程目录：

- `root` 是相对路径（默认 `.novel`）时，每个会话在自己的工作区里找书——两个窗口两本书，互不串稿；
- `root` 是绝对路径时，所有会话共用那一本；
- `perWorkspace: false` 回到 v0.2 的「进程目录那一本」。

找不到项目时，拒绝理由会告诉你在**哪个目录**找过，而不是只说「还没有项目」。

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

## 十个工具

| 工具 | 作用 | 会拒绝你的情况 |
|---|---|---|
| `novel_project` | 初始化、看状态、写前提、推进阶段；books 列书、open 换书、close 回来 | 前提太短、角色不够、章纲不全；open 找不到那本书 |
| `novel_canon` | 角色卡与世界观 | 缺 name；世界观缺 detail |
| `novel_outline` | 分卷、章纲、批准 | 章纲少于 2 个节拍、引用不存在的角色 |
| `novel_chapter` | write / propose / commit / restore 回退 / read / list / review 审稿结案 | write 漏角色不保存；版本对不上要你重读；waived 不写理由 |
| `novel_ledger` | 记事实、查事实、全量体检 | 与已有设定冲突且未指名替换 |
| `novel_briefing` | 预算内装配上下文包 | 不会拒绝，会说「这章还没有章纲」 |
| `novel_check` | 确定性体检（零 token） | 不会拒绝，只报告 |
| `novel_roles` | 查看/设置各角色用的模型与推理档位 | set 缺 role |
| `novel_dispatch` | 按角色派子智能体（写手/逻辑审核/角色一致性/总审核） | 阶段不对、章纲未批准、审核时无草稿 |
| `novel_export` | 导出整本 txt / 按卷 markdown / 设定集 | 还没有落盘的正文 |

## 小说工坊流水线（v0.2）

v0.2 把"直写"升级成指挥官流水线：主会话就是指挥官，它派子智能体干活，你只裁决最后一道。

```text
你 ⇄ 指挥官（主会话）充分沟通
        ├─ novel_dispatch writer    → 出初稿
        ├─ novel_chapter propose    → 落草稿 + 跑确定性体检（不挡）
        ├─ novel_dispatch logic     → 逻辑审核（意见落进 reviews/，每条有 id）
        ├─ novel_dispatch character → 角色一致性审核
        ├─ novel_dispatch chief     → 总审核裁决分歧
        ├─ novel_chapter review     → 逐条结案：fixed 已改 / waived 认了（写理由）
        └─ 你点头 → novel_chapter commit → 才算一章
```

**审稿意见不再只活在聊天里。** 每一轮审核都写进 `<项目>/reviews/<章号>.json`：谁提的、哪个模型、审的是第几轮草稿、每条意见的 id 与状态。`novel_chapter action="review" number=1` 是不带 id 的看板，`✓` 已改、`—` 不改、空格未结。

**两处同时改一章不会再互相覆盖。** 每次落盘 `revision` 加一；`write` / `restore` 要求带上你读到的那一版，对不上就拒绝并告诉你是第几版对第几版（确实要覆盖传 `force=true`）。面板编辑页同样带版本号，冲突返回 409。草稿轮次可以用 `restore` 回退。

**对话里也能换书。** `novel_project action="books"` 看这台机器上记得的书，`action="open" root="E:\书\雾港"`（或 `book="雾港"`）把当前会话钉到那本书，`action="close"` 回会话自己的工作目录。钉选按会话记住，后续工具调用照旧生效。

**写完能交出去。** `novel_export action="text"` 整本 txt、`action="markdown"` 按卷分文件、`action="canon"` 设定集（人物 / 世界观 / 分卷 / 章纲 / 仍然成立的事实表），默认写进 `<项目>/exports/`。

**按角色配模型：** 写手用 GLM、审核用 DeepSeek，随你。`novel_roles set` 把选择存进**这本书**的 `project.json`，不动全局；没设的角色继承当前会话模型。模型密钥永远留在 DSH 设置里，插件只记 provider/model 名字——它不知道你的 key。

每个角色还能单独钉 `reasoningEffort`（推理档位）。取值由供应商适配器决定，插件只透传不校验：

```text
novel_roles action="set" role="writer" provider="zai" model="glm-4.6" reasoningEffort="high"
novel_roles action="set" role="logic"  reasoningEffort="low"     # 只改这一项，模型照旧
novel_roles action="set" role="writer" reasoningEffort=""        # 空字符串 = 本书这一项显式不设
```

最后那行是「三态覆盖」：不填 = 继承下一级，填值 = 本书钉住，填空 = 本书明确不要（压住全局默认）。清掉一项不会顺手把同角色的其他字段一起抹掉。

设计要点：审核只报告不改正文，全流水线只有写手动笔；确定性体检免费先跑（账本能拦的时间地点冲突不用花 token），模型审核只判代码判不了的（出戏、因果）；草稿和章节是两个状态，没点头不进 chapters。

## 右侧栏的小说工坊（v0.4 仪表盘 → v0.5 抽屉树 + 建书 → v0.6 团队与模型 → v0.7 详情页 → v0.8 就地编辑 → v0.9 书库）

面板挂在 Web 界面右侧 Sidebar 里，作为一个 tab 类型（`ctx.sidebarRightTabs.register`），不是另开一列——右侧只有一条栏，抢占位置会把整栏挤走。

打开面板先落地在**书库**：这台机器上 dsh 写过的书都在这里，点进一本才是那本书的抽屉树。

```text
▤ 小说工坊                      ＋ 新建   刷新
已有的书 2 本
▤ 雾港                写正文 · 3 章 · 6,380 字        [当前]
  E:\dshplugin\.novel
▤ 旧稿                前提 · 0 章 · 0 字
  D:\ novels\旧稿\.novel
⚙ 设置                                   智能体团队
```

点进去之后：

```text
←  ▤ 雾港  写正文
◎ 世界观       7
◍ 人物设计     12
    概览
    主角       1
    主要配角   3
    次要配角   8
    路人       0
◷ 剧情设计     223
    全书故事线   [故事线]
    剧情点     128
    伏笔总览   2
    章卡       94
✎ 正文         94
    第一卷     94 章
        第1章 裂缝     [已完成]  3200 字
        第2章 金童玉女  [已完成]  2950 字
        第3章 潮声      [可写]
```

- **书库**（v0.9）：落地页是书，不是抽屉。每行给出书名、阶段、章数、字数与目录；`当前` 是当前会话解析出的那本，`上次` 是本次浏览器最后打开的那本。左上角 `←` 随时回到书库。
- **书从三处来**：`?root=` 指定的、会话工作区解析出的、以及书架记着的（`$DSH_HOME/inkwell/books.json`，只存路径与时间，最近 40 条）。三处都要过一遍磁盘，删掉或搬走的书不会出现在列表里——书架是提示，不是承诺。
- **抽屉**：世界观／人物设计／剧情设计／正文，各自带计数、可折叠、可选中；长列表截断到 25 行并补「还有 N 条」，300 章的书不会变成一堵墙。
- **打开即折叠**（v0.7）：四个抽屉初始收起，面板一打开是目录而不是九十四章；折叠状态在面板会话内保留。
- **点开就是那一页**（v0.7）：点「沈砚」，整个侧边栏换成人物的页面（说话方式／外貌／目标／秘密／出场章节／账本里的事实）；点设定条目、章节也一样。分组行（主角、第N卷）点击即展开收起。
- **就在那一页改**（v0.8）：角色页与设定页点「编辑」进输入态，章节页有「预览正文／改正文」两态——正文按段落预览（首行缩进 2em），改的时候输入框下方实时显示去空白字数。保存走 `POST /entry`，落盘的仍是同一批文件；随手在聊天窗口说「把沈砚的目标改成把妹妹带回岸上」也能改同一处，两条路不会各写一份。
- **改不动会说为什么**（v0.8）：章纲没批准时，章节页直接把闸门那句话放在页面上（「第4章的章纲还没批准…」）；正文里漏了必写人物时，保存返回 409 并列出缺谁。面板不比工具宽松，也不比工具啰嗦。
- **进度就是状态**：每章标 `已完成`（定稿）、`N 稿`（有草稿未定稿）、`可写`（章纲已批准）、`未写`。
- **能建书。** 书库页与树头都有「新建」：点「选择目录…」开系统目录选择框（`ctx.uiWorkspace.pickDirectory()`），也可以逐层点面板里的目录浏览器（Windows 上可切盘符）。建书与 `novel_project action="init"` 走同一个 `ProjectStore.init`，两条路字节相同；建完直接进那本书，也顺势进书库列表。
- **不含糊。** 目录里已经有书就报「已经有《…》」并给「打开这本书」，不覆盖；相对路径一律 400，绝不让宿主进程的 cwd 替用户猜。
- **零 token。** 快照由 `src/panel/model.ts`、页面由 `src/panel/entry.ts`、书库行由 `src/panel/library.ts` 从磁盘数据算得，不调模型。
- **跟着会话走。** `perWorkspace` 开启时，面板按会话 `cwd` 定位书；切会话就换书。
- **可以没有。** 路由经 `ctx.inject(['webServer'])` 挂载，headless profile 里没有 web 服务，插件照样装载 9 个工具，只是没有面板。

宿主侧接口：

```text
GET  /api/inkwell                      # 进程那一本
GET  /api/inkwell?session=<id>          # 该会话工作区里的那一本
GET  /api/inkwell/snapshot?root=<绝对路径>  # 指定的那一本
GET  /api/inkwell/books                 # 书库：这台机器上已有的书（当前会话那本标 current）
GET  /api/inkwell/dirs?path=<绝对路径>      # 列一层子目录、盘符，并回报该目录里有没有书
POST /api/inkwell/init                  # { dir, title?, targetWords? } 建书
GET  /api/inkwell/entry?kind=&key=      # 一行背后的那一页：character／world／chapter
POST /api/inkwell/entry                 # { kind, key, fields } 改角色／设定／章节正文
GET  /api/inkwell/roles                 # 四个智能体的当前路由 + 可选接口/模型/思考档位
POST /api/inkwell/roles                 # { role, provider?, model?, reasoningEffort?, maxTokens?, reset? }
```

`/snapshot`、`/books`、`/dirs`、`/entry`、`/roles` 的读法只认 GET，非 GET 一律 405；写有三扇门：`/init` 建书、`/roles` 选模型、`/entry` 改一条已存在的条目，且都必须带 `x-dsh-plugin: inkwell` 头——简单表单跨站提交带不上这个头。推进阶段、批准章纲、定稿、记账本事实仍然只有工具能做：「谁能改」还是那一个门禁。已经不存在的东西 `/entry` 返回 404 而不是空白页：挂着一张旧树时，该被告知刷新。

### 设置 → 智能体团队（v0.6）

抽屉树底部有一行通栏的「⚙ 设置」（v0.6.1 从书头右上角的图标搬下来的：一个孤零零的齿轮太容易被漏掉）。点进去，第一个入口是智能体团队：四个角色各一张卡，写清它只做什么、现在跑在哪条路由上、这条路由来自哪一层。

```text
◍ 智能体团队
  指挥官       [会话模型]   和你对话的那个模型，不在这里配
  写手         [本书指定]   deepseek-official/deepseek-flash          还原
      接口  [deepseek-official ▾]   模型  [deepseek-flash ▾]   思考 [默认（medium）▾]
  逻辑审       [全局默认]   zai/glm-4
  角色审       [跟随会话]   继承当前会话模型
  裁决         [跟随会话]   继承当前会话模型
```

- **挑的是你真配过的。** 接口与模型清单来自宿主的 `llm` 服务（`listProviders` / `listModels` / `resolveModelInfo`），不是插件自带的静态表；60 秒缓存，某个 provider 元数据拿不到时只是不列思考档位，不会卡住整页。
- **思考强度跟着模型走。** 模型的适配器报了什么档位就只列什么档位，默认项显示它的 `defaultEffort`。
- **面板与工具是同一份存储。** 面板写的是 `project.json` 的 `roles`，`novel_roles action="list"` 立刻看得到，下一次 `novel_dispatch` 立刻按新路由派活；「还原」清掉本书覆写，回落到全局默认。
- **三层来源说清楚。** `本书指定` > `全局默认`（插件配置里的 `roles`）> `跟随会话`（继承父会话模型）。面板只改第一层。

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
    perWorkspace: true          # 相对 root 按会话工作区解析；false 回到进程目录
    premiseMinChars: 80
    chapterMinWords: 1800
    chapterMaxWords: 4200
    briefingBudgetChars: 6000
    repeatShingleSize: 8
    repeatWarnRatio: 0.06
    aiToneWarnPer1000: 2
    aiToneWords: ["仿佛", "似乎", "不禁", "微微", "嘴角勾起"]
    roles:                      # 全局默认；每本书可用 novel_roles 覆盖
      writer: { provider: zai, model: glm-4.6, reasoningEffort: high }
```

阈值没有写死在代码里——每个项目对「套路」的定义不一样。

## 它不做什么

- **不续写、不代笔。** 插件自己没有生成文字的模型调用，一个字都不替你写（`novel_dispatch` 派出去的是子智能体，不是本插件）。
- **不判断文学质量。** 「这段好不好」不是确定性函数能回答的，所以它不装作能。
- **不做平台敏感词审核。** 各平台规则不同且常变，硬编码在插件里很快会过期。
- **面板只开三扇写门。** 右侧栏能选目录建一本新书（与 `novel_project action="init"` 等价），能给四个智能体挑模型（与 `novel_roles action="set"` 等价），能改已经存在的角色卡、设定条目和章节正文（与 `novel_canon`、`novel_chapter action="write"` 同一段落盘代码）。推进阶段、批准章纲、定稿、记账本事实仍然只有工具能做。
- **不替你选默认模型。** 团队页只列你已经在 dsh 里配好的接口与模型；没配就先配，插件不塞一份自己的清单。

## 已知边界

- 节拍覆盖率用二元字组估算，是提醒不是判决；它宁可漏报也不误杀。
- 章节版本是「一文件一版本」，不是字段级合并：两人同时改同一章的不同段落，仍会有一方收到冲突（409 或工具拒绝），改完重贴即可。
- 账本只防「同一属性给出不同值」，不防逻辑矛盾（比如一个人同时出现在两地）。
- 面板建书要一个「容器目录」：书建在 `<所选目录>/.novel` 下。若插件的 `root` 被配成绝对路径，面板拒绝建书并提示改用工具——那时全书只有一个位置，面板不该替它猜。
- 导出没有 docx / pdf；要 Word 就把 markdown 或 txt 转过去。
- 换书记在会话上：同一个会话只能看一本，两个会话可以各看各的。

## 开发

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest，296 个用例，含端到端流程、双工作区隔离、面板投影／书库／建书／详情页／就地编辑／团队路由、审稿落盘与章节版本冲突、换书与导出
npm run build       # 产出 lib/
npm run verify      # 冒烟：用假上下文挂载构建产物，确认 10 个工具都注册了、入口形状能被装载器接受
npm run check       # 以上全部
```

架构细节见 [docs/architecture.md](docs/architecture.md)，贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

MIT
