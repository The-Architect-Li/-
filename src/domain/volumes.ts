/** Which chapter belongs to which volume: the one place that decides it. */
import type { ChapterMeta, ChapterPlan } from './types.ts'
import type { ProjectStore } from './store.ts'

/** Every chapter number in the book, with its volume (0 = 未分卷). */
export interface VolumeMembership {
  /** Volume number → the chapters in it, ascending. Only volumes that hold something. */
  byVolume: Map<number, number[]>
  /** Chapters in no volume, ascending. */
  unassigned: number[]
  /** Every chapter number the book knows about, ascending. */
  all: number[]
}

/** What the panel gets back after a change, so it can redraw without a second read. */
export interface VolumeReport {
  /** Volumes with their titles and member chapters, ascending by number. */
  volumes: { number: number; title: string; chapters: number[] }[]
  unassigned: number[]
  /** Volume numbers this call created an outline for. */
  created: number[]
  /** How many chapters this call changed. */
  changed: number
}

/** The volume number that means "no volume at all". */
export const UNASSIGNED = 0

/**
 * Every chapter number in the book.
 *
 * A chapter counts if it has an outline or has been written: a plan for a
 * chapter nobody wrote yet still has to show up, or splitting volumes would
 * silently skip the rest of the outline.
 *
 * @param plans - the chapter contracts.
 * @param chapters - the written chapters.
 * @returns ascending chapter numbers.
 */
export function chapterNumbers(plans: readonly ChapterPlan[], chapters: readonly ChapterMeta[]): number[] {
  const numbers = new Set<number>()
  for (const plan of plans) numbers.add(plan.number)
  for (const chapter of chapters) numbers.add(chapter.number)
  return [...numbers].sort((a, b) => a - b)
}

/**
 * Group chapters by the volume their outline names.
 *
 * @param plans - the chapter contracts.
 * @param numbers - every chapter number, ascending.
 * @returns the membership.
 */
export function membershipOf(plans: readonly ChapterPlan[], numbers: readonly number[]): VolumeMembership {
  const byVolume = new Map<number, number[]>()
  const unassigned: number[] = []
  const volumeOf = new Map<number, number>()
  for (const plan of plans) volumeOf.set(plan.number, plan.volume)
  for (const number of numbers) {
    const volume = volumeOf.get(number) ?? UNASSIGNED
    if (volume === UNASSIGNED) {
      unassigned.push(number)
      continue
    }
    const list = byVolume.get(volume)
    if (list === undefined) byVolume.set(volume, [number])
    else list.push(number)
  }
  for (const list of byVolume.values()) list.sort((a, b) => a - b)
  return { byVolume, unassigned, all: [...numbers] }
}

/**
 * Cut a run of chapters into fixed-size volumes.
 *
 * The last volume is short by definition; a book of 85 chapters at 10 per
 * volume is 8 full volumes and one of 5. This is a pure function so the
 * boundary arithmetic can be tested without a book on disk.
 *
 * @param numbers - ascending chapter numbers.
 * @param perVolume - how many chapters one volume holds; must be positive.
 * @returns the runs, in order. Volume 1 is the first run.
 */
export function splitRuns(numbers: readonly number[], perVolume: number): number[][] {
  if (!Number.isInteger(perVolume) || perVolume < 1) throw new RangeError(`perVolume 必须是正整数，收到 ${perVolume}`)
  const runs: number[][] = []
  for (let index = 0; index < numbers.length; index += perVolume) {
    runs.push(numbers.slice(index, index + perVolume))
  }
  return runs
}

/**
 * A plan that exists only to remember which volume a chapter is in.
 *
 * Chapters that came in through import often have a volume but no outline: the
 * manuscript had 85 chapters and the outline only planned 83. Storing the
 * volume somewhere else would mean two places could disagree, so the plan is
 * the place — and a plan with no beats is honest about being empty instead of
 * inventing a contract nobody wrote.
 *
 * @param number - the chapter.
 * @param volume - the volume it belongs to.
 * @param written - the written chapter, for its title, when there is one.
 * @returns the plan.
 */
export function shellPlan(number: number, volume: number, written: ChapterMeta | undefined): ChapterPlan {
  return {
    number,
    volume,
    title: written?.title ?? '',
    pov: '',
    characters: [],
    beats: [],
    hooks: [],
    approved: false,
  }
}

/**
 * Read what the panel needs to draw the volume picker.
 *
 * @param store - the book.
 * @returns volumes, the chapters in none, and every chapter number.
 */
export async function readVolumes(store: ProjectStore): Promise<VolumeReport> {
  const [volumes, plans, chapters] = await Promise.all([store.volumes(), store.plans(), store.chapters()])
  const membership = membershipOf(plans, chapterNumbers(plans, chapters))
  return {
    volumes: volumes.map((volume) => ({
      number: volume.number,
      title: volume.title,
      chapters: membership.byVolume.get(volume.number) ?? [],
    })),
    unassigned: membership.unassigned,
    created: [],
    changed: 0,
  }
}

/**
 * Put a set of chapters into one volume, or into none.
 *
 * Creating a volume outline is part of the same call: asking for "these ten
 * chapters are 第3卷" when no 第3卷 exists yet means the volume exists now.
 *
 * @param store - the book.
 * @param chapters - chapter numbers to move.
 * @param volume - target volume, or `null` to take them out of any volume.
 * @returns the new state.
 */
export async function assignVolume(
  store: ProjectStore,
  chapters: readonly number[],
  volume: number | null,
): Promise<VolumeReport> {
  const target = volume === null ? UNASSIGNED : volume
  if (!Number.isInteger(target) || target < 0) throw new RangeError(`卷号必须是非负整数，收到 ${String(volume)}`)
  const wanted = [...new Set(chapters.filter((number) => Number.isInteger(number) && number > 0))].sort((a, b) => a - b)
  if (wanted.length === 0) throw new RangeError('没有选中任何章节')

  const created = await ensureVolume(store, target)
  const [plans, written] = await Promise.all([store.plans(), store.chapters()])
  const byNumber = new Map(plans.map((plan) => [plan.number, plan]))
  const writtenByNumber = new Map(written.map((chapter) => [chapter.number, chapter]))

  let changed = 0
  for (const number of wanted) {
    const plan = byNumber.get(number)
    const next = plan === undefined ? shellPlan(number, target, writtenByNumber.get(number)) : { ...plan, volume: target }
    if (plan !== undefined && plan.volume === target) continue
    await store.upsertPlan(next)
    changed += 1
  }
  const report = await readVolumes(store)
  return { ...report, created, changed }
}

/**
 * Cut the whole book into volumes of a fixed size.
 *
 * Only ever assigns: a chapter that already sat in a volume moves if the new
 * arithmetic puts it elsewhere, and volumes past the last run are left alone
 * rather than deleted, because a volume can carry an outline worth keeping.
 *
 * @param store - the book.
 * @param perVolume - chapters per volume.
 * @returns the new state.
 */
export async function splitVolumes(store: ProjectStore, perVolume: number): Promise<VolumeReport> {
  const [plans, chapters] = await Promise.all([store.plans(), store.chapters()])
  const numbers = chapterNumbers(plans, chapters)
  if (numbers.length === 0) throw new RangeError('这本书还没有任何章节')
  const runs = splitRuns(numbers, perVolume)

  const created: number[] = []
  let changed = 0
  for (const [index, run] of runs.entries()) {
    created.push(...(await ensureVolume(store, index + 1)))
    for (const number of run) {
      const existing = plans.find((plan) => plan.number === number)
      const written = chapters.find((chapter) => chapter.number === number)
      const next = existing === undefined ? shellPlan(number, index + 1, written) : { ...existing, volume: index + 1 }
      if (existing !== undefined && existing.volume === index + 1) continue
      await store.upsertPlan(next)
      changed += 1
    }
  }
  const report = await readVolumes(store)
  return { ...report, created, changed }
}

/**
 * Make sure an outline exists for a volume number.
 *
 * @param store - the book.
 * @param volume - the volume number; 0 means none, and needs no outline.
 * @returns the numbers this call created, empty when it created nothing.
 */
async function ensureVolume(store: ProjectStore, volume: number): Promise<number[]> {
  if (volume === UNASSIGNED) return []
  const volumes = await store.volumes()
  if (volumes.some((entry) => entry.number === volume)) return []
  await store.upsertVolume({ number: volume, title: '', summary: '', approved: false })
  return [volume]
}
