# 贡献

## 本地环境

```sh
npm install --legacy-peer-deps
npm run check
```

`--legacy-peer-deps` 是必要的：墨井在运行时只依赖 Harness 提供的
`@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis` 和 `@deepseek-ai/schemastery`，
`devDependencies` 里那一串 `@deepseek-ai/dsh-*` 是它们的对等依赖闭包，只为让测试
能 import 到真实的 `defineTool`。真正的宿主环境自带这些包，不会重复安装。

## 提交前

```sh
npm run typecheck   # tsc --noEmit，零错误
npm test            # vitest
npm run build       # 产出 lib/
```

三个都过再提交。CI 跑的是同一组命令。

## 代码约定

- **`src/domain/` 里不许出现 `ctx`。** 约束逻辑必须是纯函数或纯读写，能脱离
  Harness 单测。这一条是项目的立身之本。
- **新增一条「会拒绝」的规则，必须在 `test/` 里有对应用例**，并且用例要断言拒绝
  的**理由**，而不只是 `ok === false`——模型看到的就是这段文字。
- **阈值进 `src/config.ts`**，不要写死在函数里。作者口味不是部署常量。
- **`any` 只允许出现在测试的假宿主里**，并且要写清为什么。
- 导入本地文件带 `.ts` 后缀（构建时由 `rewriteRelativeImportExtensions` 改写）。

## 加一个新工具

1. 在 `src/domain/` 写纯逻辑与测试；
2. 在 `src/tools/<name>.ts` 里 `defineTool`，`render` 只回一段文本；
3. 在 `src/index.ts` 注册；
4. 如果是「必须拦住」的调用，在 `src/gate.ts` 加分支，并在 `test/e2e.test.ts`
   里补一条被拒绝的路径。

## 提交信息

Conventional Commits：

```text
feat(domain): 账本支持跨章改写的显式替换
fix(gate): 章纲未批准时不再提示阶段错误
docs: 补充确定性边界说明
```

## 报告问题

请附上：阶段、`novel_check action="all"` 的输出、以及能复现的最小项目结构。
设定内容可以脱敏，但保留结构。
