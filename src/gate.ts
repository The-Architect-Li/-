/**
 * Pre-dispatch gate.
 *
 * This is the point where "please don't skip the outline" becomes a refusal
 * instead of a suggestion. The check runs on `tools/pre-execute`, before the
 * tool body, so a blocked call costs nothing and the model gets a reason it can
 * act on.
 */
import type { InkwellConfig, Snapshot } from './domain/types.ts'
import { PROJECT_FILE, ProjectMissingError, ProjectStore } from './domain/store.ts'
import { atLeast, blockersFor } from './domain/phase.ts'

/** Tools this plugin owns. Anything else is none of its business. */
export function isInkwellTool(name: string): boolean {
  return name === 'novel_project' || name.startsWith('novel_')
}

function readString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value : ''
}

function readNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Decide whether a call may proceed.
 *
 * @param name - tool name.
 * @param rawArgs - model-generated arguments, unvalidated.
 * @param store - project reader.
 * @param config - resolved thresholds.
 * @returns a denial reason, or `null` to allow.
 */
export async function gateToolCall(
  name: string,
  rawArgs: unknown,
  store: ProjectStore,
  config: InkwellConfig,
): Promise<string | null> {
  const args = (rawArgs ?? {}) as Record<string, unknown>
  const action = readString(args, 'action')

  if (name === 'novel_project' && action === 'init') return null

  // The book-switching actions exist *because* the session may be pointed at the
  // wrong place: `books` lists what is here, `open` moves to another book, and
  // `close` goes back to the workspace. Requiring a project first would make the
  // escape hatch usable only by someone who does not need it.
  if (name === 'novel_project' && (action === 'books' || action === 'open' || action === 'close')) return null

  if (!(await store.exists())) {
    // Naming the directory is the whole point: with per-workspace roots, "no
    // project" is ambiguous until the caller sees where we looked.
    return [
      `还没有 Inkwell 项目（在 ${store.root} 没找到 ${PROJECT_FILE}）。`,
      '先调用 novel_project，action="init"。',
      '如果书在别处：确认当前会话的工作目录，或把配置 root 设成绝对路径、或用 perWorkspace=false 固定到进程目录。',
    ].join('')
  }

  let snapshot: Snapshot
  try {
    snapshot = await store.snapshot()
  } catch (error) {
    if (error instanceof ProjectMissingError) return error.message
    throw error
  }

  if (name === 'novel_chapter' && (action === 'write' || action === 'propose')) {
    const number = readNumber(args, 'number')
    if (number === undefined) return 'novel_chapter 的 write/propose 需要 number。'

    if (!atLeast(snapshot.project.phase, 'drafting')) {
      const blockers = blockersFor('drafting', snapshot, config)
      return [
        `当前还在「${snapshot.project.phase}」阶段，不能写正文。`,
        '要进入 drafting，先补齐：',
        ...blockers.map((item) => `- ${item}`),
      ].join('\n')
    }

    const plan = snapshot.plans.find((item) => item.number === number)
    if (!plan) {
      return `第${number}章还没有章纲。先调用 novel_outline，action="add_chapter"。没有章纲的章节不允许写。`
    }
    if (!plan.approved) {
      return `第${number}章的章纲还没批准。先调用 novel_outline，action="approve_chapter"，确认节拍和出场人物后再动笔。`
    }
  }

  if (name === 'novel_dispatch' && action === 'writer') {
    const number = readNumber(args, 'number')
    if (number === undefined) return 'novel_dispatch 的 writer 需要 number。'
    if (!atLeast(snapshot.project.phase, 'drafting')) {
      return [
        `当前还在「${snapshot.project.phase}」阶段，不能派写手。`,
        ...blockersFor('drafting', snapshot, config).map((item) => `- ${item}`),
      ].join('\n')
    }
    const plan = snapshot.plans.find((item) => item.number === number)
    if (!plan) return `第${number}章没有章纲，不能派写手。`
    if (!plan.approved) return `第${number}章的章纲未批准，不能派写手。`
  }

  if (name === 'novel_dispatch' && (action === 'logic' || action === 'character' || action === 'chief')) {
    const number = readNumber(args, 'number')
    if (number === undefined) return `novel_dispatch 的 ${action} 需要 number。`
    const plan = snapshot.plans.find((item) => item.number === number)
    if (!plan) return `第${number}章没有章纲。`
    // A reviewer needs a draft to read; the body re-checks, but failing here is cheaper.
    const drafts = await store.draftsOf(number)
    if (drafts.length === 0) {
      return `第${number}章还没有草稿。先派 writer，再 novel_chapter action="propose"，然后才能审核。`
    }
  }

  if (name === 'novel_outline' && (action === 'add_volume' || action === 'add_chapter')) {
    if (!atLeast(snapshot.project.phase, 'outline')) {
      const blockers = blockersFor('outline', snapshot, config)
      return [
        `当前还在「${snapshot.project.phase}」阶段，不能搭大纲。`,
        '要进入 outline，先补齐：',
        ...blockers.map((item) => `- ${item}`),
      ].join('\n')
    }
  }

  if (name === 'novel_ledger' && action === 'record') {
    if (snapshot.project.phase === 'premise') {
      return '还没进入 canon 阶段。先把前提写清楚（novel_project，action="premise"），再开始记设定。'
    }
  }

  return null
}
