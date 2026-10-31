/**
 * The threads a book has left hanging.
 *
 * A fact ledger records what is true. A story point records an arc. Neither
 * records the third thing a long novel owes its reader: **a promise**. 「她把那
 * 封信塞进袖子里，没有拆」is planted in chapter 38 and paid off in chapter 200 or
 * never; by chapter 300 the author has forgotten which, and the reader has not.
 *
 * This is the only part of the bookkeeping that is about *unfinished* business,
 * which is why it cannot be folded into the ledger: a fact is either true or it
 * is not, while a thread is a debt with a due date nobody set.
 *
 * The rules that keep it useful:
 *
 * - a thread is planted with a chapter and the line it came from, so 「这是伏笔吗」
 *   can be answered by reading one sentence;
 * - it is paid, dropped, or open — three states, because a thread the author
 *   deliberately abandoned must stop showing up, and "abandoned" is not "paid";
 * - nothing here computes a "due date". A book decides its own pace, so the
 *   checker reports how many chapters have gone by and lets the author judge.
 */
import type { ProjectStore } from './store.ts'
import type { Finding } from './types.ts'

/** One promise the book has made and not yet settled. */
export interface Thread {
  /** Stable handle, e.g. `t-0007`. */
  id: string
  /** What was promised, in one line, in the author's words. */
  label: string
  /** The chapter it was planted in. */
  planted: number
  /** The sentence that planted it. */
  quote: string
  /** The chapter it was paid off in; 0 while it is still open. */
  paid: number
  /** How it was paid off, when the text says. */
  payoff?: string
  /** True when the author decided this line goes nowhere. */
  dropped: boolean
  notes?: string
  createdAt: string
}

/** What state one thread is in, for the report and the panel. */
export type ThreadState = 'open' | 'paid' | 'dropped'

/**
 * Which state a thread is in.
 *
 * @param thread - the thread.
 * @returns open, paid, or dropped.
 */
export function stateOf(thread: Thread): ThreadState {
  if (thread.dropped) return 'dropped'
  return thread.paid > 0 ? 'paid' : 'open'
}

/**
 * How many chapters have gone by since this thread was last touched.
 *
 * Counted from the payoff when there is one, from the planting otherwise — and
 * measured against the last chapter written, because "40 章没提" only means
 * something relative to how far the book has got.
 *
 * @param thread - the thread.
 * @param lastChapter - the highest chapter number written.
 * @returns chapters since it was last mentioned, never negative.
 */
export function ageInChapters(thread: Thread, lastChapter: number): number {
  const from = thread.paid > 0 ? thread.paid : thread.planted
  return Math.max(0, lastChapter - from)
}

/**
 * The open threads, oldest first.
 *
 * @param threads - every thread the book holds.
 * @returns the ones still owed to the reader.
 */
export function openThreads(threads: readonly Thread[]): Thread[] {
  return threads.filter((thread) => stateOf(thread) === 'open').sort((a, b) => a.planted - b.planted)
}

/** How many chapters may pass before an open thread is worth mentioning. */
export const STALE_AFTER = 30

/**
 * Report the threads that have been left hanging too long.
 *
 * The threshold is a nudge, not a rule: a planted promise is allowed to sit for
 * a hundred chapters if the book is building to it. What the report exists to
 * catch is the other case — the thread nobody remembers is a thread, not a
 * decision.
 *
 * @param threads - every thread.
 * @param lastChapter - the highest chapter written.
 * @param staleAfter - chapters after which an open thread is reported.
 * @returns findings, oldest thread first.
 */
export function staleThreads(
  threads: readonly Thread[],
  lastChapter: number,
  staleAfter: number = STALE_AFTER,
): Finding[] {
  return openThreads(threads)
    .map((thread) => ({ thread, age: ageInChapters(thread, lastChapter) }))
    .filter((item) => item.age >= staleAfter)
    .sort((a, b) => b.age - a.age)
    .map(({ thread, age }) => ({
      severity: 'warn' as const,
      code: 'thread/stale',
      message: `第${thread.planted}章埋的「${thread.label}」，${age} 章没动过。`,
      evidence: [thread.quote, '要么收，要么标记为不要了——一直挂着会让读者记着你已经忘了的事。']
        .filter((line) => line !== '')
        .join('\n'),
    }))
}

/**
 * Add one thread.
 *
 * @param store - the book.
 * @param input - what was planted, and where.
 * @returns the stored thread.
 */
export async function plantThread(
  store: ProjectStore,
  input: { label: string; chapter: number; quote?: string; notes?: string },
): Promise<Thread> {
  const label = input.label.trim()
  if (label === '') throw new Error('伏笔要有一句话：埋的是什么。')
  if (!Number.isInteger(input.chapter) || input.chapter < 1) {
    throw new Error(`埋在第几章？chapter 要是正整数，收到的是 ${String(input.chapter)}。`)
  }
  const threads = await store.threads()
  const thread: Thread = {
    id: nextThreadId(threads),
    label,
    planted: input.chapter,
    quote: (input.quote ?? '').trim(),
    paid: 0,
    dropped: false,
    ...(input.notes === undefined || input.notes.trim() === '' ? {} : { notes: input.notes.trim() }),
    createdAt: new Date().toISOString(),
  }
  await store.writeThreads([...threads, thread])
  return thread
}

/**
 * Mark a thread paid off.
 *
 * @param store - the book.
 * @param id - which thread.
 * @param chapter - the chapter that paid it.
 * @param payoff - how it was settled.
 * @returns the updated thread.
 * @throws when no thread carries that id.
 */
export async function payThread(
  store: ProjectStore,
  id: string,
  chapter: number,
  payoff?: string,
): Promise<Thread> {
  if (!Number.isInteger(chapter) || chapter < 1) {
    throw new Error(`收在第几章？chapter 要是正整数，收到的是 ${String(chapter)}。`)
  }
  const threads = await store.threads()
  const index = threads.findIndex((thread) => thread.id === id)
  if (index < 0) throw new Error(`没有这条伏笔：${id}。novel_ledger action="threads" 看看现有的。`)
  const updated: Thread = {
    ...threads[index]!,
    paid: chapter,
    dropped: false,
    ...(payoff === undefined || payoff.trim() === '' ? {} : { payoff: payoff.trim() }),
  }
  const next = [...threads]
  next[index] = updated
  await store.writeThreads(next)
  return updated
}

/**
 * Give up on a thread, deliberately.
 *
 * Kept as its own verb because "we are not doing this" and "we did this" are
 * different facts about a book, and only one of them should stop the reminder.
 *
 * @param store - the book.
 * @param id - which thread.
 * @param why - why it is being abandoned, when the author wants to say.
 * @returns the updated thread.
 */
export async function dropThread(store: ProjectStore, id: string, why?: string): Promise<Thread> {
  const threads = await store.threads()
  const index = threads.findIndex((thread) => thread.id === id)
  if (index < 0) throw new Error(`没有这条伏笔：${id}。`)
  const updated: Thread = {
    ...threads[index]!,
    dropped: true,
    ...(why === undefined || why.trim() === '' ? {} : { notes: why.trim() }),
  }
  const next = [...threads]
  next[index] = updated
  await store.writeThreads(next)
  return updated
}

/**
 * The next free handle.
 *
 * @param threads - existing threads.
 * @returns `t-0001` style id.
 */
export function nextThreadId(threads: readonly Thread[]): string {
  const highest = threads.reduce((max, thread) => {
    const value = Number(thread.id.slice(2))
    return Number.isFinite(value) ? Math.max(max, value) : max
  }, 0)
  return `t-${String(highest + 1).padStart(4, '0')}`
}

/** The glyph one thread's state shows as. */
const STATE_MARK: Record<ThreadState, string> = { open: '○', paid: '●', dropped: '×' }

/**
 * Every thread as a list a writer can read.
 *
 * Open ones come first and oldest first: the question the page answers is
 * 「我还有哪些没交代」, so a settled promise is history and belongs underneath.
 *
 * @param threads - every thread.
 * @param lastChapter - the highest chapter written, for the age column.
 * @returns the report.
 */
export function describeThreads(threads: readonly Thread[], lastChapter: number): string {
  if (threads.length === 0) {
    return [
      '还没有记过伏笔。',
      '埋的时候：novel_ledger action="plant" label="那封没拆的信" chapter=38 quote="她把信塞进袖子，没有拆。"',
      '这一条不会自己消失——写完几百章回来看，它会告诉你哪条线还欠着。',
    ].join('\n')
  }
  const open = openThreads(threads)
  const settled = threads.filter((thread) => stateOf(thread) !== 'open').sort((a, b) => a.planted - b.planted)
  const lines: string[] = []
  lines.push(`伏笔 ${threads.length} 条：还欠着 ${open.length} 条，已收或已弃 ${settled.length} 条。`)
  if (open.length > 0) {
    lines.push('', '还欠着的（埋得越久越靠前）：')
    for (const thread of [...open].sort((a, b) => ageInChapters(b, lastChapter) - ageInChapters(a, lastChapter))) {
      const age = ageInChapters(thread, lastChapter)
      const warn = age >= STALE_AFTER ? `　${age} 章没动` : ''
      lines.push(`  ${thread.id} 第${thread.planted}章「${thread.label}」${warn}`)
      if (thread.quote !== '') lines.push(`          「${thread.quote.slice(0, 40)}」`)
    }
    lines.push('', '收：novel_ledger action="pay" id="t-0001" chapter=N value="怎么收的"')
    lines.push('不要了：novel_ledger action="drop" id="t-0001" value="为什么不收了"')
  }
  if (settled.length > 0) {
    lines.push('', '已经有结果的：')
    for (const thread of settled) {
      const state = stateOf(thread)
      const where = state === 'paid' ? `第${thread.paid}章收` : '放弃了'
      lines.push(`  ${STATE_MARK[state]} ${thread.id} 第${thread.planted}章「${thread.label}」—— ${where}`)
    }
  }
  return lines.join('\n')
}
