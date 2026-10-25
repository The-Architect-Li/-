# 交接文档 · dsh-inkwell

> 给下一位接手的人（或下一次会话）一份能冷启动的完整说明。
> 最后更新：2026-10-25，对应 release v0.15.0。

## 一句话

dsh-inkwell（墨井）是 DeepSeek Harness 的长篇小说插件。它**不替你写**，而是管住写的那双手：阶段闸门、事实账本、章纲合同、确定性扫描、预算内上下文包，外加一套指挥官流水线（v0.2）、按会话解析的项目根（v0.3）、右侧栏的小说工坊面板（v0.4）、面板里的抽屉树 + 选目录建书（v0.5）、面板里的智能体团队与模型选择（v0.6）、抽屉里点开即看的人物／设定／章节详情页（v0.7）、可随手编辑的二级页面（v0.8）、先看书再进书的那层书库（v0.9）、会回应的鼠标悬停与键盘操作（v0.9.2）和把审稿意见、章节版本、换书与导出都落到磁盘上的那一层（v0.10），以及「点一下新建就落在自己的新工作区里」的那一步（v0.11），和把已经写了的稿子扫一遍导进来的那一层（v0.12）。原则是**代码强制 > 提示词自律**——靠模型自觉守的规则，写到 40 万字一定失守。

## 仓库现状

- 地址：https://github.com/The-Architect-Li/- （仓库名是 `-`，可改名）
- 默认分支：`main`
- 已发 tag：`v0.1.0`（约束内核）、`v0.2.0`（指挥官流水线）、`v0.3.0`（多工作区 + 推理档位 + 可安装）、`v0.4.0`（小说工坊面板）、`v0.5.0`（抽屉树 + 面板建书）、`v0.5.1`（三条安装通道打通）、`v0.6.0`（面板里的智能体团队与模型选择）、`v0.6.1`（设置入口搬到抽屉树底部）、`v0.7.0`（详情页 + 打开即折叠）、`v0.8.0`（二级页就地编辑 + 章节预览）、`v0.9.0`（书库）、`v0.9.1`（点一行真的会开页）、`v0.9.2`（悬停／聚焦／键盘都看得见）、`v0.10.0`（审稿落盘、章节版本锁与回退、对话里换书、导出）、`v0.11.0`（面板新建一步到位：选目录、建书、注册工作区、新开会话）、`v0.12.0`（把已有稿件扫一遍导进来：正文 / 人物 / 大纲）、`v0.12.1`（导入的材料不再被下一次编辑吃掉）、`v0.13.0`（面板重做外观：设计令牌、字号层级、详情页分块、`npm run preview`）、`v0.14.0`（剧情设计收成四行：地点历史、故事点边界、时间线会算）、`v0.15.0`（书库里的「导入…」：一个文件夹一次读成书，md 与 txt 都认）
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
- **`ToolDeps` 不再持有 store**，改为 `storeFor(exec)`。十三个工具与门禁用同一份解析结果，杜绝「在这本批准、往那本写」。
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

### v0.9.2 让手看得见：悬停、聚焦、按得动

- **为什么之前一片死气**：面板所有样式都是 React 的 inline style，而 inline style 表达不了 `:hover` / `:active` / `:focus-visible`。于是按钮、抽屉行、书架上的书、输入框看起来都不可点。
- **`client.js` 里的 `CSS` + `ensureStyles()`**：一张真正的 `<style>`，`id='dsh-inkwell-styles'` 去重，`document.head` 里插一次；`InkwellBody` 首个 `useEffect` 与 `apply(ctx)` 各调一次（`typeof document === 'undefined'` 直接返回，测试环境安全）。所有颜色走 `color-mix(in srgb, currentColor N%, transparent)`，深浅主题自动跟随。
- **状态表**：行 10%／按下 15%／选中 15%（选中后悬停不再变暗）；按钮 10% + 边框 38%，主按钮 12%→22%；输入框与下拉框悬停 34%、聚焦 52% + 光环；书架行、设置行（悬停 `padding-left` 14px 的位移）、展开箭头、智能体卡片都有各自的一档。`prefers-reduced-motion` 下全部关掉。
- **关键手法：边框必须从 inline 挪到 CSS**。inline 的 `border` 会一直盖住 `.iw-input:hover` 想写的 `border-color` —— 这类「样式写了没生效」的 bug 用眼睛看不出来，只能靠「谁是最后一条声明」推理。
- **键盘与读屏**：行与抽屉头 `role="button"`、`tabIndex: 0`、`aria-pressed` / `aria-expanded`，Enter 与 Space 等价点击（Space 会 `preventDefault` 免得侧边栏跟着滚）。
- **验证**：259 个用例（19 个文件；新增 3 条 `test/client.test.ts`：类名与 `role`/`tabIndex`、Enter 与 Space、抽屉头 `iw-open` + `aria-expanded`）。`client bundle : ./client.js 76781 bytes`；真机组合 bundle 466,429 字节里 `iw-row:hover`／`iw-glyph`／`iw-open`／`iw-card`／`prefers-reduced-motion` 都在。

### v0.9.1 点一行真的会开页

- **修掉的 bug**：v0.7 起详情页可以用，但抽屉树渲染时传的是旧的 `onSelect: setSelected`，行能画出来、能高亮，`/entry` 一次都没被请求过。现在树／抽屉／行三层共用同一个 `onRowClick`，由它一处判断「代表一个东西就开页，否则展开或选中」。
- **`test/client.test.ts`**（新增 3 例）：假 `__ModuleLoader__` + 桩 `React.createElement`（`Row` 不用 hooks，所以不需要 DOM）真的加载 `client.js`，拿到 `exports.tree.Row` 渲染后调 `props.onClick`，断言到达开页回调；另有纯分组行与「展开箭头不误触」两例。**教训**：之前的验证停在「服务端返回了什么」「bundle 里有没有这段字符串」——字符串在、活没接，这一层只有真点一下才看得见。

### v0.9 书库：先有书，再有一本书

- **落地页换成书库**：`GET /api/inkwell/books` 返回这台机器上已有的书；点一本才进抽屉树，树的左上角 `←` 回书库，设置页的返回也回书库。
- **`src/panel/library.ts`**（纯函数 + 一次读写）：`MAX_SHELF=40`；`dshHome()` = `$DSH_HOME` 或 `~/.dsh`；`libraryFile()` = `<dshHome>/inkwell/books.json`；`readShelf` 容错（缺文件／坏 JSON／裸数组／脏条目／同一书的两种拼写，都只取第一条）；`writeShelf` 建目录并截断；`rememberBook` **只在书不在第一位时才写盘**（快照路由 15 秒轮询一次，每次都写就是拿磁盘换零信息）；`describeBook(store)` 验明一个根是不是书。
- **`readLibrary(deps, sessionId, root?)`**：三处并集——`?root=` 指定的、会话解析出的、书架记着的——每一处都 `describeBook` 过一遍磁盘。**书架是提示，不是承诺**：目录删了就不出现（有测试专门删目录再问）。
- **`client.js`**：新增 `Library` 组件（整行可点、`当前`／`上次` chip、路径单行省略）与 `view='library'` 落地；`lastRoot` 记在 `sessionStorage` 的 `inkwell.root.<sessionId>`，只用于打 `上次` 标，不再决定看见什么；`returnTo` 让「新建」取消后回到来的那一层。
- **验证**：253 个用例（18 个文件；新增 `test/library.test.ts` 12 例、`/books` 路由 3 例）。真机（隔离 profile `inkwell-verify`）：`GET /books` → `雾港（drafting · 3 章 · 6380 字 · current）`；`POST /books` 无头 403 且非 GET 405；面板建的「第二本」当场进书架；组合 bundle 459,223 字节含 `function Library`／`已有的书`／`api/inkwell/books`／`回到书库`／`上次`。

### v0.10 用得久了才会暴露的四件事

用户原话（m05716）：「3. 审核结论会直接消失……应当写入磁盘：谁提出的、哪一条、有没有改。4. 两处同时改同一章会互相覆盖……应当做乐观锁（写时带 revision，冲突 409 让人刷新）。草稿轮次已有历史，但没有回退入口。5. 对话里换不了书……一个会话只能看一本书。6. 写完交不出去。没有导出。」

- **审稿意见落盘**：`src/domain/store.ts` 新增 `reviews(n)` / `appendReview(n, input)` / `setReviewState(n, id, state, note)`，文件是 `<项目>/reviews/<三位章号>.json`（`{version:1, rounds:[…]}`）。`ReviewItem` 带 `id`（`001-r1-1` = 章号三位-轮次-序号）、`severity`、`code`、`message`、`evidence`、`state: 'open' | 'fixed' | 'waived'`、`note`、`at`；`ReviewRound` 记 `round`（当时审的第几轮草稿）、`at`、`role`、`model`、`items`。`novel_dispatch` 的 logic/character/chief 三个分支都会 `appendReview`，报告里列出每条 id；`novel_chapter action="review"` 不带 id 是看板，带 id + `state="fixed"|"waived"` 结案（`waived` 必须带 `note`，否则报「半年后你会想知道」）。面板的章节页把未结条数写进 `lists`。
- **章节乐观锁**：`ChapterMeta` 多 `revision: number`，`chapters()` 读老文件时按 1 处理；`writeChapter(draft, { baseRevision })` 在版本不匹配时抛 `ChapterConflictError`（`readonly current: number`，消息含「你基于第 X 版，磁盘上现在是第 Y 版」）。工具侧 `novel_chapter action="write"` 与 `restore` 都要求带 `revision`（章节已存在却没带就抛「这次没有说基于哪一版」），`force=true` 才能强写；面板编辑页回传 `edit.revision`，冲突返回 409。`commitDraft` 也要 `baseRevision`。
- **回退入口**：`novel_chapter action="restore" number=N round=R [revision=…]` 把第 R 轮草稿写回正文（版本照常 +1，历史不删）；`force` 可跳过版本校验。
- **对话里换书**：`src/domain/home.ts`（`dshHome` / `inkwellStateDir` / `bookKey`）+ `src/domain/session-books.ts`（`sessionsFile()` = `<state>/sessions.json`、`readPins` / `pinBook` / `unpinBook` / `pinnedRoot` / `livePins` / `sameBook`，**全同步读写**——`storeFor` 在工具体与门禁里同步调用，不能 await）。`novel_project` 新增 `books` / `open` / `close`（`open` 接受 `root` 或书名片段 `book`，先试目录本身再试它的 `.novel`；成功就 `pinBook` 并把书 `rememberBook` 上书架）。`src/tools/deps.ts` 的 `storeFor` 顺序改为 pin > per-workspace cwd > baseStore。门禁里 `books/open/close` 无条件放行（注释：切书工具就是给指错地方的人用的）。
- **导出**：`src/domain/export.ts`（纯函数：`safeFileName`、`chapterHeading`、`bookText`、`volumeFiles`、`canonMarkdown`、`contentsMarkdown`）+ `src/tools/export.ts`（`novel_export action="text"|"markdown"|"canon"`，`out` 缺省写 `<项目>/exports/`）。修掉两个真 bug：设定集的事实表原先筛反了（留下被推翻的旧事实）；空书会写出只含书名的文件。
- **命名迁移**：`src/panel/library.ts` → `src/domain/shelf.ts`（工具侧也要读书架）；`dshHome()` / `bookKey()` 提到 `src/domain/home.ts`。
- **验证**：296 个用例（22 个文件；新增 `test/reviews.test.ts` 12 例、`test/switching.test.ts` 11 例、`test/export.test.ts` 14 例，其余为既有用例的适配）。其中一条专门守「v0.9 写的章节没有 `revision` 字段」：老章节读作第 1 版而不是第 0 版，面板回传的 1 能被接受——否则每一本旧书的编辑都会被「revision 必须是正整数」挡回去。

### v0.11 点一下新建，就落在自己的新工作区里

用户原话（m06653）：「打开小说工坊不是有新建吗，新建点一下就会弹窗让你选择本地目录，然后你选择了一个文件夹，确定后小说工坊就会出现一个新书，并且左边侧边栏的工作区会自动以你一开始新建书籍的文件夹作为工作区，并且新开一个聊天窗口……在这个工作区下的会话是互通的，跨工作区的是不互通的。」

- **弹窗代替目录浏览器**：`client.js` 新增 `CreateDialog`（`.iw-backdrop` 遮罩 + `.iw-dialog` 卡片，书名默认取文件夹名，Enter 提交、Esc 取消、点遮罩取消）。点「＋ 新建」先调 `ctx.get('uiWorkspace').pickDirectory()`（宿主自己的原生选择框）；只有在宿主没有选择器时才回退到面板内的 `view === 'new'` 目录浏览页。`hostCanPick()` 把「没有选择器」和「用户取消」分开——取消不该把用户推进另一个页面。
- **建完换工作区、换会话**：`openBookWorkspace(dir, root)` 依次 `workspaces.create({ path: dir })`（幂等）→ `ui.connectWorkspace(workspaceId)` 拿到 session id → `POST /api/inkwell/pin` 写 pin → `sessionStorage` 记一下面板自己的 root → `ui.openSession(sessionId)`。
  - **`openSession` 收的是 `SessionTarget = SessionId | SubagentAddress`**，直接传 id，传 `{ sessionId }` 是错的（我第一版就写错了，宿主自己的调用是 `uiWorkspace.openSession(sessionId)`，见 `dsh-client-ui-workspace/lib/client.js:4164`）。
  - 服务名依据：`dsh-api-workspace-controller/lib/client.js` 里 `super(ctx, "workspaces")`，`dsh-client-ui-workspace/lib/client.js` 里 `super(ctx, "uiWorkspace")`。
  - `openSession` 前必须先把 pin 写盘：面板随宿主切视图就挂起来了，pin 晚了会读到旧书。
- **`POST /api/inkwell/pin`**（`src/panel/serve.ts` 的 `pinSession`）：`{ session, root }`，root 必须绝对（相对 400）、目录里必须有 `project.json`（否则 404「这里没有书」）；成功后 `pinBook` + `rememberBook`。和 `novel_project action="open"` 写的是同一个 `sessions.json`。
- **面板的 `storeFor` 补上 pin 这一层**（真 bug）：此前只有 `src/tools/deps.ts` 读 pin，面板路由不读，同一个会话在工具和面板里可能指向不同的书。现在两边同为 `显式 root > 会话 pin > perWorkspace 下的 cwd > baseStore`。
- **`perWorkspace` 默认改为 `true`**：一本书跟一个工作区走，跨工作区不串。想回到「全进程一本书」显式写 `perWorkspace: false`。
- **验证**：303 个用例（23 个文件；新增 `test/pin.test.ts` 7 例，其中 `makes the panel read the pinned book for that session` 是上面那条 bug 的回归）。真机（隔离 profile，端口 19415）：`POST /init` → `POST /pin` → `GET /snapshot?session=probe-session` 不带 root 也返回那本书；无头写 403、相对 root 400；组合 bundle 480,500 字节，含 `CreateDialog` / `openBookWorkspace` / `api/inkwell/pin` / `iw-dialog` / `hostCanPick` / `创建并开始写`。另核对了 shell 预载的 65 个客户端模块里有 `@deepseek-ai/dsh-client-ui-workspace/client.js` 与 `@deepseek-ai/dsh-api-workspace-controller/client.js`，即 `workspaces` / `uiWorkspace` 两个服务在页面里确实存在。
- **没验到的**：浏览器那半（真实点击 → 原生选择框 → 切工作区）在无头环境点不了，要用户在自己的 Desktop 应用里重启插件后实测。

### v0.12 把已经写了的稿子拿进来

用户把插件装进自己的 Desktop 应用、点通了「新建」之后问「你觉得接下来应该怎么做」，然后在一串选项里
选了「导入正文 + 人物 + 大纲」（m07205）。他手上那本别的工具写的书在
`C:\Users\china\Documents\小说\待定v2`：86 个 `正文/第N章-标题-v1.md`、6 个 `人物/姓名.md`
（`## 外在底色` / `## 隐性欲望` / `## 心理阈值` / `## 关系网`）、`大纲/全书大纲.md`（`> 一句话立意` /
`> 主角：王上（24→32岁，…）` / `## 卷一·翻身（第1–11章…）` + `**核心**：…` / `- 第1章 裂缝：一句话`）、
`账本/facts.json`、`设定/语言基因.json`。**不动 `novel.json` 与 `账本/facts.json`** —— 账本要的是
「这句设定出自第几章的哪句话」，事后补不算数。

- **`src/domain/import-scan.ts`（纯函数，不碰磁盘）**：`chapterNumberOf` / `chapterTitleOf`（认全角数字、
  认 `-v1` 后缀）、`planChapters`（按号排序、同号取更长的、剥掉与文件名重复的 `# 第N章` 标题、没写章号的
  进 `ignored`）、`planCast`（按小节关键字分派到 `voice` / `appearance` / `goal` / `secret`，认不出的原样
  进 `card.notes`）、`planOutline`（前提 / 主角 / 分卷 / 章纲）、`planImport`（把三者拼成一份可写的计划）。
- **`src/domain/manuscript.ts`**：真正读盘的 `readManuscript(dir)`（`正文/` 或 `chapters/`、`人物/` 或
  `canon/`、`大纲/全书大纲.md`，都没有时退一层读该目录本身）+ `summarize` + `describeScan`（人话报告）
  + `wordsText`。
- **`src/domain/import-apply.ts`**：`applyImport` 用 `store.writeChapter`（带 `baseRevision`）/
  `upsertCharacter` / `upsertVolume` / `upsertPlan` / `writeProject` 落盘，返回 `written` / `skipped` /
  `words` / `cast` / `volumes` / `plans`。
- **`src/tools/import.ts`**：第 11 个工具 `novel_import`，`action ∈ {scan, apply}`，参数
  `dir`（绝对路径）/ `overwrite`。`scan` 不需要书先存在（`src/gate.ts` 放行），`apply` 要。
- **面板**：`GET /api/inkwell/scan?dir=` 与 `POST /api/inkwell/import?root=`；`CreateDialog` 选完目录
  顺手扫一遍，有稿就多一个默认勾上的「建好之后把这些稿件导进来（N 章正文、M 张角色卡、K 卷大纲）」，
  建完即导。客户端 `apiScan` / `apiImport` / `importNote` / `scanNote` 负责文案。
- **两个真 bug（都是拿用户那份真稿子跑出来的，测试里没有）**：
  1. `> 主角：王上（24→32岁，由写字楼底层小职员爬到「上势」老板）` —— 先按 `、，,，/|` 切再剥括号，
     括号里的全角逗号把名字切成「王上（24→32岁」和「由写字楼…老板）」，一个都不等 `王上`，
     于是**所有角色都落成 supporting**。改成先剥括号再切（`src/domain/import-scan.ts` 的
     `planOutline`），并加了回归用例 `reads a lead whose bracket holds a comma`。
  2. 人物稿里没有「说话方式」那一节 —— 6 张卡的 `voice` 全空，而 `src/domain/phase.ts` 的闸门要求
     `every(item => item.voice.trim() !== '')` 才能推进到 outline。补了 `ScanSummary.voiceless` 与报告
     里那句「说话方式还空着：…（N 张卡）……补齐才能推进到「大纲」阶段，闸门会拦」。**故意不替用户编
     voice**：按名字猜一口腔调正是这个插件要防的事。
- **真机验证**（隔离 profile `inkwell-verify`，端口 19422，`package.json` 依赖改成
  `file:E:/dshplugin` 以便永远跑工作副本）：对用户真稿子 `scan` 得 85 章 / 351,401 字 / 6 卡 / 6 卷 /
  83 条章纲 / 冲突 3 章（那本书自己已有 1–3 章），`apply` 用 919ms 写入 85 章，回读
  `chapters/index.json` 得 85 条（`{number:1,title:"裂缝",words:2230,summary:"窗外，天边泛起一线灰白…",revision:1}`），
  `canon/characters.json` 里 `王上=protagonist`、其余 supporting，`notes` 收着关系网。再导一次
  `written:0, skipped:2`（幂等）。
- **v0.12.1（当天补的）**：`notes` 差点被下一次编辑吃掉。面板的角色编辑与 `novel_canon` 都是
  **整张卡替换**，只写自己被告知的字段——作者在面板上改一次说话方式，导入的关系网就静默消失，
  看起来还像改成功了。两处都改成显式接住（面板 `notes: edit.notes ?? existing.notes`，
  空字符串仍可用于清空；`novel_canon` 不带 `notes` 时沿用旧值），角色页把 `notes` 当「其他材料」
  显示并可编辑。教训写在这里是因为它还会再来：**这仓库里任何「整卡/整条目替换」的地方，新增字段
  都必须去接一遍**，`test/notes.test.ts` 的六条用例（走 HTTP + 真 store）就是照着这个形状写的。
- **验证**：395 个用例（31 文件），`npm run check` 全绿；`verify` 报 `tools registered : 13`
  与 `client bundle : ./client.js 101760 bytes`。

### v0.13 面板重做外观：先把样式看见，再谈好看

用户用了两天后的原话是「我觉得UI界面太丑了 能不能搞好看一点 有点设计感 然后要易读啊」（m08359）。
之前面板只有内联样式：`fontSize` 全写死在组件里（正文 12px、注脚 10.5px）、`opacity` 当灰阶、
没有 `:hover`——因为内联样式写不了伪类，所以整块面板没有任何手感想。

- **诊断先落到证据上**：`client.js` 用的是手写 `__ModuleLoader__` 外壳（`window.__ModuleLoader__.load({ id, factory })`，
  不是 `define`），所以没法用现成工具渲染。新建 `scripts/preview-panel.mjs`：正则抽出 `const CSS`、用括号配平抽出
  `const S`，用桩 `React`（`useState` 返回初值、effect 不跑）加载真实组件，把真实的 `Section`/`Row` 与真实的
  `S` 值渲染成 `preview/*.html`，再用无头 Edge 截图看。**这一步是本轮的关键**：不看见就没法判断，
  而且改完还能再看一次。
- **令牌层**：`--iw-fg` / `--iw-fg-2`（80%）/ `--iw-fg-3`（62%）、`--iw-line` / `--iw-line-strong`、
  `--iw-surface*`、`--iw-bar`、`--iw-field`、`--iw-accent`（浅色 `#33628f`，深色 `#8ab4e8`）全部由
  `CanvasText`/`Canvas` 混出；`@media (prefers-color-scheme: dark)` 只覆盖颜色，不动排版。
- **字号与行高**：正文 13px/1.6、行 29px、抽屉头 13.5px/600、书名 14px/650、详情标题 15.5px/600、
  正文页衬线 14.5px/1.95 + 首行缩进 2em、计数 `tabular-nums`。最小的注脚从 10.5px 提到 11.5px 并改用
  `--iw-fg-3`，不再用 `opacity` 造灰。
- **详情页分块**：`.entryBlock` 与 `.entryListHead` 加 `borderTop: 1px solid var(--iw-line)` + 10px 上边距，
  角色卡从「一整列灰字」变成「标签—值」的块。
- **选中态的重做**：原来是 `border-color: accent-line` 的一圈描边，看着像第二个边框；改成淡底
  `--iw-accent-soft` + `inset 2px 0 0 var(--iw-accent)` 左侧竖条，描边设成 `transparent`。
- **书卡**：新增 `bookPath`（等宽、11px、`direction: rtl` 以便从左截断），梗概行升到 12px/`--iw-fg-2`；
  `pill` 从「描边胶囊」改成「淡底无边框」，因为它是标签不是按钮。
- **叶子行的字形**：新增 `glyphLeaf`（12px、`opacity: 0.55`），父亲节点用 `glyph`（`--iw-fg-2`），
  七行 `地点 · 雾港N` 不再一排同样显眼的圆点。
- **`npm run preview`**：上面那个脚本进了 `scripts/`，`preview/` 已加进 `.gitignore`。

### v0.14 剧情设计收成四行：地点有了历史，故事点有了边界，时间线会算

用户的原话是「剧情设计下面这一堆太乱了，收干净一点」（m08845）。原来那四行里，
「全书故事线」「剧情点」「伏笔总览」**背后没有数据**——只是三行字。所以这一版不是删，
是补：换成 地点 / 故事点 / 时间线 / 章卡，三样新东西各挡一类长篇特有的错。

- **数据形状**（`src/domain/types.ts`）：
  - `PlaceState { chapter; detail; note? }`、`PlaceCard { name; aliases; kind; firstChapter; latestChapter; detail; state: PlaceState[]; updatedAt }`。
    地点不是一条设定，是**按章的历史**；`detail` 是「现在的样子」（最后一章的版本）。
  - `StoryPoint { id; name; startChapter; endChapter; premise; characters; closed; notes?; createdAt }`，id 形如 `sp-001`。
  - `TimelineFile { formatVersion; anchors; spans; recalls }`，`anchors` 是 `{ chapter, when, label? }`，
    `spans` 是 `{ from, to, text, min, max }`，`recalls` 是 `{ chapter, about, eventChapter, claimed }`。
- **时钟算术 `src/domain/clock.ts`（纯函数，23 个用例）**：导出
  `Window`、`TimelineResolution`、`ClockFormatError`、`parseDuration(text): { min, max } | undefined`、
  `parseWhen(when): Window`、`describeWindow(window)`、`resolveTimeline(...)`、`windowAt(resolution, chapter)`、
  `checkProseAgainstClock(text, window, bookStart): Finding[]`。
  `parseWhen` 只认 `2019` / `2019-03` / `2019-03-15`，解析不了抛 `ClockFormatError`（错误里带可用例子）；
  `parseDuration` 认「两三个月」（60–90 天）、「半年」、「一年多」（365–730 天）——
  **故事时间是区间，不是一个点**，因为一个假装精确的检查要么误报诚实的正文，要么漏掉真错。
- **`novel_story`**：`add` 时有未收尾的点就拒绝（`还没收尾` + 提示先 close），`close` 结束章早于开始章也拒绝。
  这条规则的理由写在代码注释里：两段故事共用一个故事点，新章会自动继承旧故事点的人物与地点，
  是长篇里**最难事后发现**的一类错。
- **`novel_timeline`**：`anchor` / `span` / `at` / `list` / `recall`。解析不了的日期或时长当场抛错，
  错误信息里带可用例子（`2019-01`、`过了两三个月`），空字符串比错答案好。
  `recall` 把「某人第 N 章回忆第 M 章那件事，说成 X 月」落进 `timeline.recalls`，
  `novel_check action="timeline"` 用 `checkProseAgainstClock` + `windowAt` 比对。
- **面板**：`src/panel/tree.ts` 的 plot 抽屉从七行收成 地点 / 故事点 / 时间线 / 章卡 四行；
  `src/panel/entry.ts` 加了地点页（显示 `detail` 与历史）与故事点页；`src/panel/serve.ts` 的写路由支持
  `kind=place` 与 `kind=story`，**`kind=timeline` 明确拒绝**：
  「日期是对正文的断言，面板里没有那句话，要记就用 novel_timeline」。地点的 `state` 整卡替换时会被接住
  （同一个坑，v0.12.1 的教训在这里第二次生效）。
- **测试**：`test/clock.test.ts`（时钟纯函数 23 例）、`test/story.test.ts`（两个工具的 13 例，含所有拒绝路径）。

**教训**：新增字段的整卡替换要接住旧值——地点 `state` 是第二例。面板与工具共用同一段落盘代码，
所以只要 `ProjectStore.upsertPlace` 是「整卡替换」，调用方就必须显式搬运 `state`。

### v0.15 书库里的「导入…」：一个文件夹一次读成书，md 与 txt 都认

用户的原话是「小说工坊增加导入功能，点击后可以导入 markdown 也可以是 txt 格式，然后会让你选择一个
文件夹（跟新建一样）创建工作区，然后 AI 阅读导入对应正文、章卡、时间线、地点、剧情点，这些东西
能够根据正文的发展实时更新」（m09675）。

**关键判断**：宿主没法稳定地「新建会话后自动发第一条指令」——`UiWorkspaceService` 有
`connectWorkspace`/`openSession`/`startSession`，但 `sessions.create(opts)` 不接受初始 prompt；
`SessionFace.prompt(content, mode, signal, requestId)` 在，`sessions.sessionOf(actx)` 却要求
retained Session scope（commands 插件里实测抛 `command.popupFor requires a retained Session scope`），
`retainAgentScope` 只在宿主内部调用。所以这一版不赌「自动对 AI 说一句」，而是让**确定性机制**承担
「随正文实时更新」：写一章的报告与每章的上下文包都会点出记录欠账。

- **txt 也要能读**：`src/domain/import-scan.ts` 的 `splitManuscript(file: SourceFile): SourceFile[]`
  按 `CHAPTER_LINE`（`第\s*([0-9０-９]+|[零〇一二三四五六七八九十百千两]+)\s*[章回节]`）与
  `ENGLISH_CHAPTER_LINE`（`chapter \s+([0-9]+)`）切分整本书的 txt。**少于 2 个标题就原样返回**——
  正文里提到「第一章」不该把文件切碎；同号标题只取第一个。`chineseNumber(text)` 支持汉字数字（无「万」）。
- **一条路由做完建书 + 导入**：`src/panel/serve.ts` 的
  `export async function importBook(deps: PanelDeps, body): Promise<PanelAnswer>`，
  校验绝对路径与目录存在 → `readSources` + `planImport` → 没有章节时 **422** →
  标题回退到 `basename(folder)` → 复用 `createBook` → `new ProjectStore(created.root)` → `applyImport`
  → `rememberBook` → 返回 `ImportedManuscript & { title, existing, phase?, voiceless, report }`。
  `POST /api/inkwell/import-book`；`/import` 仍是「往已有的书里追加」。
- **记录欠账可见**：`src/domain/records.ts` 的 `recordCoverage(snapshot)` 收 `place.states[].chapter`、
  故事点的 start/end、`anchor.chapter`、`span` 的**整段区间**、`recall` 的 chapter 与 eventChapter；
  `chapterRanges([1,2,3,7])` → `第1–3、7章`；`describeCoverage` 空书时说「地点/故事点/时间线都还是空的」
  并给三条具体调用，非空时点名「N 章没有留下任何记录」。
  接到三处：`novel_check action="records"`（`all` 里是 info）、`novel_chapter` 写完的清单
  （`recordHint`）、`novel_briefing` 的上下文包末尾（`【记录欠账】`）。
- **面板**：`client.js` 新增 `ImportDialog`（先报扫描结果，扫不到章节时按钮禁用而不是让人点了才失败）、
  `importBook(dir, title, targetWords)` 请求封装、书库顶部的「导入…」按钮；
  成功后走 `openBookWorkspace(dir, root)` + `setNotice(importNote(...))`，与新建同一条落地路径。
  没有宿主选择框的宿主上，「导入…」退回到浏览页的「建好之后导进来」勾选（两步等价）。
- **测试**：`test/records.test.ts` 7 例、`test/manuscript-txt.test.ts` 8 例、
  `test/panel-import.test.ts` 增 `/import-book` 两例（单文件 txt 建书 `written=2`、`phase=drafting`；无章号 422）。
  全量 **395 个用例（31 文件）**。

**教训**：`PHASES`/`Phase` 不在 `phase.ts` 里导出，从 `domain/types.ts` 拿；
「实时更新」靠提示词不如靠工具输出里那句具体的欠账——模型会读工具结果，不一定会读文档。

## 怎么本地跑

```sh
cd dsh-inkwell
npm install                          # 无需任何 flag，见下文"依赖说明"
npm run check                        # typecheck + 395 个测试 + build + 打包冒烟
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
- ✅ 395 个用例全过（vitest，31 个文件），含完整流水线端到端、双工作区互不干扰（走真实工具与真实门禁）、三态合并、推理档位透传、面板投影与抽屉树、面板路由（200/403/404/405、按会话分书、选目录建书、书库列表与目录消失）、详情页（角色/设定/章节、草稿轮次、404、400）、就地编辑（校验器、写路由、闸门 409）、团队路由（读/写/还原/顾问式校验/目录不可用降级）、书架（容错解析、去重、置顶、不重写、无 BOM）、**面板把会话钉到一本书**（`test/pin.test.ts`：403／400／404／405，以及「同一个 session 不带 root 也读到那本书」）、**浏览器半边真的跑起来点的**（`test/client.test.ts` 用假 `__ModuleLoader__` + 桩 `React` 加载 `client.js`，断言点一行到达的是开页的回调）、模块装载形状、**审稿意见的 id 与结案状态**（`test/reviews.test.ts`）、**章节版本冲突与 restore 回退**（同文件，含 `force` 与「没有第 99 轮草稿」）、**换书的 pin 按会话隔离**（`test/switching.test.ts`）、**导出三条产物与空书拒绝**（`test/export.test.ts`）、**时钟算术与时间窗比对**（`test/clock.test.ts`：中文时长区间、三种日期写法、算不出来返回 unknown、回忆与正文日期冲突）、**故事点与时间线两个工具的全部拒绝路径**（`test/story.test.ts`）
- ✅ `npm run verify`：用假上下文挂载 `lib/index.js`，10 工具 + 1 门禁 + 1 条面板路由 + 18 个配置键全部就位，并检查浏览器半边的声明与文件
- ✅ **真实 DSH 实装**（v0.5.1 三条通道，每条都启动进程取过 `/api/inkwell`）：
  - 本地路径 `add E:\dshplugin` → `dsh-inkwell: link:E:/dshplugin`
  - `npm pack` 的 tgz（114.8 kB / 118 文件）→ 干净 profile 里装出 `lib/`、`client.js`、`cordis.patch.yml`，`dsh.profile.bundles` 自动补条目
  - `add git+https://github.com/The-Architect-Li/-.git` → 放行构建后现场构建成功
- ✅ **真机 boot**（v0.4 起）：独立 profile 带 `@deepseek-ai/dsh-web-app` 启动后，shell 里出现 `plugins/??dsh-inkwell/client.js` 预加载；`GET /api/inkwell` 返回真实书的快照（HTTP 200，JSON）；`/api/inkwell/snapshot` 同样 200；`POST /init` 能建书
- ✅ `npm view dsh-inkwell` → 404，包名空着，`npm publish` 之后 `add dsh-inkwell` 即可用（本机没登录 npm，此路未实测）
- ✅ 面板的**视觉效果**在 v0.7 由用户截图确认：抽屉树、计数徽章、底部「⚙ 设置」行、详情页都能正常渲染（渲染结果仍以用户的实际主题为准）
- ✅ `/entry` 真机验证：`kind=character&key=沈砚` 返回 200 与完整字段；不存在的名字 404；缺 key 400；非 GET 405
- ✅ **面板写入门真机验证**（v0.8，隔离 profile + 演示书）：`POST /entry` 把沈砚的目标改成「把妹妹带回岸上」后读回一致（改的是磁盘上的 `canon/characters.json`）；无 `x-dsh-plugin` 头 403；写未批准的第四章 409 并回传门禁原话；组合客户端 bundle 451,534 字节里含「预览正文／改正文／保存中／breadcrumb／api/inkwell/entry」
- ✅ **书库真机验证**（v0.9，同一 profile）：`GET /api/inkwell/books` → `雾港（drafting · 3 章 · 6380 字 · current）`；`POST /books` 无头 403、非 GET 405；面板建的「第二本」当场进书架（当前会话那本仍排第一）；组合 bundle 459,223 字节含 `function Library`／`已有的书`／`api/inkwell/books`／`回到书库`／`上次`
- ✅ **外观在预览里逐屏看过**（v0.13）：`npm run preview` 生成的 `preview/{shelf,tree,detail,prose,dialog}.html` 用 360px 宽无头截图核对（浅色与深色各一次），判定依据是「13px 正文/29px 行/发丝线分块/选中淡底+左竖条」都真的出现了。**这是预览，不是应用内截图**：宿主主题色、真实滚动条、以及 Shell 自身的间距仍以用户实际看到的为准。

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

## 下一步（v0.15 候选，按性价比排序）

0. **让用户在他的 Desktop 应用里点一次「新建 + 导入」**：选目录 → 勾选框 → 建书 → 导入，这条链路
   无头环境里只验到 HTTP 层（`/scan` / `/init` / `/import` 都通过），原生选择框之后的真实点击还得他来点。
1. **把地点历史接进上下文包**：时间线已经进了包（`src/domain/briefing.ts` 的 `resolveTimeline` + `windowAt` 给出一行「本章故事时间」，没有锚点时会提示去记），
   但 **地点还没进包**——`briefing.ts` 至今不读 `snapshot.places`，写第 45 章时看不到「三号舱现在是烧过一半」。
   接法：按 `plans[chapter].characters` 与章纲文本命中地点名，取 `state` 里 `chapter <= N` 的最后一版。
2. **地点历史接进导入**：`import-scan.ts` 目前只把人物小节塞进 `notes`，地点从未从旧稿里被识别（旧稿的 `设定/` 下若有地点文档，现在无人认领）。
3. **面板里批准章纲**：v0.5 开了「建书」，v0.6 开了「挑模型」，v0.8 开了「改已有条目」，v0.10 开了「改正文并结案审稿」，v0.12 开了「把旧稿拿进来」，五者都等价于一个本来就存在的工具调用。再往前一步到「批准章纲」只剩一个障碍：批准需要理由，而理由要落进 `plans`。做法是让面板的批准表单必填一句理由，再走与 `novel_outline action="approve_chapter"` 相同的写入——**门禁的唯一性不是「只有工具能写」，而是「只有一条代码路径能写」**。
4. **导入时补 voice 的入口**：v0.12 故意留空并点名，下一步可以给面板一个「补齐说话方式」的批量页，把这 N 张卡一次填完，而不是逐个点进去编辑。
5. **有争议时串行审稿**：现在 logic/character/chief 各跑各的，意见按轮次并排存进 `reviews/`，没有谁读谁的。做依赖图（两位审核先跑，chief 收全量再裁决），并把「分歧」本身记成一条 review item——v0.10 已经有 `state` 与 `id`，缺的只是顺序。
6. **`novel_briefing` 的预算自适应**：按模型上下文窗口算预算，而不是固定 6000 字。团队页已经有了「这个角色跑在哪个模型上」，上下文窗口就不该再靠猜。
7. **面板里的搜索**：抽屉树截断在 25 行，94 章的书要靠折叠去找。给树加一个「搜角色／搜章节」输入框，仍然是纯函数投影。
8. **docx / epub 导出**：`src/domain/export.ts` 已经是纯函数、只把文本拼成文件，接一个 OOXML 或 EPUB 打包器是纯增量；难点在样式表而不是数据。

## 续作第一天做什么

1. `git clone` 仓库，`npm install`，`npm run check` 确认 395 测试 + 打包冒烟全过。
2. 起一个独立 profile 装本机副本：`dsh plugin --profile inkwell-verify add E:\dshplugin`，看 `node_modules/dsh-inkwell` 是不是 link，再跑 `node scripts/verify-install.mjs <profile>/node_modules/dsh-inkwell`。
3. 想验证面板，得让 profile 的 `dsh.profile.bundles` 里同时有 `@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-web-app`（只有 base 的 profile 没有 `webServer`，面板路由不会挂），然后 `dsh --profile inkwell-verify --port <port>`，用启动日志里的 `?token=` 进 shell、再 `GET /api/inkwell`。**注意**：`package.json` 必须是无 BOM 的 UTF-8，PowerShell 的 `Set-Content -Encoding utf8` 会写 BOM，启动时报 `SyntaxError: Unexpected token '\uFEFF'`。
4. 读 `docs/architecture.md`（含「根目录属于会话」「三态路由」「面板为什么不走 Remote」「书库：列表是提示，磁盘是事实」「面板写操作只开三扇门」「右侧栏只有一条」「入口形状是个陷阱」等节）+ `src/index.ts`（挂载）+ `src/domain/scope.ts`（哪本书）+ `src/domain/session-books.ts`（会话钉选）+ `src/domain/store.ts`（revision 与 reviews）+ `src/domain/save.ts`（正文的唯一落盘口）+ `src/domain/export.ts`（导出）+ `src/domain/import-scan.ts` / `manuscript.ts` / `import-apply.ts`（导入：纯函数计划 → 读盘 → 落盘）+ `src/panel/`（面板：model/tree/entry/edit/dirs/roles/catalog + serve）+ `src/domain/shelf.ts`（书架）+ `client.js`（浏览器半边：树、详情页编辑器、建书、设置、团队）+ `src/gate.ts`（门禁）。
5. 决定先做上面 v0.15 列表的哪一项。

## 项目记忆

v0.1/v0.2 阶段的会话级工作日志在 `C:/Users/admin/WorkBuddy/2026-10-23-14-20-23/.workbuddy/memory/2026-10-23.md`（**本机不存在，历史路径**）。v0.3 的实现细节以本文件 + `CHANGELOG.md` + `docs/architecture.md` 为准。
