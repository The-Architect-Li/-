# 变更日志

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.10.0] - 2026-10-25

用得久了才会暴露的四件事：审稿意见会消失，两处同时改一章会互相覆盖，对话里换不了书，写完交不出去。

### 新增

- **审稿意见落盘**（`<项目>/reviews/<章号>.json`）。`novel_dispatch` 的 `logic` / `character` /
  `chief` 每一轮的意见都记下来：谁提的、用的哪个模型、审的是第几轮草稿、每条的 id。
  写手逐条结案：`novel_chapter action="review" number=1 id="001-r1-1" state="fixed" note="改成傍晚了"`；
  决定不改用 `state="waived"`，**必须**在 `note` 里写清楚为什么 —— 半年后你会想知道。
  `action="review"` 不带 id 就是看板，按轮次分组，`✓` 已改 / `—` 不改 / 空格未结。
- **章节版本号（乐观锁）**。每次落盘 `chapters/NNN.json` 的 `revision` 加一。`write` / `restore`
  默认要求带上你读到的那一版 `revision`；对不上就拒绝，并告诉你是第几版对第几版。确实要无条件
  覆盖传 `force=true`。面板编辑页同样带版本号，冲突时返回 409 并提示刷新 —— 不再出现「晚保存的
  那一份悄悄吃掉早保存的那一份」。
- **回退到某一轮草稿**：`novel_chapter action="restore" number=1 round=2`。草稿本来就在
  `drafts/` 里躺着，现在有了入口，回退也走同一套版本检查，本身也算一次新版本。
- **对话里换书**：`novel_project action="books"` 列出这台机器上记得的书、哪一本是本会话正在看的；
  `action="open" root="<项目目录或其上级>"`（或 `book="书名片段"`）把本会话钉到那本书上；
  `action="close"` 回到会话自己的工作目录。钉选按会话保存（`<DSH_HOME>/inkwell/sessions.json`），
  下一个工具调用照旧生效，不必每句话都重复。`books` / `open` / `close` 不受阶段闸门限制 ——
  这组工具就是给「指错地方了」的人用的。
- **导出**：`novel_export action="text"` 整本 txt、`action="markdown"` 按卷分文件（没分卷的进
  `未分卷.md`）、`action="canon"` 设定集（人物、世界观、分卷、章纲、仍然成立的事实表）。
  `out` 可给绝对路径，默认写进 `<项目>/exports/`。只导已落盘的正文；`propose` 的草稿在 `drafts/`
  里，不算。
- 面板章节页显示未结审稿条数与每条的 id；编辑页保存时自动带上页面打开时的版本号。

### 变更

- `src/domain/library.ts` 改名为 `src/domain/shelf.ts`，`dshHome()` / `bookKey()` 提到
  `src/domain/home.ts` —— 工具和面板现在都要读这份状态，它不再是面板私有的。
- `ProjectStore.writeChapter(draft, { baseRevision })`：不传就无条件写（内部调用），传了就比对。
- 章节 JSON 多一个 `revision` 字段；老的章节文件没有这个字段，读的时候按 1 处理，写的时候补齐。

### 修复

- **设定集导出把被推翻的事实当成「仍然成立」**。原来按 `supersedes === null` 过滤，筛的恰好是
  「没有推翻别人」的那些 —— 即被替换的旧事实，反而丢掉了新的。现在按「有没有被后来的条目
  supersedes」判断。
- 空书导出 txt 会写出一个只有书名的文件；现在直接说「还没有可导出的正文」。

### 已知边界

- 导出没有 docx / pdf。要 Word 就用 markdown 或 txt 转。
- 版本号是「一文件一版本」，不是字段级合并：两人改同一章的不同段落仍然会有一方收到 409。
- 换书记在会话上，不在书上：同一个会话只能看一本，两个会话可以各看各的。


## [0.9.2] - 2026-10-25

面板长着眼睛也能看见的东西：鼠标移上去会亮，键盘按得动，输入框点进去有个圈。

### 新增

- **一张交互样式表**（`client.js` 里的 `CSS` + `ensureStyles()`）。之前所有样式都是 React 的
  inline style，而 inline style 没有 `:hover`、`:active`、`:focus-visible` —— 于是每个按钮、每一行
  抽屉、每一本书架上的书都「看起来不可点」。现在这些状态进了真正的一层 `<style>`，插在
  `document.head`，key 是 `#dsh-inkwell-styles`，同一个面板挂两次也只插一张。
- **行与抽屉头**：悬停 10%、按下 15%、选中保持 15%（选中态悬停不再变暗）；`cursor: pointer`、
  `user-select: none`（双击不再选中半行字）。
- **按钮**（`iw-btn`）：悬停 10% 底色 + 边框提到 38%，按下 18%，`disabled` 降到 45% 透明度且不再
  显示手型；主按钮（`iw-primary`）自带 12% 底色，悬停到 22%。
- **输入框与下拉框**（`iw-input` / `iw-select`）：悬停边框 34%，聚焦时边框 52% 外加一圈
  `box-shadow` 光环；这两处把边框从 inline 挪到 CSS，否则 inline 的 `border` 会一直盖住悬停色。
- **书架行**（`iw-book`）、**设置行**（`iw-settings`，悬停时左内边距 10px → 14px，有个小小的位移）、
  **展开箭头**（`iw-glyph`）、**智能体卡片**（`iw-card`，悬停描边变深，卡内有输入框聚焦时更深）。
- **键盘与读屏**：行与抽屉头都有 `role="button"`、`tabIndex: 0`、`aria-pressed` / `aria-expanded`，
  Enter 与 Space 等价于点击（Space 会 `preventDefault`，免得侧边栏跟着滚）。聚焦环是 2px、48%。
- **`prefers-reduced-motion: reduce`** 下所有过渡关掉，设置行也不再位移——动效是装饰，不是信息。

### 验证

`npm run check` 通过，**259 个用例**全绿（19 个文件），`client bundle : ./client.js 76781 bytes`。
真机（隔离 profile `inkwell-verify`，端口 19411）：重新取回的组合 bundle 466,429 字节，
`iw-row:hover`、`iw-glyph`、`iw-open`、`iw-card`、`prefers-reduced-motion` 都在。
`test/client.test.ts` 多了三条：行带 `iw-row`/选中带 `iw-row-sel`/`role=button`/`tabIndex=0`、
Enter 与 Space 都触发且 Space 两次 `preventDefault`、抽屉头带 `iw-open` 且 Enter 能折叠。

## [0.9.1] - 2026-10-25

点一行没有反应——修掉这个，并让它以后再也不能悄悄退化。

### 修复

- **点角色／设定／章节只高亮，不打开二级页面**。v0.7 加了「点开即看」的详情页，但抽屉树渲染时
  传给仍然只有 `setSelected` 的旧回调：行能画出来、能选中，`/entry` 一次都没被请求过。现在树、
  抽屉、行三层共用同一个 `onRowClick`，由它一处判断「这行代表一个东西就开页，否则展开或选中」。
  这个 bug 从 v0.7 活到 v0.9.1，因为之前的验证都停在「服务端返回了什么」和「bundle 里有没有这段
  字符串」，没人点过一下。
- **`test/client.test.ts`**：用假的 `__ModuleLoader__` 与桩 `React.createElement` 把 `client.js`
  真的加载一遍，然后调用 `Row` 渲染出的元素的 `onClick`，断言点击到达的是开页的那个回调。`Row` 不
  用 hooks，所以不需要 DOM 也不需要真 React。三条用例分别覆盖：带 `kind`／`key` 的行、纯分组行、
  以及展开箭头只切换不误触。

### 验证

`npm run check` 通过，**256 个用例**全绿（19 个文件），`client bundle : ./client.js 69929 bytes`。
真机（隔离 profile `inkwell-verify`，端口 19411）：重新取回的组合 bundle 里
`onClick: () => onRowClick(row)` 与 `setView('detail')` 都在，旧字符串 `onSelect: setSelected` 已消失。

## [0.9.0] - 2026-10-25

小说工坊现在是一个书库，而不是一本书：打开侧边栏先看见「已有的书」和「新建」，点进一本书
才是人物、剧情、正文那套抽屉。

### 新增

- **书库页**（`GET /api/inkwell/books`）：面板的落地页。列出这台机器上 dsh 写过的书，每行给出
  书名、阶段、章数、字数与目录，`当前` 标这本书属于当前会话，`上次` 标本次浏览器最后打开的那本。
- **书的来源是三处并集**：请求里 `?root=` 指定的、会话自己解析出来的、以及书架（shelf）记着的。
  三处都要过一遍磁盘，目录被删或被搬走的书直接不出现——书架是提示，不是承诺。
- **书架**（`src/panel/library.ts`）：`$DSH_HOME/inkwell/books.json`（没有 `DSH_HOME` 就用
  `~/.dsh`）记最近 40 个书根，只有路径与时间，没有标题、没有正文。建书、按路径打开、以及会话
  解析出的书都会记一行；已经排在第一位的根不再重写文件，所以 15 秒一次的轮询不会变成写盘抖动。
- **新建与打开在同一层**：书库页有 `＋ 新建`，书库里点一本书才进树；树的左上角是 `←`（回到书库），
  设置页的返回也回到书库，而不是掉进某一本书里。
- **`Library` 组件**（`client.js`）：与抽屉树同一套尺寸与配色，条目是一整行可点按钮，路径过长时
  单行省略，不换行、不撑破侧边栏。

### 变更

- **落地页从树变成书库**。上次打开的书仍记在 `sessionStorage`（`inkwell.root.<sessionId>`），
  关掉面板再打开还在，但它只用来给书库那行打 `上次`，不再决定你一眼看见什么。
- **空态措辞**：书库没有书时说「这台机器上还没有书」，并给出「选择目录新建」和「可以在对话里
  调用 novel_project（action="init"）」两条路。

### 仍然不做

- 面板不能推进阶段、批准章纲、定稿、记账本事实；书库也不能删书、改名或移动目录。删除是文件系统
  的事，交给资源管理器比交给侧边栏安全。

### 验证

`npm run check` 通过，**253 个用例**全绿（18 个文件，新增 `test/library.test.ts` 12 例、`/books`
路由 3 例），`client bundle : ./client.js 69575 bytes`。真机（隔离 profile `inkwell-verify`）：
`GET /books` 返回 `雾港（连载中 · 3 章 · 6380 字, current）`，无头 `POST /books` 403，`POST /books`
405；面板建的「第二本」当场出现在书架第二位（第一位留给当前会话那本）。组合 bundle 459,223 字节，
含 `function Library`、`已有的书`、`api/inkwell/books`、`回到书库`、`上次`。

## [0.8.0] - 2026-10-24

二级页面不再是只能看的卡片：角色、设定、章节正文都能就地改，改的是同一本账——聊天窗口里的
`novel_*` 工具和侧边栏里的编辑器从此走同一段落盘代码。

### 新增

- **在页面上编辑**（`POST /api/inkwell/entry`）：角色页可改角色定位、说话方式、外貌、目标、秘密；
  设定页可改类别与细节；章节页可改标题与整章正文。保存后页面用宿主回传的最新状态重画，抽屉树
  也会重新读一遍，字数与状态跟着变。
- **章节页的预览／编辑两种模式**：正文默认按段落预览（首行缩进 2em），点「编辑」进入输入框，
  输入框下方实时显示去空白后的字数——和账本里记的是同一个数。没写过的章显示「还没有正文」，
  而不是一个空格子。
- **`src/domain/save.ts`**：`saveChapterBody()` 现在是正文落盘的唯一入口，`novel_chapter
  action="write"` 与面板共用它。空正文、没章纲、章纲合同有 error，三种拒绝在两边逐字一致——
  面板不会比工具宽松，工具也不会比面板宽松。
- 面包屑（`人物设计 › 主角`、`世界观 › 地点`、`正文 › 第1卷`）：详情页自己说明它在哪一层。
- 章节页会先问一遍闸门：章纲没批准时页面直接显示「第4章的章纲还没批准…」，编辑按钮不必点了
  才知道。

### 变更

- **正文写入不再复制规则**：`src/tools/chapter.ts` 的 write 分支改为调用 `saveChapterBody`，
  自己只负责把 `ChapterBlockedError` 包成给人看的长句。同一章从两条路写进来，结果必然一样。
- **已写章节的标题以正文为准**：章纲先给了名字，但你改过的名字是这一章现在的名字；没写的章
  仍然显示章纲的标题。
- **写请求的上限是明确的**：正文 20 万字、canon 字段 4000 字、标题 120 字，超了是 400 加一句
  人话，不是悄悄截断。

### 仍然不做

- 面板不能推进阶段、批准章纲、定稿、记账本事实。这四件事必须经过 `novel_project`、
  `novel_outline`、`novel_ledger` 和它们的理由。

### 验证

`npm run check` 通过，**237 个用例**全绿（17 个文件，新增 `test/edit.test.ts` 14 例，`/entry`
写路由 9 例，页面投影 5 例），`client bundle : ./client.js 61886 bytes`。真机（隔离 profile
`inkwell-verify`）：`GET /entry` 返回带 `breadcrumb`／`edit` 的页面，`POST /entry` 改角色目标后
读回一致，无头写 403，未批准的章 409，组合 bundle 451,534 字节里含「预览正文」。

## [0.7.0] - 2026-10-24

面板从「一张全部摊开的目录」变成了真正的书架：打开时四个抽屉都收着，点一个名字，整个侧边栏
换成那个人的页面。

### 新增

- **角色／设定／章节详情页**（`GET /api/inkwell/entry`）：抽屉树里带 `kind` 的行都能点开。
  角色页给出说话方式、外貌、目标、秘密，外加「出场章节」与「账本里的事实」两段；设定页给出
  类别、细节与相关事实；章节页给出状态、分卷、视点、章纲是否批准、字数，以及出场人物、
  必写节拍、章末钩子、最新一稿的自动发现。页面形状来自宿主（`src/panel/entry.ts` 产出
  `fields` 与 `lists`），浏览器那一半只负责排版——以后加第四种页面不用改前端。
- 已经不存在的东西返回 404 而不是空白页：浏览器里挂着一张十分钟前的树时，应该被告知刷新，
  而不是看到一张全空的卡。

### 变更

- **打开即折叠**：四个抽屉（世界观／人物设计／剧情设计／正文）初始都是收起的，面板一打开是
  目录而不是九十四章。折叠状态在面板会话内保留，翻页回来不会重置。
- **点行有两种行为**：有内容的行进详情页；分组行（主角、反派、第N卷）点击即展开／收起，和
  点箭头一样，不必瞄准那 6 像素的小三角。

### 验证

`npm run check` 通过，**211 个用例**全绿（16 个文件，新增 `test/entry.test.ts` 9 例与
`/entry` 路由 5 例），`client bundle : ./client.js 51937 bytes`。

## [0.6.1] - 2026-10-24

设置入口从一个藏在书头的齿轮，搬到了抽屉树底部一整行：齿轮图标 + 「设置」两个字 + 右侧的
`智能体团队` 提示，与 dsh 自己的侧边栏入口同一个位置、同一种写法。

### 变更

- **设置入口下移**：原来书头右上角只有一个 `⚙` 图标按钮，不点开不知道是什么。现在抽屉树
  底部有一行通栏的「⚙ 设置」，带顶部细分割线和更大的字号，空书状态也显示，不必先有一本书
  才找得到设置。
- `package.json` 版本 0.6.1。

### 验证

隔离 profile 起实例后取客户端包（`plugins/??…dsh-inkwell/client.js…`）返回 200、
435357 字节，含 `settingsRow`、`settingsLabel`、`智能体团队`、`跟随会话`、`还原`；
`npm run check` 通过，197 个用例全绿，`client bundle : ./client.js 45709 bytes`。

## [0.6.0] - 2026-10-24

侧边栏有了「设置」：点进去能看到这支团队的四个人，并给每一个挑模型——挑的是你在 dsh 里
已经配好的那些，不是插件自己编的清单。

### 新增

- **设置页与智能体团队页**（`◍ 智能体团队`）：四个角色（写手／逻辑审／角色审／指挥官裁决）
  各一张卡，写明它只做什么、当前实际跑在哪条路由上、以及这条路由来自哪一层
  （`本书指定`／`全局默认`／`跟随会话`）。指挥官不是一个可派的角色——它就是你在对话的那个
  模型——所以只陈述，不提供选择器。
- **按角色挑模型**（`GET/POST /api/inkwell/roles`）：接口下拉、模型下拉、思考强度下拉。接口
  和模型清单来自宿主的 `llm` 服务（`listProviders`／`listModels`／`resolveModelInfo`），
  60 秒缓存；某个 provider 的元数据查不到时只是不列思考档位，不会卡住整页。
- **思考强度**（`reasoningEffort`）：模型的适配器报了什么档位就只列什么档位，默认项显示适配器
  的 `defaultEffort`。这一层在 v0.3 只是配置字段，现在面板里能点。
- 面板写的是与 `novel_roles` 工具同一份存储（`project.json` 的 `roles`），所以面板里挑完，
  `novel_roles action="list"` 立刻能看到，下一次 `novel_dispatch` 立刻按新路由派活。
- **还原**：某角色被本书指定过时，卡片右上角出现「还原」，一键清掉本书覆写、回落到全局默认。

### 修复

- 路由来源标签说谎：配置 schema 会把四个角色物化成 `{}`，旧判据只看「这一层存不存在」，于是
  四个角色全被标成 `全局默认` 而实际是 `跟随会话`。现在只有真带字段的层才算数。
- 面板里选「跟随全局」时提交空串，宿主把它解读成「清掉这一层」而不是「存一个空 provider」。

### 变更

- `package.json` 版本 0.6.0。

### 验证

隔离 profile 起实例后实测：`GET /api/inkwell/roles` 返回 2 个 provider／4 个角色；`POST` 指定
写手为 `deepseek-official/deepseek-flash` 后 `source` 从 `inherit` 变 `book`、`effective` 变
`deepseek-official/deepseek-flash`；`reset` 后回到 `inherit`；不带 `x-dsh-plugin` 头与带错值
都返回 403，带对头返回 200。197 个用例全绿。

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

[0.10.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.10.0
[0.9.2]: https://github.com/The-Architect-Li/-/releases/tag/v0.9.2
[0.9.1]: https://github.com/The-Architect-Li/-/releases/tag/v0.9.1
[0.9.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.9.0
[0.8.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.8.0
[0.7.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.7.0
[0.6.1]: https://github.com/The-Architect-Li/-/releases/tag/v0.6.1
[0.6.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.6.0
[0.5.1]: https://github.com/The-Architect-Li/-/releases/tag/v0.5.1
[0.5.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.5.0
[0.4.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.4.0
[0.3.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.3.0
[0.2.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.2.0
[0.1.0]: https://github.com/The-Architect-Li/-/releases/tag/v0.1.0
