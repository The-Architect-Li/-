/** `novel_project`: create, inspect, and advance the project. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { bookKey } from '../domain/home.ts'
import { evaluateAdvance, nextPhase, requirementsFor } from '../domain/phase.ts'
import { sessionIdOf } from '../domain/scope.ts'
import { livePins, pinBook, pinnedRoot, sameBook, sessionsFile, unpinBook } from '../domain/session-books.ts'
import { describeBook, libraryFile, readShelf, rememberBook } from '../domain/shelf.ts'
import { ProjectStore } from '../domain/store.ts'
import { countChars } from '../domain/text.ts'
import type { ToolDeps } from './deps.ts'

/** One book as `novel_project action="books"` lists it. */
interface BookRow {
  root: string
  title: string
  phase: string
  chapters: number
  words: number
  /** True for the book this session would use right now. */
  current: boolean
}

/**
 * Every book this machine knows about.
 *
 * Three sources, in the order a writer would expect: the book this session
 * resolves to, the books other sessions pinned, then the panel's shelf. Books
 * whose directory is gone are dropped — a stale pointer is not a book.
 *
 * @param store - the store this session currently resolves to.
 * @returns the books that still exist on disk.
 */
async function listBooks(store: ProjectStore): Promise<BookRow[]> {
  const roots: string[] = []
  const push = (root: string): void => {
    if (!roots.some((known) => sameBook(known, root))) roots.push(root)
  }
  push(store.root)
  for (const root of livePins(sessionsFile()).values()) push(root)
  for (const entry of await readShelf(libraryFile())) push(entry.root)

  const rows: BookRow[] = []
  for (const root of roots) {
    const described = await describeBook(new ProjectStore(root))
    if (described === undefined) continue
    rows.push({
      root: described.root,
      title: described.title,
      phase: described.phase,
      chapters: described.chapters,
      words: described.words,
      current: sameBook(described.root, store.root),
    })
  }
  return rows
}

/**
 * Render the book list for the model to read back verbatim.
 *
 * @param rows - books that exist.
 * @returns a numbered report, one line per book.
 */
function formatBooks(rows: readonly BookRow[]): string {
  if (rows.length === 0) {
    return [
      '这台机器上还没有书。',
      '用 novel_project action="init" 在当前目录建一本，或者在右侧栏「小说工坊」里选目录新建。',
    ].join('\n')
  }
  const lines = rows.map((row, index) => {
    const mark = row.current ? '　← 这个会话在看它' : ''
    return `${index + 1}. ${row.title}　${row.phase} · ${row.chapters} 章 · ${row.words} 字　${row.root}${mark}`
  })
  return [
    `这台机器上记得的书（${rows.length} 本）：`,
    ...lines,
    '',
    'novel_project action="open" root="<路径>" 或 action="open" book="<书名>" 切书；action="close" 回到会话自己的工作目录。',
  ].join('\n')
}

/**
 * Find the book a writer asked for by path or by title.
 *
 * A path may name either the project directory itself or the container it sits
 * in: `.novel` is a convention, not a fact, so both are tried before giving up.
 *
 * @param root - an absolute or relative project directory, when given.
 * @param book - a title fragment, when given.
 * @param store - the store this session currently resolves to.
 * @returns the chosen book, with its absolute root.
 */
async function pickBook(
  root: string,
  book: string,
  store: ProjectStore,
): Promise<{ root: string; title: string }> {
  if (root === '' && book === '') {
    throw new Error('open 需要 root 或 book：给一个目录，或给一个书名。先用 novel_project action="books" 看看有哪些书。')
  }
  if (root !== '') {
    const candidates = [root, `${root.replace(/[\\/]+$/, '')}/.novel`]
    for (const candidate of candidates) {
      const store2 = new ProjectStore(candidate)
      if (await store2.exists()) {
        const project = await store2.readProject()
        return { root: store2.root, title: project.title }
      }
    }
    throw new Error(`没找到带 project.json 的目录：${root}（试过它本身和它下面的 .novel）。`)
  }
  const rows = await listBooks(store)
  const matches = rows.filter((row) => row.title.includes(book))
  if (matches.length === 0) {
    throw new Error(`没有书名包含「${book}」的书。先 novel_project action="books" 看看有哪些。`)
  }
  if (matches.length > 1) {
    const titles = matches.map((row) => `- ${row.title}（${row.root}）`).join('\n')
    throw new Error(`书名包含「${book}」的有 ${matches.length} 本，用 root 指定：\n${titles}`)
  }
  return { root: matches[0]!.root, title: matches[0]!.title }
}

/**
 * Register the project lifecycle tool.
 *
 * @param ctx - plugin context with the tool registry.
 * @param deps - store and resolved config.
 */
export function registerProjectTool(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'novel_project',
    description:
      '长篇小说的项目入口。init 建立项目目录；status 汇报当前阶段与卡点；premise 写入一句话前提；advance 推进到下一阶段（不够条件会被拒绝并列出缺什么）。任何写作开始前先调用 status。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['init', 'status', 'premise', 'advance', 'books', 'open', 'close'],
        description:
          'init 初始化 / status 查看状态 / premise 写前提 / advance 推进阶段 / books 列出这台机器上的书 / open 切到某本书 / close 回到会话自己的工作目录',
      },
      title: { type: 'string', description: 'init 时的书名' },
      targetWords: { type: 'number', description: 'init 时的目标总字数，默认 800000' },
      premise: { type: 'string', description: 'premise 时的一句话前提：主角是谁、想要什么、被什么阻拦' },
      root: {
        type: 'string',
        description: 'open 时的项目目录（含 project.json 的那层；也可以给它的上一级目录）',
      },
      book: { type: 'string', description: 'open 时按书名找，书名可以只写一部分' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          phase: { type: 'string' },
          title: { type: 'string' },
          next: { type: 'string' },
          blockers: { type: 'array', items: { type: 'string' } },
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '' }],
    },
    async execute(args, exec) {
      const store = deps.storeFor(exec)
      if (args.action === 'init') {
        const title = args.title?.trim() || '未命名'
        const project = await store.init(title, args.targetWords ?? 800000)
        // A book made here is a book the shelf should offer next time, even if
        // the panel is never opened in this workspace.
        await rememberBook(libraryFile(), store.root)
        return {
          phase: project.phase,
          title: project.title,
          next: 'canon',
          blockers: [],
          report: [
            `已创建项目《${project.title}》于 ${store.root}`,
            `阶段：${project.phase}`,
            '',
            '接下来：用 novel_project action="premise" 写一句话前提（主角/欲望/阻力），再 advance 进入 canon。',
          ].join('\n'),
        }
      }

      if (args.action === 'premise') {
        const project = await store.readProject()
        const premise = args.premise?.trim()
        if (!premise) {
          throw new Error('premise 不能为空。')
        }
        await store.writeProject({ ...project, premise })
        const length = countChars(premise)
        const ok = length >= deps.config.premiseMinChars
        return {
          phase: project.phase,
          title: project.title,
          next: 'canon',
          blockers: ok ? [] : [`前提至少 ${deps.config.premiseMinChars} 字（当前 ${length} 字）`],
          report: [
            `已写入前提（${length} 字）。`,
            ok
              ? '字数达标，可以 advance 进入 canon 阶段。'
              : `还差 ${deps.config.premiseMinChars - length} 字。前提要包含：主角是谁、他想要什么、什么在阻挡他。`,
          ].join('\n'),
        }
      }

      if (args.action === 'books') {
        const list = await listBooks(store)
        return {
          phase: '',
          title: '',
          next: '',
          blockers: [],
          report: formatBooks(list),
        }
      }

      if (args.action === 'open') {
        const sessionId = sessionIdOf(exec)
        if (sessionId === undefined) {
          throw new Error('open 必须在会话中调用：拿不到会话 id，没法记住你要切到哪本书。')
        }
        const target = await pickBook(args.root?.trim() || '', args.book?.trim() || '', store)
        pinBook(sessionsFile(), sessionId, target.root)
        // Opening a book is the clearest signal it belongs on the shelf: it is
        // how a book that was moved or created elsewhere becomes reachable again.
        await rememberBook(libraryFile(), target.root)
        const project = await new ProjectStore(target.root).readProject()
        return {
          phase: project.phase,
          title: project.title,
          next: nextPhase(project.phase) ?? '',
          blockers: [],
          report: [
            `已切到《${project.title}》（${project.phase}）于 ${target.root}`,
            '这个会话之后所有 novel_* 调用都作用在这本书上，侧边栏也跟着切。',
            '想回到会话自己的工作目录，用 novel_project action="close"。',
          ].join('\n'),
        }
      }

      if (args.action === 'close') {
        const sessionId = sessionIdOf(exec)
        if (sessionId === undefined) {
          throw new Error('close 必须在会话中调用：拿不到会话 id，没有可取消的指定。')
        }
        const wasPinned = pinnedRoot(sessionsFile(), sessionId)
        unpinBook(sessionsFile(), sessionId)
        const fallback = deps.storeFor(exec)
        const fallbackProject = (await fallback.exists()) ? await fallback.readProject() : undefined
        return {
          phase: fallbackProject?.phase ?? '',
          title: fallbackProject?.title ?? '',
          next: '',
          blockers: [],
          report: wasPinned === undefined
            ? `这个会话本来就没有指定书，仍然看 ${fallback.root}。`
            : [
                `已取消指定书（原来看的是 ${wasPinned}）。`,
                fallbackProject === undefined
                  ? `现在按会话工作目录找，${fallback.root} 下没有书——用 novel_project action="init" 建一本，或再用 open 切回去。`
                  : `现在回到 ${fallback.root} 的《${fallbackProject.title}》。`,
              ].join('\n'),
        }
      }

      const snapshot = await store.snapshot()

      if (args.action === 'advance') {
        const result = evaluateAdvance(snapshot, deps.config)
        if (result.done) {
          return {
            phase: snapshot.project.phase,
            title: snapshot.project.title,
            next: '',
            blockers: [],
            report: '已经是最后一个阶段。',
          }
        }
        if (!result.ok || !result.next) {
          return {
            phase: snapshot.project.phase,
            title: snapshot.project.title,
            next: result.next ?? '',
            blockers: result.blockers,
            report: [
              `不能进入「${result.next}」阶段，还缺：`,
              ...result.blockers.map((item) => `- ${item}`),
            ].join('\n'),
          }
        }
        await store.writeProject({ ...snapshot.project, phase: result.next })
        const upcoming = nextPhase(result.next)
        return {
          phase: result.next,
          title: snapshot.project.title,
          next: upcoming ?? '',
          blockers: [],
          report: [
            `已进入「${result.next}」阶段。`,
            upcoming ? describeNext(upcoming, snapshot, deps, store) : '',
          ].filter(Boolean).join('\n'),
        }
      }

      const upcoming = nextPhase(snapshot.project.phase)
      const requirements = upcoming ? requirementsFor(upcoming, snapshot, deps.config) : []
      const written = snapshot.chapters.length
      return {
        phase: snapshot.project.phase,
        title: snapshot.project.title,
        next: upcoming ?? '',
        blockers: requirements.filter((item) => !item.ok).map((item) => item.label),
        report: [
          `《${snapshot.project.title}》　阶段：${snapshot.project.phase}`,
          `角色 ${snapshot.characters.length} ｜ 世界观 ${snapshot.world.length} ｜ 分卷 ${snapshot.volumes.length} ｜ 章纲 ${snapshot.plans.length} ｜ 已写 ${written} 章 ｜ 账本 ${snapshot.ledger.length} 条`,
          snapshot.project.premise ? `\n前提：${snapshot.project.premise}` : '\n前提：还没写',
          upcoming
            ? [
                '',
                `下一阶段「${upcoming}」要求：`,
                ...requirements.map((item) => `${item.ok ? '✓' : '✗'} ${item.label}`),
              ].join('\n')
            : '',
        ].filter(Boolean).join('\n'),
      }
    },
  }))
}

function describeNext(
  target: string,
  snapshot: Awaited<ReturnType<ProjectStore['snapshot']>>,
  deps: ToolDeps,
  store: ProjectStore,
): string {
  switch (target) {
    case 'canon':
      return '接下来用 novel_canon 建立角色卡（至少 1 主角 + 1 配角，每人要有 voice）和世界观条目。'
    case 'outline':
      return '接下来用 novel_outline 建分卷，再逐章写章纲（每章至少 2 个必写节拍）。'
    case 'drafting':
      return '接下来用 novel_briefing 取本章上下文包，再 novel_chapter action="write" 落笔。'
    case 'review':
      return `共 ${snapshot.chapters.length} 章待审。用 novel_check action="all" 做确定性体检。`
    default:
      return `可以继续，也可以随时用 novel_project action="status" 查看卡点（root=${store.root}）。`
  }
}
