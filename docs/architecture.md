# 架构

这份文档解释墨井为什么这样切分，以及每一层的边界在哪里。想改代码之前先读这一篇。

## 一句话结构

```text
src/
  domain/    纯函数与磁盘读写，不认识 DSH，可以在 node 里直接测
  panel/     面板投影、抽屉树与路由（model/tree/dirs/roles/catalog 纯函数，serve.ts 一个 prefix handler）
  tools/     九个工具，只做参数翻译与结果格式化
  gate.ts    预执行门禁，唯一能拒绝调用的地方
  index.ts   挂载：注册工具 + 挂 tools/pre-execute + 挂面板路由
client.js    浏览器半边：把面板注册成右侧栏的一个 tab 类型，并调宿主的目录选择框
```

`domain/` 不认识 Cordis，也不认识工具注册表。这是刻意的：约束逻辑必须是可单测的纯函数，否则「代码强制」会退化成「代码看起来在强制」。

## 为什么记忆放在项目目录里

主流做法是把记忆挂在会话上：把前情摘要注入上下文，靠 session 存。问题有三个：

1. **会话是复盘用的，不是检索用的。** append-only 事件流适合人看，不适合按「沈砚的左眼」去查。
2. **换会话就丢。** 用户新开一个窗口，模型就重新开始编。
3. **摘要会蒸发细节。** 「他改了航向」这种摘要，丢掉的正是后面会冲突的那个事实。

所以墨井把状态落在 `<root>/` 下，纯 JSON + Markdown：

```text
<root>/
  project.json          阶段、前提、目标字数、本书的角色路由覆盖
  canon/characters.json 角色卡（含 voice）
  canon/world.json      世界观条目
  outline/volumes.json  分卷
  outline/chapters.json 章纲（含 beats）
  ledger/facts.json     事实账本
  chapters/index.json   章节索引（字数、摘要）
  chapters/001.md       正文，一章一文件
  drafts/001/01.json    草稿轮次（propose 落在这里，commit 才进 chapters）
```

写入统一走「临时文件 + rename」，进程被杀不会留下半截设定。正文用 Markdown，用户随时可以用编辑器直接改，改完再让工具读。

### 根目录属于会话，不属于进程

v0.2 在挂载时就把 `root` resolve 成绝对路径，存进一个长生命周期的 `ProjectStore`。单个工作区时没问题，多个工作区时第二个窗口会静默接管第一本书的 canon——这是最难查的一类串稿。

现在这条规则只有一个实现，在 `src/domain/scope.ts`：

```text
resolveSessionRoot(exec, config, baseStore):
  perWorkspace 关 → baseStore                    （v0.2 行为）
  root 是绝对路径 → baseStore                    （一本书，钉死）
  否则读 exec.agent.session.header.cwd
    有这个 cwd → new ProjectStore(resolve(cwd, root))
    没有       → baseStore                       （宁可共用，不可猜错书）
```

三个关键选择：

1. **`cwd` 来自会话头**，不是 `process.cwd()`。`SessionHeader.cwd` 是 DSH 在创建会话时记录的绝对工作目录，正是「这个窗口在看哪个项目」的权威答案。
2. **工具和门禁共用同一个解析**。`gateToolCall` 拿到的 `exec` 和 `execute` 拿到的是同一个，两边必须算出同一本书，否则会出现「在这本书上批准、往另一本书里写」。
3. **读不到 `cwd` 就退回共享 store**。猜错书的代价（写坏别人的书）远大于共用一本（用户看到「这本书里没这个项目」）。

`ToolDeps` 因此不再持有 `store`，而是持有 `storeFor(exec)`。这个接口变化是刻意的：让「哪本书」变成一个必须用调用上下文回答的问题，而不是一个可以在挂载时拍死的常量。

## 阶段机

阶段只能前进，且每个阶段的目标由数据判定，不由模型声明。

| 目标阶段 | 必须满足 |
|---|---|
| `canon` | 前提字数 ≥ `premiseMinChars` |
| `outline` | ≥1 主角、≥2 角色、≥1 世界观、每个角色有 `voice` |
| `drafting` | ≥1 已批准分卷、≥1 章纲、每章 ≥2 节拍、章纲人物都在角色卡里 |
| `review` | 至少写完 1 章、所有章纲都已落笔 |

`voice` 被列进硬条件，是因为「千人一腔」在长篇里比情节漏洞更致命：它不是某一章的错误，而是全程的错误。

## 事实账本

一条事实是四元组加一个来源：

```json
{ "id": "f-0001", "subject": "沈砚", "predicate": "左眼颜色",
  "value": "黑", "chapter": 3, "quote": "他的左眼黑得像井",
  "supersedes": null }
```

写入规则：

| 情况 | 结果 |
|---|---|
| 同主体同属性，值相同 | 视为重复，不重复写入 |
| 同主体同属性，同章不同值 | **拒绝**（同一章内自相矛盾） |
| 同主体同属性，异章不同值，无 `supersedes` | **拒绝**（跨章改动要有交代） |
| 带 `supersedes` 指向旧条目 | 通过，旧条目失效 |

第三条是最有争议的一条：人物确实会变（断臂、失忆）。要求 `supersedes` 不是禁止变化，而是**强迫变化留下痕迹**。这样「他什么时候瞎的」永远查得到。

比较用 `foldKey()`：全角转半角、去空白、小写。所以「左眼 颜色」和「左眼颜色」是同一条。

## 章纲合同

章纲是承诺：这些节拍、这些人、这个视角。写完之后逐项核对。

| 检查 | 严格度 | 理由 |
|---|---|---|
| 必出场角色是否出现 | **error，拒绝保存** | 名字是精确子串，没有歧义 |
| 章纲视角人物是否出现 | warn | 第一人称时人物名可能不出现 |
| 字数区间 | warn | 平台要求不同 |
| 节拍覆盖 | warn | 只能按二元字组估算，不能当判决 |
| 章末钩子 | info | 字面出现与否不等于悬念成立 |

节拍覆盖用二元字组：把节拍和正文都切成相邻两字，算重合比例，低于 `beatCoverageMin` 就提示，并把缺的词列出来。这是**宁可漏报**的设计——误杀一章 3000 字的稿子，代价远大于漏掉一次提醒。

## 确定性边界

分清哪些是判决、哪些是提醒，是这个项目最重要的自觉：

- **判决（会拒绝）**：阶段条件、章纲人物缺失、账本冲突、参数非法。
- **提醒（只报告）**：节拍覆盖、复读、句式、节奏、套路词、对话占比、章末钩子。

提醒类的阈值全部可配。不同题材对「套路」的定义不同，写死在代码里就是把作者的品味强加给用户。

## 角色路由的三态

每个角色的模型路由是四个字段（`provider` / `model` / `maxTokens` / `reasoningEffort`），每层都可以对某个字段说话，也可以什么都不说。三种状态，缺一不可：

| 状态 | 写法 | 含义 |
|---|---|---|
| 不提 | 字段缺失 | 交给下一层 |
| 钉住 | 一个值 | 本书就用这个 |
| 显式不设 | `null`（工具层用空串 / `0` 表达） | 压住下一层，本书这一项就是空 |

只有前两态是不够的：全局配了 `reasoningEffort: high`，某本书想对写手关掉它，如果没有第三态，唯一办法是把整个角色覆盖删掉，顺手把 `model` 也丢了。合并逻辑在 `src/domain/fields.ts`，逐字段独立求值，所以清一项不会连累邻居。

`reasoningEffort` 的类型是 `ReasoningEffortId`（DSH 的 branded 字符串），取值由供应商适配器决定，插件只透传——把 `low/high` 写死在插件里，等于替所有人选了同一家的档位。

## 与 DSH 的接缝

宿主侧用了四个扩展点：

1. `ctx.tools.register(defineTool({...}))` —— 注册工具，schema 自动进入系统提示词组装。
2. `ctx.on('tools/pre-execute', (exec, next) => ...)` —— 预执行瀑布，返回 `{kind:'deny', reason}` 即拦截，`next()` 放行。
3. `ctx.inject(['webServer'], …)` + `webServer.register({kind:'prefix', path:'/api/inkwell'})` —— 面板的只读数据接口。
4. 客户端半边：`client.js` 里的 `ctx.sidebarRightTabs.register(…)` —— 把面板注册成右侧栏的一个 tab 类型。

派发角色时多用一层 `ctx.subagents.start('spawn', …)`，但它不是「拒绝」通道：那里只负责起子智能体并收集文本。

门禁放在 `pre-execute` 而不是 `execute` 里，是为了让被拒的调用**不产生任何副作用**，同时把拒绝原因作为工具结果回给模型——模型看到的是「还缺什么」，而不是一个异常堆栈。

## 面板为什么不走 Remote

DSH 有两套往界面送数据的办法：Remote 命名空间（宿主面 + 客户端面靠 bundle manifest 配对）和 HTTP 路由。面板选了后者，理由很实际：**它只有一处写，而且那一处已经是工具允许的**。Remote 那一套的价值在于双向类型契约，而这张快照是只读投影，写只有「建书」一个动作——为一个动作拉整层机械不值。

于是形状变成：

```text
src/panel/model.ts   纯函数：Snapshot → PanelSnapshot（阶段、进度、事实、线索）
src/panel/tree.ts    纯函数：Snapshot → 四个抽屉（世界/人物/剧情/正文），带计数与状态
src/panel/entry.ts   纯函数：一行 → 一页（fields + lists），角色/设定/章节三种
src/panel/serve.ts   路由：读投影与详情、序列化 JSON、处理 /init 与 /dirs
src/panel/dirs.ts    纯函数 + 一层 readdir：列目录，回报该目录里有没有书
client.js            浏览器半边：每 15 秒 GET 一次，渲染成抽屉树与详情页
```

`model.ts`／`tree.ts`／`entry.ts`／`dirs.ts` 都不认识 Cordis，也不认识 HTTP——和 `domain/` 的同一条理由：面板上显示的东西必须能在 node 里直接断言。

详情页的载荷是**通用形状**（`fields` 加 `lists`），不是三套写死的模板：加第四种页面只改 `entry.ts`，`client.js` 那半边一行都不用动。这是把一个组件写两次和写一次的分界——浏览器不该知道「角色」有什么字段。

服务是**可选**的：`webServer` 经 `ctx.inject` 等，headless profile 里没有它，插件就只装工具不装面板。反过来，如果把它写进 `inject` 导出，headless 下的插件会整个不激活——一个面板不该有这种权力。

### 面板写操作只开两扇门

面板能写的东西只有两件，而且两件都不是新权力：

1. **建书。** `POST /api/inkwell/init` 直接调 `ProjectStore.init`，也就是 `novel_project action="init"` 调的那个函数，所以两条路落在磁盘上的字节相同。门禁本来就无条件放行 `init`（没有项目就没有可保护的东西），面板因此没有扩大任何权限。
2. **给智能体挑模型。** `POST /api/inkwell/roles` 写的是 `project.json` 的 `roles`，与 `novel_roles action="set"` 同一个字段、同一个三态语义（省略＝不管、有值＝钉住、空串＝清掉这一层）。模型清单来自宿主的 `llm` 服务而不是插件自带表，因此「面板里能选的」恰好等于「dsh 里配过的」。

三个约束写在这两个动作上，缺一条都会变成一次「安静的破坏」：

1. **必须带 `x-dsh-plugin: inkwell` 头**——跨站的简单表单提交设不了自定义头，这是同源之外唯一能拦住的东西。
2. **目录必须是绝对路径**——相对路径一律 400，绝不让宿主进程的 cwd 替用户猜一个位置。
3. **插件的 `root` 是绝对路径时拒绝建书**（409）——那时全书只有一个固定位置，面板上的「选目录」是谎话，不如直接说清并让用户改用工具。

选目录优先走宿主自己的选择框（`ctx.uiWorkspace.pickDirectory()`，由 `dsh-client-ui-workspace` 提供），读的是**惰性** `ctx.get('uiWorkspace')` 而不是声明进 `inject`：老宿主没有这个服务时，整个客户端包不该因此不激活，面板退回自己的目录浏览器。

`roles` 的路由来源一度全标错：配置 schema 会把四个角色物化成 `{}`，而旧判据只看「这一层存不存在」，于是四个角色都显示 `全局默认`，实际跑的是会话模型。判据改成「这一层有没有真字段」——**空对象不是一层**，这条同样适用于将来的任何覆写表。

### 右侧栏只有一条

Web shell 的右列（`rightbar`）已经被右侧 Sidebar 占满，没有第二个右手座位。想往里加 UI，唯一被支持的办法是给那个 Sidebar 加**一个 tab 类型**（`ctx.sidebarRightTabs.register`）。抢占整栏会把 Sidebar 挤走，那不是扩展，那是覆盖。

## 入口形状是个陷阱

装载器把模块规整成 `exports.default ?? exports` 再交给 Cordis。所以一个 `export default apply` 会把 `inject` 一起挡在外面：插件于是在 `ctx.tools` 就绪前访问它，真机启动报

```text
cannot get property "tools" without inject
```

而单测完全看不见——它们直接调 `apply(ctx, config)`，跳过了装载器。现在有两道闸：`test/plugin-shape.test.ts` 断言模块形状，`scripts/verify-install.mjs` 对构建产物再断一次。教训写在这里：**入口导出的形状是契约的一部分**，不是风格问题。

## 发售形状

`files` 只发 `lib/` 和手写的 `client.js`，所以**服务端半边必须发生在安装时**：从 git 安装的包没有预构建产物，靠 `prepare` 脚本在 install 后跑 `tsc`。pnpm 默认拦构建脚本，这也是为什么 README 要求 `allowBuilds: { dsh-inkwell: true }`——少了这一条，装上去是一个没有 `lib/` 的空壳，而 `dsh` 只会在装载时报一个看不出原因的错。`client.js` 没有构建步骤，也**不能有**：它是一层 `__ModuleLoader__` 信封，任何打包器都会把这层信封改写成别的东西。

`npm run verify`（`scripts/verify-install.mjs`）专治这类回归：它用假上下文挂载**构建产物**，断言 9 个工具、1 个门禁、1 条面板路由都出现了，还检查浏览器半边——`dsh.client` 声明、`exports["./client"]`、`client.js` 真在 `files` 里、文件里确实调了 `__ModuleLoader__.load`。测试跑的是 `src/`，这些打包错误它一个也看不见。

## 后续方向

- **面板里能不能批准章纲**：v0.5 让面板建书（与 `init` 同一个函数），v0.6 又开了「挑模型」（与 `novel_roles` 同一个字段）。若要再往前一步到「批准章纲」，得先决定门禁的唯一性：可行做法是面板的写请求走同一套 `gateToolCall` 校验，而不是另开一条绕过闸门的路。
- **章节级并发写**：同一章被两个会话同时写时目前后者覆盖；需要带版本号的乐观锁。
- **审稿 DAG 落盘**：把 `novel_dispatch` 的 findings 存成结构化记录，支持跨会话追溯「这条意见谁提的、改了没有」。
