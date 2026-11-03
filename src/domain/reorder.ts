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
import type { ChapterOrigin } from './types.ts'
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

/** Sentinel a delete-map uses: this chapter number is gone, records citing it go too. */
const DELETED = -1

/**
 * Apply a delete-map to one JSON tree: records whose chapter was deleted are
 * dropped entirely, the rest shift.
 *
 * @param file - which record file this is.
 * @param value - the parsed JSON.
 * @param map - old chapter number → new number, or {@link DELETED}.
 * @returns the transformed value; `undefined` where the caller should drop records.
 */
function deleteMapFile(file: keyof typeof FILES, value: unknown, map: ReadonlyMap<number, number>): unknown {
  const dropCiting = <T>(list: T[], chapterOf: (item: T) => unknown): T[] =>
    list.filter((item) => remap(chapterOf(item), map) !== DELETED)
  if (file === 'facts') {
    if (!Array.isArray(value)) return value
    return dropCiting(value as unknown[], (item) => (item as { chapter?: unknown }).chapter).map((item) => ({
      ...(item as Record<string, unknown>),
      chapter: remap((item as { chapter?: unknown }).chapter, map),
    }))
  }
  if (file === 'threads') {
    if (!Array.isArray(value)) return value
    return (value as unknown[]).filter((item) => {
      if (typeof item !== 'object' || item === null) return true
      const thread = item as { planted?: unknown; paid?: unknown }
      return remap(thread.planted, map) !== DELETED
    })
  }
  if (file === 'places') {
    if (!Array.isArray(value)) return value
    return (value as unknown[]).map((item) => {
      if (typeof item !== 'object' || item === null) return item
      const place = item as { states?: { chapter?: unknown }[] }
      return {
        ...place,
        states: dropCiting(place.states ?? [], (state) => state.chapter).map((state) => ({
          ...state,
          chapter: remap(state.chapter, map),
        })),
      }
    })
  }
  if (file === 'characters') {
    if (!Array.isArray(value)) return value
    return (value as unknown[]).map((item) => {
      if (typeof item !== 'object' || item === null) return item
      const card = item as { stages?: { chapter?: unknown }[] }
      return {
        ...card,
        stages: dropCiting(card.stages ?? [], (stage) => stage.chapter).map((stage) => ({
          ...stage,
          chapter: remap(stage.chapter, map),
        })),
      }
    })
  }
  if (file === 'clock') {
    if (typeof value !== 'object' || value === null) return value
    const clock = value as {
      anchors?: { chapter?: unknown }[]
      spans?: { fromChapter?: unknown; toChapter?: unknown }[]
      recalls?: { chapter?: unknown }[]
    }
    return {
      ...clock,
      anchors: dropCiting(clock.anchors ?? [], (anchor) => anchor.chapter).map((anchor) => ({
        ...anchor,
        chapter: remap((anchor as { chapter?: unknown }).chapter, map),
      })),
      // A span anchored at both ends of a deleted chapter has no duration left.
      spans: (clock.spans ?? [])
        .filter((span) => remap(span.fromChapter, map) !== DELETED && remap(span.toChapter, map) !== DELETED)
        .map((span) => ({ ...span, fromChapter: remap(span.fromChapter, map), toChapter: remap(span.toChapter, map) })),
      recalls: dropCiting(clock.recalls ?? [], (recall) => recall.chapter).map((recall) => ({
        ...recall,
        chapter: remap((recall as { chapter?: unknown }).chapter, map),
      })),
    }
  }
  return value
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
    // Sorted after the remap, not before: changing the numbers reorders the list
    // logically but not physically, and a swapped pair then sits in the file as
    // 1, 3, 2, 4. Every reader that trusts the file order then shows the chapters
    // out of sequence.
    return value
      .map((item) => (typeof item === 'object' && item !== null ? { ...item, number: remap((item as { number?: unknown }).number, map) } : item))
      .sort((a, b) => Number((a as { number?: unknown }).number ?? 0) - Number((b as { number?: unknown }).number ?? 0))
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

  // Mark the chapter that actually moved. The rest only shifted by one, and
  // saying 「原来在第 N 章」 about a chapter nobody chose to move would be noise.
  await markOrigin(store, map.get(from) ?? from, { kind: 'moved', from: [from], at: new Date().toISOString() })

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
 * Record where a chapter came from, on its index entry.
 *
 * Written straight to the index rather than through `writeChapter`, which would
 * also bump the revision: a move does not change the text, and a revision bump
 * would make the next save look like a concurrent edit.
 *
 * @param store - the book.
 * @param number - the chapter's current number.
 * @param origin - what it used to be.
 */
/**
 * Renumber every surviving chapter into 1..N in order; the selected ones map to
 * {@link DELETED}. Chapters before the first deletion keep their numbers (the
 * compression happens to coincide with identity there).
 *
 * @param all - every chapter number that exists.
 * @param selected - the chapters an operation removes.
 * @returns old number → new number, or {@link DELETED}.
 */
function buildDeleteMap(all: readonly number[], selected: ReadonlySet<number>): Map<number, number> {
  const map = new Map<number, number>()
  let next = 0
  for (const number of [...all].sort((a, b) => a - b)) {
    if (selected.has(number)) {
      map.set(number, DELETED)
      continue
    }
    next += 1
    map.set(number, next)
  }
  return map
}

/**
 * Fold chapters `a+1..b` into `a` and shift everything after `b` up by `b-a`.
 *
 * @param all - every chapter number that exists.
 * @param a - the chapter that keeps the merged content.
 * @param b - the last chapter folded into it.
 * @returns old number → new number.
 */
function buildMergeMap(all: readonly number[], a: number, b: number): Map<number, number> {
  const map = new Map<number, number>()
  for (const number of all) {
    if (number > a && number <= b) map.set(number, a)
    else if (number > b) map.set(number, number - (b - a))
    else map.set(number, number)
  }
  return map
}

/**
 * Apply a chapter map to the whole book: record files, prose, drafts, reviews,
 * and the index. `DELETED` targets disappear; everything else lands on its new
 * number. Callers have already taken the backup.
 *
 * @param store - the book.
 * @param map - old number → new number, or {@link DELETED}.
 * @param mergeCards - when set, the cards of chapters `a+1..b` are folded into
 *   chapter `a`'s card (beats joined, characters deduped, last hook kept,
 *   summary emptied) instead of the later ones merely shifting.
 * @returns the files it wrote.
 */
async function applyChapterMap(
  store: ProjectStore,
  map: ReadonlyMap<number, number>,
  mergeCards?: { a: number; b: number },
): Promise<string[]> {
  const touched: string[] = []

  // 1. Records.
  const recordFiles = (Object.entries(FILES) as [keyof typeof FILES, string][]).filter(
    ([name]) => name !== 'index' && name !== 'plans',
  )
  for (const [name, path] of recordFiles) {
    const raw = await readFile(join(store.root, path), 'utf8').catch(() => undefined)
    if (raw === undefined || raw.trim() === '') continue
    const next = deleteMapFile(name, JSON.parse(raw) as unknown, map)
    const text = `${JSON.stringify(next, null, 2)}\n`
    if (text === raw) continue
    await writeFile(join(store.root, path), text, 'utf8')
    touched.push(path)
  }

  // 2. Cards. A merged range folds its cards into the first one; a delete just
  //    drops the selected ones and renumbers. The fold happens in the OLD number
  //    space, before the renumber — otherwise the folded card and the keep card
  //    both land on the same new number and the merge never finds its range.
  const plans = await store.plans()
  const foldedPlans = mergeCards === undefined
    ? []
    : plans.filter((plan) => plan.number > mergeCards.a && plan.number <= mergeCards.b)
  const kept = plans.filter(
    (plan) =>
      !(mergeCards !== undefined && plan.number > mergeCards.a && plan.number <= mergeCards.b) &&
      remap(plan.number, map) !== DELETED,
  )
  let nextPlans = kept
    .map((plan) => ({ ...plan, number: remap(plan.number, map) as number }))
    .sort((a, b) => a.number - b.number)
  if (mergeCards !== undefined && foldedPlans.length > 0) {
    const head = nextPlans.find((plan) => plan.number === mergeCards.a)
    if (head !== undefined) {
      const lastHook = [...foldedPlans].reverse().find((plan) => plan.hooks.length > 0)?.hooks ?? head.hooks
      nextPlans = nextPlans.map((plan) =>
        plan.number === mergeCards.a
          ? {
              ...head,
              hooks: lastHook,
              beats: [...head.beats, ...foldedPlans.flatMap((plan) => plan.beats)],
              characters: [...new Set([...head.characters, ...foldedPlans.flatMap((plan) => plan.characters)])],
              summary: '',
              // The prose was joined in this same operation; the card describes it.
              cardRevision: (head.cardRevision ?? 0) + 1,
            }
          : plan,
      )
    }
  }
  if (JSON.stringify(nextPlans) !== JSON.stringify(plans)) {
    await store.writePlans(nextPlans)
    touched.push(FILES.plans)
  }

  // 3. Prose, drafts, reviews: two-phase so a target never gets clobbered by a
  //    source that has not moved yet.
  const proseByTarget = new Map<number, string>()
  for (const [oldNumber, newNumber] of map) {
    if (newNumber === DELETED || newNumber === oldNumber) continue
    // A folded chapter's prose does not land on the keep number — the caller
    // writes the joined text there; a raw copy would overwrite the first body.
    if (mergeCards !== undefined && newNumber === mergeCards.a && oldNumber > mergeCards.a) continue
    const text = await readFile(join(store.root, 'chapters', fileName(oldNumber)), 'utf8').catch(() => undefined)
    if (text !== undefined) proseByTarget.set(newNumber, text)
  }
  for (const [target, text] of proseByTarget) await writeFile(join(store.root, 'chapters', fileName(target)), text, 'utf8')
  for (const [oldNumber, newNumber] of map) {
    if (newNumber === DELETED) {
      await rm(join(store.root, 'chapters', fileName(oldNumber)), { force: true }).catch(() => undefined)
      await rm(join(store.root, 'drafts', String(oldNumber).padStart(3, '0')), { force: true, recursive: true }).catch(() => undefined)
      await rm(store.reviewPath(oldNumber), { force: true }).catch(() => undefined)
    } else if (newNumber !== oldNumber) {
      await rm(store.reviewPath(oldNumber), { force: true }).catch(() => undefined)
    }
  }
  const reviewByTarget = new Map<number, string>()
  for (const [oldNumber, newNumber] of map) {
    if (newNumber === DELETED || newNumber === oldNumber) continue
    const text = await readFile(store.reviewPath(oldNumber), 'utf8').catch(() => undefined)
    if (text !== undefined) reviewByTarget.set(newNumber, text)
  }
  for (const [target, text] of reviewByTarget) await writeFile(store.reviewPath(target), text, 'utf8')

  // 4. Index, rebuilt from the map.
  const index = await store.chapters()
  const rebuilt = index
    // A folded chapter's meta record is dropped: its card folded into the keep
    // chapter's, and keeping both would leave two chapters with one number.
    .filter((chapter) => {
      if (mergeCards !== undefined && chapter.number > mergeCards.a && chapter.number <= mergeCards.b) return false
      return remap(chapter.number, map) !== DELETED
    })
    .map((chapter) => ({ ...chapter, number: remap(chapter.number, map) as number }))
    .sort((a, b) => a.number - b.number)
  await writeFile(join(store.root, FILES.index), `${JSON.stringify(rebuilt, null, 2)}\n`, 'utf8')
  touched.push(FILES.index)
  return touched
}

/**
 * Delete chapters outright: the prose, drafts, reviews, cards, and every record
 * citing their numbers. Survivors renumber into the gaps.
 *
 * @param store - the book.
 * @param numbers - the chapters to delete.
 * @returns the mapping, backup path, and touched files.
 */
export async function deleteChapters(store: ProjectStore, numbers: readonly number[]): Promise<Reordered> {
  const cleaned = [...new Set(numbers)].filter((number) => Number.isInteger(number) && number >= 1).sort((a, b) => a - b)
  if (cleaned.length === 0) throw new Error('没有要删除的章号。')
  const index = await store.chapters()
  const all = index.map((chapter) => chapter.number)
  const existing = cleaned.filter((number) => all.includes(number))
  if (existing.length === 0) throw new Error('选中的章都没有正文，无从删除。')
  if (all.length - existing.length === 0) throw new Error('全书只剩这一章了。删除后书就是空的——整本删掉吧。')

  const map = buildDeleteMap(all, new Set(existing))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const proseFiles = all.map((chapter) => `chapters/${fileName(chapter)}`)
  const backupDir = await backup(store, `delete-batch-${stamp}`, [...Object.values(FILES), ...proseFiles])
  const touched = await applyChapterMap(store, map)
  return {
    moved: existing.length,
    mapping: existing.map((number) => `${number}→删`),
    touched,
    backup: backupDir,
  }
}

/** Single-chapter delete, kept for the routes and tests that speak of one chapter. */
export async function deleteChapter(store: ProjectStore, number: number): Promise<Reordered> {
  return deleteChapters(store, [number])
}

/**
 * Fold a run of consecutive chapters into the first one, in one backup.
 *
 * @param store - the book.
 * @param numbers - consecutive chapter numbers, in any order.
 * @returns the mapping, backup path, and touched files.
 */
export async function mergeChaptersBatch(store: ProjectStore, numbers: readonly number[]): Promise<Reordered> {
  const cleaned = [...new Set(numbers)].filter((number) => Number.isInteger(number) && number >= 1).sort((a, b) => a - b)
  if (cleaned.length < 2) throw new Error('合并至少要两张连续的章。')
  const a = cleaned[0]!
  const b = cleaned[cleaned.length - 1]!
  if (b - a !== cleaned.length - 1) throw new Error(`合并的章必须连续：选了 ${cleaned.join('、')}，中间有缺。`)
  const index = await store.chapters()
  const all = index.map((chapter) => chapter.number)
  const missing = cleaned.filter((number) => !all.includes(number))
  if (missing.length > 0) throw new Error(`第${missing.join('、')}章没有正文，合并不了。`)

  const map = buildMergeMap(all, a, b)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const proseFiles = all.map((chapter) => `chapters/${fileName(chapter)}`)
  const backupDir = await backup(store, `merge-batch-${stamp}`, [...Object.values(FILES), ...proseFiles])

  // Join the range's prose in order before the map moves anything: the texts
  // are read by old number, written to the keep number, and the tail file goes.
  const parts: string[] = []
  for (let number = a; number <= b; number += 1) {
    const chapter = await store.chapter(number)
    if (chapter === undefined) throw new Error(`读不到第${number}章的正文文件，先刷新再看。`)
    parts.push(chapter.text.trim())
  }
  const joined = `${parts.join('\n\n')}\n`

  const touched = await applyChapterMap(store, map, { a, b })
  await writeFile(join(store.root, 'chapters', fileName(a)), joined, 'utf8')

  // The merged chapter's own record: word count and a fresh revision, so the
  // card and staleness logic treat it as the new text it is.
  const indexNow = await store.chapters()
  const merged = indexNow.find((chapter) => chapter.number === a)
  if (merged !== undefined) {
    const revision = (merged.revision ?? 0) + 1
    const rebuilt = indexNow.map((chapter) =>
      chapter.number === a
        ? {
            ...chapter,
            words: countChars(joined),
            revision,
            writtenAt: new Date().toISOString(),
            origin: { kind: 'merged' as const, from: cleaned, at: new Date().toISOString() },
          }
        : chapter,
    )
    await writeFile(join(store.root, FILES.index), `${JSON.stringify(rebuilt, null, 2)}\n`, 'utf8')
    // The card now describes the merged prose: its revision must match the
    // chapter's, or the row will say 「卡过期」 the instant the merge lands.
    const plans = await store.plans()
    const nextPlans = plans.map((plan) =>
      plan.number === a ? { ...plan, cardRevision: revision } : plan,
    )
    await store.writePlans(nextPlans)
  }
  void merged

  return {
    moved: cleaned.length - 1,
    mapping: cleaned.slice(1).map((number) => `${number}→${a}`),
    touched,
    backup: backupDir,
  }
}

/** Two-chapter merge, kept for the routes and tests that speak of one join. */
export async function mergeChapters(store: ProjectStore, number: number): Promise<Reordered & { words: number; dropped: number }> {
  const result = await mergeChaptersBatch(store, [number, number + 1])
  const index = await store.chapters()
  const merged = index.find((chapter) => chapter.number === number)
  return { ...result, words: merged?.words ?? 0, dropped: number + 1 }
}

async function markOrigin(store: ProjectStore, number: number, origin: ChapterOrigin): Promise<void> {
  const raw = await readFile(join(store.root, FILES.index), 'utf8').catch(() => undefined)
  if (raw === undefined || raw.trim() === '') return
  const index = JSON.parse(raw) as { number: number; origin?: ChapterOrigin }[]
  let hit = false
  const next = index.map((chapter) => {
    if (chapter.number !== number) return chapter
    hit = true
    return { ...chapter, origin }
  })
  if (!hit) return
  await writeFile(join(store.root, FILES.index), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
}
