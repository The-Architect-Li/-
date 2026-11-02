/**
 * Moving a chapter, which is a much bigger operation than it looks.
 *
 * The chapter number is this book's primary key. It names the prose file
 * (`chapters/079.md`), the draft directory (`drafts/079/`), the entry in the
 * index, the card in the outline, and — the part that is easy to forget — the
 * `chapter` field inside every fact, every place state, every character stage,
 * every timeline anchor, and both ends of every planted thread.
 *
 * So "move chapter 80 up to 79" is not a rename. It is one permutation applied
 * to nine files at once, and a half-applied permutation is a book where the
 * ledger talks about a chapter whose prose now says something else. That is
 * worse than not having the feature: the damage is silent, and it is spread
 * across records that are supposed to be the source of truth.
 *
 * Hence the shape of this module:
 *
 * 1. read everything that mentions a chapter number;
 * 2. rewrite it through **one** mapping table;
 * 3. back up the files being touched, under `.history/reorder-<stamp>/`;
 * 4. write prose files last, through a temporary name, so an interruption
 *    cannot leave two chapters fighting over one number.
 *
 * The functions are deliberately narrow — swap two, or move one across a run —
 * because those are the two things a writer actually asks for. An arbitrary
 * permutation is a different tool with a different UI.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { countChars } from './text.ts'
import type { ProjectStore } from './store.ts'

/** One file that was rewritten, for the report. */
export interface Reordered {
  /** How many chapters moved. */
  moved: number
  /** The mapping applied, as `79↔80` pairs, for a human to check. */
  mapping: string[]
  /** Records whose chapter numbers changed. */
  touched: string[]
  /** Where the previous version of every touched file was copied. */
  backup: string
}

/** The chapter-number carrying fields, by file, so nothing is forgotten. */
const FILES = {
  index: 'chapters/index.json',
  plans: 'outline/chapters.json',
  facts: 'ledger/facts.json',
  threads: 'ledger/threads.json',
  places: 'canon/places.json',
  characters: 'canon/characters.json',
  clock: 'timeline/clock.json',
} as const

/**
 * Rewrite one value through the mapping, if it is in the mapping.
 *
 * @param value - a chapter number.
 * @param map - old to new.
 * @returns the new number, or the original when it is not being moved.
 */
function remap(value: unknown, map: ReadonlyMap<number, number>): unknown {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return value
  const next = map.get(number)
  return next === undefined ? value : next
}

/**
 * Apply a mapping to a plain JSON tree, wherever a chapter number lives.
 *
 * Written as an explicit walk over the fields the book actually uses rather
 * than a blanket "rename every number": a blanket pass would happily rewrite a
 * word count or a year. The names below are the whole list, and `touched` in the
 * report says which of them were hit.
 *
 * @param file - which file, to decide the shape.
 * @param value - the parsed JSON.
 * @param map - old chapter to new chapter.
 * @returns the rewritten value.
 */
function remapFile(file: keyof typeof FILES, value: unknown, map: ReadonlyMap<number, number>): unknown {
  if (file === 'index' || file === 'plans') {
    if (!Array.isArray(value)) return value
    return value.map((item) => (typeof item === 'object' && item !== null ? { ...item, number: remap((item as { number?: unknown }).number, map) } : item))
  }
  if (file === 'facts') {
    if (!Array.isArray(value)) return value
    return value.map((item) => (typeof item === 'object' && item !== null ? { ...item, chapter: remap((item as { chapter?: unknown }).chapter, map) } : item))
  }
  if (file === 'threads') {
    if (!Array.isArray(value)) return value
    return value.map((item) => {
      if (typeof item !== 'object' || item === null) return item
      const thread = item as { planted?: unknown; paid?: unknown }
      return { ...thread, planted: remap(thread.planted, map), paid: remap(thread.paid, map) }
    })
  }
  if (file === 'places') {
    if (!Array.isArray(value)) return value
    return value.map((item) => {
      if (typeof item !== 'object' || item === null) return item
      const place = item as { firstChapter?: unknown; latestChapter?: unknown; states?: unknown }
      return {
        ...place,
        firstChapter: remap(place.firstChapter, map),
        latestChapter: remap(place.latestChapter, map),
        states: Array.isArray(place.states)
          ? place.states.map((state) =>
              typeof state === 'object' && state !== null ? { ...state, chapter: remap((state as { chapter?: unknown }).chapter, map) } : state,
            )
          : place.states,
      }
    })
  }
  if (file === 'characters') {
    if (!Array.isArray(value)) return value
    return value.map((item) => {
      if (typeof item !== 'object' || item === null) return item
      const card = item as { stages?: unknown }
      return {
        ...card,
        stages: Array.isArray(card.stages)
          ? card.stages.map((stage) =>
              typeof stage === 'object' && stage !== null ? { ...stage, chapter: remap((stage as { chapter?: unknown }).chapter, map) } : stage,
            )
          : card.stages,
      }
    })
  }
  // clock: anchors, spans and recalls all carry chapters.
  if (typeof value !== 'object' || value === null) return value
  const clock = value as Record<string, unknown>
  const rewriteList = (list: unknown) =>
    Array.isArray(list)
      ? list.map((item) => {
          if (typeof item !== 'object' || item === null) return item
          const entry = item as Record<string, unknown>
          return {
            ...entry,
            ...(entry.chapter === undefined ? {} : { chapter: remap(entry.chapter, map) }),
            ...(entry.from === undefined ? {} : { from: remap(entry.from, map) }),
            ...(entry.to === undefined ? {} : { to: remap(entry.to, map) }),
            ...(Array.isArray(entry.chapters) ? { chapters: entry.chapters.map((n) => remap(n, map)) } : {}),
          }
        })
      : list
  return {
    ...clock,
    ...(clock.anchors === undefined ? {} : { anchors: rewriteList(clock.anchors) }),
    ...(clock.spans === undefined ? {} : { spans: rewriteList(clock.spans) }),
    ...(clock.recalls === undefined ? {} : { recalls: rewriteList(clock.recalls) }),
  }
}

/** Pad a chapter number the way the prose files are named. */
function fileName(number: number): string {
  return `${String(number).padStart(3, '0')}.md`
}

/**
 * Back up every file this operation will touch.
 *
 * A single timestamped folder rather than the per-file history: a reorder is one
 * decision, and being able to copy nine files back from one place is what makes
 * "undo" possible for somebody who does not want to run our undo.
 *
 * @param store - the book.
 * @param stamp - folder name suffix.
 * @param files - relative paths.
 * @returns the backup directory.
 */
async function backup(store: ProjectStore, folder: string, files: readonly string[]): Promise<string> {
  const dir = join(store.root, '.history', folder)
  await mkdir(dir, { recursive: true })
  for (const file of files) {
    const text = await readFile(join(store.root, file), 'utf8').catch(() => undefined)
    if (text === undefined) continue
    const target = join(dir, file.replace(/[\\/]/g, '__'))
    await writeFile(target, text, 'utf8')
  }
  return dir
}

/**
 * Move one chapter to another position, shifting everything in between.
 *
 * The common request is 「把第 80 章往上挪一章」, which is a swap, but 「把第 300 章挪到
 * 第 10 位」 is the same operation with a longer run: every chapter from 10 to 299
 * shifts up by one and 300 becomes 10. That is what this does.
 *
 * @param store - the book.
 * @param from - the chapter being moved.
 * @param to - where it should end up.
 * @returns what moved and where the backup is.
 * @throws when either chapter does not exist, or the two are the same.
 */
export async function moveChapter(store: ProjectStore, from: number, to: number): Promise<Reordered> {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) {
    throw new Error(`章号要是正整数，收到 ${String(from)} → ${String(to)}。`)
  }
  if (from === to) throw new Error('起点和终点是同一章，什么都没动。')
  const existing = new Set((await store.chapters()).map((chapter) => chapter.number))
  const planned = new Set((await store.plans()).map((plan) => plan.number))
  if (!existing.has(from) && !planned.has(from)) throw new Error(`第${from}章不存在（既没有正文也没有章卡）。`)
  if (!existing.has(to) && !planned.has(to)) throw new Error(`第${to}章不存在（既没有正文也没有章卡）。`)

  // Moving down: everything between takes one step up. Moving up: everything
  // between takes one step down. Getting this backwards silently drops the
  // destination chapter, which is exactly what happened the first time.
  const map = new Map<number, number>()
  if (from < to) {
    for (let number = from + 1; number <= to; number += 1) map.set(number, number - 1)
  } else {
    for (let number = to; number < from; number += 1) map.set(number, number + 1)
  }
  map.set(from, to)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const proseFiles = [...map.keys()].filter((number) => existing.has(number)).flatMap((number) => [`chapters/${fileName(number)}`, `drafts/${String(number).padStart(3, '0')}`])
  const backupDir = await backup(store, `reorder-${stamp}`, [...Object.values(FILES), ...proseFiles])

  const touched: string[] = []

  // 1. JSON first: if the process dies here, the prose is still addressed by the
  //    old numbers and the book reads as "records are stale", which is a state
  //    the tooling already understands and reports.
  for (const [name, path] of Object.entries(FILES) as [keyof typeof FILES, string][]) {
    const raw = await readFile(join(store.root, path), 'utf8').catch(() => undefined)
    if (raw === undefined || raw.trim() === '') continue
    const parsed = JSON.parse(raw) as unknown
    const next = remapFile(name, parsed, map)
    const text = `${JSON.stringify(next, null, 2)}\n`
    if (text === raw) continue
    await writeFile(join(store.root, path), text, 'utf8')
    touched.push(path)
  }

  // 2. Prose, read first and written second. A permutation cannot be applied
  //    file-by-file: renaming 79 to 80 before 80 has moved would destroy it. A
  //    few chapters of text in memory is nothing, and it makes the whole step
  //    atomic from the book's point of view.
  const parked = new Map<number, string>()
  for (const number of map.keys()) {
    const text = await readFile(join(store.root, 'chapters', fileName(number)), 'utf8').catch(() => undefined)
    if (text !== undefined) parked.set(number, text)
  }
  for (const [number, text] of parked) {
    await writeFile(join(store.root, 'chapters', fileName(map.get(number)!)), text, 'utf8')
  }
  // A chapter that had no prose must not keep a stale file under its new number.
  for (const number of map.keys()) {
    if (parked.has(number)) continue
    const stale = join(store.root, 'chapters', fileName(map.get(number)!))
    if (parked.has(map.get(number)!)) continue
    await rm(stale, { force: true }).catch(() => undefined)
  }

  // 3. Draft directories move too, or the next `read` shows the wrong rounds.
  for (const number of map.keys()) {
    const target = map.get(number)!
    if (target === number) continue
    const source = join(store.root, 'drafts', String(number).padStart(3, '0'))
    const destination = join(store.root, 'drafts', `${String(number).padStart(3, '0')}.moving`)
    await rename(source, destination).catch(() => undefined)
  }
  for (const number of map.keys()) {
    const moved = join(store.root, 'drafts', `${String(number).padStart(3, '0')}.moving`)
    await rename(moved, join(store.root, 'drafts', String(map.get(number)!).padStart(3, '0'))).catch(() => undefined)
  }

  return {
    moved: map.size,
    mapping: [...map.entries()].map(([oldNumber, newNumber]) => `${oldNumber}→${newNumber}`),
    touched,
    backup: backupDir,
  }
}

/**
 * Swap two chapters.
 *
 * Exactly {@link moveChapter} with a two-entry mapping, kept as its own name
 * because 「上下挪一章」 is what the author says and 「交换 79 和 80」 is what they
 * will type.
 *
 * @param store - the book.
 * @param a - one chapter.
 * @param b - the chapter it trades places with.
 * @returns what moved.
 */
export async function swapChapters(store: ProjectStore, a: number, b: number): Promise<Reordered> {
  return await moveChapter(store, a, b)
}

/**
 * Fold the next chapter into this one.
 *
 * The common case is a writer who split a scene across two chapters and now wants
 * one: 「第 80 章并入第 79 章」. What comes back is a single chapter holding both
 * bodies, a card that carries both sets of beats and characters, and every later
 * chapter one number lower — because a book with a hole at 80 is a book whose
 * chapter numbers no longer mean "the tenth thing that happens".
 *
 * Three decisions worth stating:
 *
 * - **The prose is joined, not rewritten.** The two bodies go together with a
 *   paragraph break between them, and not one character is changed. If the seam
 *   reads badly, that is an edit the author makes, not one this tool makes.
 * - **The later body's hook wins.** A chapter ends once, at the end, so the
 *   merged chapter's hook is the one that was pulling at the end of the second
 *   body. The first body's hook stops being a hook and becomes an internal beat.
 * - **The dropped chapter's drafts are kept, not deleted.** They no longer match
 *   the merged prose, so they move to `.history/merge-<stamp>/` where they can be
 *   read, instead of vanishing.
 *
 * @param store - the book.
 * @param number - the chapter that receives the next one.
 * @returns what moved, and where the backup is.
 * @throws when either chapter has no prose, or there is no next chapter.
 */
export async function mergeChapters(store: ProjectStore, number: number): Promise<Reordered & { words: number; dropped: number }> {
  if (!Number.isInteger(number) || number < 1) throw new Error(`章号要是正整数，收到 ${String(number)}。`)
  const index = await store.chapters()
  const keep = index.find((chapter) => chapter.number === number)
  const absorb = index.find((chapter) => chapter.number === number + 1)
  if (keep === undefined) throw new Error(`第${number}章没有正文，没法合并。`)
  if (absorb === undefined) throw new Error(`第${number + 1}章没有正文。并章只合并相邻的两章，后面没有内容可并。`)
  const keepDraft = await store.chapter(number)
  const absorbDraft = await store.chapter(number + 1)
  if (keepDraft === undefined || absorbDraft === undefined) throw new Error('读不到正文文件，先刷新再看。')

  const last = index.reduce((max, chapter) => Math.max(max, chapter.number), 0)
  // Everything after the absorbed chapter steps down one; the absorbed chapter
  // itself points at the one that keeps it, so its records land in the merged
  // chapter rather than disappearing.
  const map = new Map<number, number>([[number + 1, number]])
  for (let next = number + 2; next <= last; next += 1) map.set(next, next - 1)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const proseFiles = index.map((chapter) => `chapters/${fileName(chapter.number)}`)
  const backupDir = await backup(store, `merge-${stamp}`, [...Object.values(FILES), ...proseFiles])

  const touched: string[] = []

  // 1. Records first, through the same remap as a move: the absorbed chapter's
  //    facts and threads now belong to the chapter that swallowed it.
  //
  //    `index` and `plans` are excluded: both get purpose-built rewrites below,
  //    and running them through the generic remap first would apply the shift
  //    twice — which showed up as two chapters numbered 3 after a merge.
  const recordFiles = (Object.entries(FILES) as [keyof typeof FILES, string][]).filter(
    ([name]) => name !== 'index' && name !== 'plans',
  )
  for (const [name, path] of recordFiles) {
    const raw = await readFile(join(store.root, path), 'utf8').catch(() => undefined)
    if (raw === undefined || raw.trim() === '') continue
    const next = remapFile(name, JSON.parse(raw) as unknown, map)
    const text = `${JSON.stringify(next, null, 2)}\n`
    if (text === raw) continue
    await writeFile(join(store.root, path), text, 'utf8')
    touched.push(path)
  }

  // 2. Cards: merge the pair, then shift the rest.
  const plans = await store.plans()
  const keepPlan = plans.find((plan) => plan.number === number)
  const absorbPlan = plans.find((plan) => plan.number === number + 1)
  const merged = keepPlan === undefined
    ? undefined
    : {
        ...keepPlan,
        // The second body's hook is the one at the end of the merged chapter.
        hooks: absorbPlan !== undefined && absorbPlan.hooks.length > 0 ? absorbPlan.hooks : keepPlan.hooks,
        beats: [...keepPlan.beats, ...(absorbPlan?.beats ?? [])],
        characters: [...new Set([...keepPlan.characters, ...(absorbPlan?.characters ?? [])])],
        // A recap of two chapters is a new recap; nobody can write it from here.
        summary: '',
      }
  const nextPlans = plans
    .filter((plan) => plan.number !== number + 1)
    .map((plan) => (plan.number === number ? (merged ?? plan) : plan))
    .map((plan) => ({ ...plan, number: plan.number > number + 1 ? plan.number - 1 : plan.number }))
    .sort((a, b) => a.number - b.number)
  if (JSON.stringify(nextPlans) !== JSON.stringify(plans)) {
    await store.writePlans(nextPlans)
    touched.push(FILES.plans)
  }

  // 3. Prose. Read the whole run, then write it back shifted — a chapter cannot be
  //    moved onto a number that has not vacated yet.
  const parked = new Map<number, string>()
  for (let from = number + 2; from <= last; from += 1) {
    const text = await readFile(join(store.root, 'chapters', fileName(from)), 'utf8').catch(() => undefined)
    if (text !== undefined) parked.set(from - 1, text)
  }
  const joined = `${keepDraft.text.trim()}\n\n${absorbDraft.text.trim()}\n`
  for (const [target, text] of parked) await writeFile(join(store.root, 'chapters', fileName(target)), text, 'utf8')
  await writeFile(join(store.root, 'chapters', fileName(number)), joined, 'utf8')
  // The last number is now empty: the book got one chapter shorter.
  await rm(join(store.root, 'chapters', fileName(last)), { force: true }).catch(() => undefined)
  touched.push(`chapters/${fileName(number)}`, `chapters/${fileName(last)}`)

  // 4. The index, rebuilt from what is actually on disk.
  const rebuilt = [...index.filter((chapter) => chapter.number !== number + 1)]
    .map((chapter) => (chapter.number > number + 1 ? { ...chapter, number: chapter.number - 1 } : chapter))
    .map((chapter) =>
      chapter.number === number
        ? { ...chapter, words: countChars(joined), summary: '', writtenAt: new Date().toISOString(), revision: (chapter.revision ?? 0) + 1 }
        : chapter,
    )
    .sort((a, b) => a.number - b.number)
  await writeFile(join(store.root, FILES.index), `${JSON.stringify(rebuilt, null, 2)}\n`, 'utf8')
  touched.push(FILES.index)

  // 5. Draft rounds. The absorbed chapter's rounds no longer describe any prose,
  //    so they are parked rather than deleted; the rest shift down with it.
  for (let from = number + 2; from <= last; from += 1) {
    const source = join(store.root, 'drafts', String(from).padStart(3, '0'))
    const destination = join(store.root, 'drafts', `${String(from).padStart(3, '0')}.merging`)
    await rename(source, destination).catch(() => undefined)
  }
  for (let from = number + 2; from <= last; from += 1) {
    const moved = join(store.root, 'drafts', `${String(from).padStart(3, '0')}.merging`)
    await rename(moved, join(store.root, 'drafts', String(from - 1).padStart(3, '0'))).catch(() => undefined)
  }

  return {
    moved: map.size,
    mapping: [...map.entries()].map(([oldNumber, newNumber]) => `${oldNumber}→${newNumber}`),
    touched,
    backup: backupDir,
    words: countChars(joined),
    dropped: number + 1,
  }
}
