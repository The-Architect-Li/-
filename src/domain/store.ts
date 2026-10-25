/**
 * Project directory persistence.
 *
 * A project is a directory of small JSON files plus one Markdown file per
 * chapter. Writes go through a temp file and a rename, so an interrupted run
 * never leaves a half-written canon behind.
 */
import { mkdir, readFile, rename, writeFile, readdir, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type {
  CharacterCard,
  ChapterDraft,
  ChapterMeta,
  ChapterPlan,
  DraftRound,
  LedgerEntry,
  PlaceCard,
  ProjectFile,
  ReviewFile,
  ReviewItem,
  ReviewRound,
  Snapshot,
  StoryPoint,
  TimelineFile,
  VolumeOutline,
  WorldEntry,
  RelationFile,
} from './types.ts'
import { migrateRelations, normaliseRelations } from './relations.ts'

/** The file whose presence marks a directory as an Inkwell project. */
export const PROJECT_FILE = 'project.json'
const CHARACTERS_FILE = 'canon/characters.json'
const WORLD_FILE = 'canon/world.json'
const PLACES_FILE = 'canon/places.json'
const RELATIONS_FILE = 'canon/relations.json'
const STORY_POINTS_FILE = 'outline/story-points.json'
const TIMELINE_FILE = 'timeline/clock.json'
const VOLUMES_FILE = 'outline/volumes.json'
const PLANS_FILE = 'outline/chapters.json'
const LEDGER_FILE = 'ledger/facts.json'
const INDEX_FILE = 'chapters/index.json'

/** Raised when an operation needs a project that does not exist yet. */
export class ProjectMissingError extends Error {
  constructor(root: string) {
    super(`No Inkwell project at ${root}. Run novel_project with action "init" first.`)
    this.name = 'ProjectMissingError'
  }
}

/**
 * Raised when a write was based on a version of the chapter that is gone.
 *
 * This is the difference between "your save did not happen" and "your save
 * happened and somebody else's did not". The caller gets the revision that is
 * actually on disk so it can re-read, merge, or deliberately overwrite.
 */
export class ChapterConflictError extends Error {
  /** The chapter's revision on disk right now. */
  readonly current: number

  constructor(number: number, expected: number, current: number) {
    super(
      `第${number}章已经被改过：你基于第 ${expected} 版，磁盘上现在是第 ${current} 版。先重新读一遍这一章，或者显式用 revision=${current} 覆盖。`,
    )
    this.name = 'ChapterConflictError'
    this.current = current
  }
}

/** Failed precondition that the caller should surface verbatim to the writer. */
export class GateRejected extends Error {
  readonly blockers: string[]

  constructor(message: string, blockers: string[] = []) {
    super(message)
    this.name = 'GateRejected'
    this.blockers = blockers
  }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

/** Pad a chapter number to three digits, the on-disk sort order. */
export function chapterKey(number: number): string {
  return String(number).padStart(3, '0')
}

/** Reads and writes one project directory. */
export class ProjectStore {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  private get projectPath(): string {
    return join(this.root, PROJECT_FILE)
  }

  /** Whether a project file exists at the configured root. */
  async exists(): Promise<boolean> {
    try {
      await readFile(this.projectPath, 'utf8')
      return true
    } catch {
      return false
    }
  }

  /** Create the project skeleton. Existing projects are left untouched. */
  async init(title: string, targetWords: number): Promise<ProjectFile> {
    if (await this.exists()) return this.readProject()
    const now = new Date().toISOString()
    const project: ProjectFile = {
      formatVersion: 1,
      title,
      phase: 'premise',
      premise: '',
      targetWords,
      createdAt: now,
      updatedAt: now,
    }
    await writeJson(this.projectPath, project)
    await writeJson(join(this.root, CHARACTERS_FILE), [])
    await writeJson(join(this.root, WORLD_FILE), [])
    await writeJson(join(this.root, VOLUMES_FILE), [])
    await writeJson(join(this.root, PLANS_FILE), [])
    await writeJson(join(this.root, LEDGER_FILE), [])
    await writeJson(join(this.root, INDEX_FILE), [])
    await mkdir(join(this.root, 'chapters'), { recursive: true })
    return project
  }

  /** Read the project root record. */
  async readProject(): Promise<ProjectFile> {
    if (!(await this.exists())) throw new ProjectMissingError(this.root)
    return readJson<ProjectFile>(this.projectPath, {} as ProjectFile)
  }

  /** Replace the project root record. */
  async writeProject(project: ProjectFile): Promise<void> {
    const next: ProjectFile = { ...project, updatedAt: new Date().toISOString() }
    await writeJson(this.projectPath, next)
  }

  /** All character cards. */
  async characters(): Promise<CharacterCard[]> {
    return readJson<CharacterCard[]>(join(this.root, CHARACTERS_FILE), [])
  }

  /** Insert or replace one character card by name. */
  async upsertCharacter(card: CharacterCard): Promise<CharacterCard[]> {
    const list = await this.characters()
    const index = list.findIndex((item) => item.name === card.name)
    if (index >= 0) list[index] = card
    else list.push(card)
    list.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    await writeJson(join(this.root, CHARACTERS_FILE), list)
    return list
  }

  /** All world entries. */
  async world(): Promise<WorldEntry[]> {
    return readJson<WorldEntry[]>(join(this.root, WORLD_FILE), [])
  }

  /** Insert or replace one world entry by name. */
  async upsertWorld(entry: WorldEntry): Promise<WorldEntry[]> {
    const list = await this.world()
    const index = list.findIndex((item) => item.name === entry.name)
    if (index >= 0) list[index] = entry
    else list.push(entry)
    list.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    await writeJson(join(this.root, WORLD_FILE), list)
    return list
  }

  /** Every place the manuscript has used, newest chapter last. */
  async places(): Promise<PlaceCard[]> {
    return readJson<PlaceCard[]>(join(this.root, PLACES_FILE), [])
  }

  /** Insert or replace one place card by name, keeping the list ordered by chapter. */
  async upsertPlace(card: PlaceCard): Promise<PlaceCard[]> {
    const list = await this.places()
    const index = list.findIndex((item) => item.name === card.name)
    if (index >= 0) list[index] = card
    else list.push(card)
    list.sort((a, b) => a.firstChapter - b.firstChapter || a.name.localeCompare(b.name, 'zh'))
    await writeJson(join(this.root, PLACES_FILE), list)
    return list
  }

  /**
   * The relation table, folded out of the cards the first time a book asks.
   *
   * Old books keep their one-sided `card.relations`; this is where they become
   * edges. The fold is written on the spot so the next read is the same answer
   * even if the cards are edited in between.
   */
  async relations(): Promise<RelationFile> {
    const raw = await readJson<RelationFile | undefined>(join(this.root, RELATIONS_FILE), undefined)
    if (raw !== undefined && raw !== null && Array.isArray(raw.edges) && raw.edges.length > 0) {
      return normaliseRelations(raw)
    }
    const { file, changed } = migrateRelations(raw === undefined ? undefined : raw, await this.characters())
    if (changed) await writeJson(join(this.root, RELATIONS_FILE), file)
    return file
  }

  /** Replace the whole relation table. */
  async writeRelations(file: RelationFile): Promise<RelationFile> {
    const next = normaliseRelations({ ...file, migrated: true })
    await writeJson(join(this.root, RELATIONS_FILE), next)
    return next
  }

  /** Every story point, in chapter order. */
  async storyPoints(): Promise<StoryPoint[]> {
    return readJson<StoryPoint[]>(join(this.root, STORY_POINTS_FILE), [])
  }

  /** Insert or replace one story point by id. */
  async upsertStoryPoint(point: StoryPoint): Promise<StoryPoint[]> {
    const list = await this.storyPoints()
    const index = list.findIndex((item) => item.id === point.id)
    if (index >= 0) list[index] = point
    else list.push(point)
    list.sort((a, b) => a.startChapter - b.startChapter || a.id.localeCompare(b.id))
    await writeJson(join(this.root, STORY_POINTS_FILE), list)
    return list
  }

  /** The book's clock: anchors, spans and recalls — never resolved dates. */
  async timeline(): Promise<TimelineFile> {
    const file = await readJson<TimelineFile>(join(this.root, TIMELINE_FILE), {
      formatVersion: 1,
      anchors: [],
      spans: [],
    })
    return {
      formatVersion: 1,
      anchors: Array.isArray(file.anchors) ? file.anchors : [],
      spans: Array.isArray(file.spans) ? file.spans : [],
      ...(Array.isArray(file.recalls) ? { recalls: file.recalls } : {}),
    }
  }

  /** Replace the whole clock. Anchors, spans and recalls are small; partial writes are not worth it. */
  async writeTimeline(file: TimelineFile): Promise<TimelineFile> {
    const next: TimelineFile = {
      formatVersion: 1,
      anchors: file.anchors,
      spans: file.spans,
      ...(file.recalls === undefined ? {} : { recalls: file.recalls }),
    }
    await writeJson(join(this.root, TIMELINE_FILE), next)
    return next
  }

  /** All volume outlines. */
  async volumes(): Promise<VolumeOutline[]> {
    return readJson<VolumeOutline[]>(join(this.root, VOLUMES_FILE), [])
  }  /** Insert or replace one volume outline by number. */
  async upsertVolume(volume: VolumeOutline): Promise<VolumeOutline[]> {
    const list = await this.volumes()
    const index = list.findIndex((item) => item.number === volume.number)
    if (index >= 0) list[index] = volume
    else list.push(volume)
    list.sort((a, b) => a.number - b.number)
    await writeJson(join(this.root, VOLUMES_FILE), list)
    return list
  }

  /** All chapter contracts. */
  async plans(): Promise<ChapterPlan[]> {
    return readJson<ChapterPlan[]>(join(this.root, PLANS_FILE), [])
  }

  /** Insert or replace one chapter contract by number. */
  async upsertPlan(plan: ChapterPlan): Promise<ChapterPlan[]> {
    const list = await this.plans()
    const index = list.findIndex((item) => item.number === plan.number)
    if (index >= 0) list[index] = plan
    else list.push(plan)
    list.sort((a, b) => a.number - b.number)
    await writeJson(join(this.root, PLANS_FILE), list)
    return list
  }

  /** The whole fact ledger, including superseded entries. */
  async ledger(): Promise<LedgerEntry[]> {
    return readJson<LedgerEntry[]>(join(this.root, LEDGER_FILE), [])
  }

  /** Append one fact, assigning the next id. */
  async appendLedger(entry: Omit<LedgerEntry, 'id' | 'createdAt'>): Promise<LedgerEntry> {
    const list = await this.ledger()
    const next = Number(nextLedgerId(list).slice(2))
    const record: LedgerEntry = {
      ...entry,
      id: `f-${String(next).padStart(4, '0')}`,
      createdAt: new Date().toISOString(),
    }
    list.push(record)
    await writeJson(join(this.root, LEDGER_FILE), list)
    return record
  }

  /** Chapter metadata, ordered by number. */
  async chapters(): Promise<ChapterMeta[]> {
    const list = await readJson<ChapterMeta[]>(join(this.root, INDEX_FILE), [])
    // Chapters written before revisions existed read as 1, not 0: 0 is not a
    // revision anyone can hand back — the panel would send it, and the write
    // path would reject it as "not a positive integer". A legacy chapter is one
    // version of itself, so the first write through this build makes it 2.
    return list
      .map((item) => ({ ...item, revision: typeof item.revision === 'number' ? item.revision : 1 }))
      .sort((a, b) => a.number - b.number)
  }

  /** Load one chapter with its text. Returns `undefined` when absent. */
  async chapter(number: number): Promise<ChapterDraft | undefined> {
    const meta = (await this.chapters()).find((item) => item.number === number)
    if (!meta) return undefined
    try {
      const text = await readFile(this.chapterPath(number), 'utf8')
      return { ...meta, text }
    } catch {
      return undefined
    }
  }

  /**
   * Write one chapter body plus its index row.
   *
   * The write is a compare-and-swap on the chapter's revision: a caller that
   * read revision 3 and saves while the disk is at 4 gets a refusal, not
   * silence. Pass no `baseRevision` only when the caller genuinely means to
   * overwrite whatever is there (a commit of an approved draft, a restore of a
   * named round).
   *
   * @param draft - the body and its metadata; `revision` is ignored on input.
   * @param options - `baseRevision` the caller edited.
   * @returns the metadata actually written, including the new revision.
   * @throws {ChapterConflictError} when `baseRevision` no longer matches.
   */
  async writeChapter(draft: ChapterDraft, options: { baseRevision?: number | undefined } = {}): Promise<ChapterMeta> {
    const index = await this.chapters()
    const position = index.findIndex((item) => item.number === draft.number)
    const current = position >= 0 ? (index[position]!.revision ?? 0) : 0
    if (options.baseRevision !== undefined && options.baseRevision !== current) {
      throw new ChapterConflictError(draft.number, options.baseRevision, current)
    }
    const file = this.chapterPath(draft.number)
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, `${draft.text.trim()}\n`, 'utf8')
    await rename(temp, file)
    const meta: ChapterMeta = {
      number: draft.number,
      title: draft.title,
      words: draft.words,
      summary: draft.summary,
      writtenAt: draft.writtenAt,
      revision: current + 1,
    }
    if (position >= 0) index[position] = meta
    else index.push(meta)
    index.sort((a, b) => a.number - b.number)
    await writeJson(join(this.root, INDEX_FILE), index)
    return meta
  }

  /** Every chapter body, ordered by number. */
  async allChapters(): Promise<ChapterDraft[]> {
    const metas = await this.chapters()
    const out: ChapterDraft[] = []
    for (const meta of metas) {
      const draft = await this.chapter(meta.number)
      if (draft) out.push(draft)
    }
    return out
  }

  /** Read everything the gates and scanners need in one pass. */
  async snapshot(): Promise<Snapshot> {
    return {
      project: await this.readProject(),
      characters: await this.characters(),
      world: await this.world(),
      places: await this.places(),
      storyPoints: await this.storyPoints(),
      timeline: await this.timeline(),
      relations: await this.relations(),
      volumes: await this.volumes(),
      plans: await this.plans(),
      ledger: await this.ledger(),
      chapters: await this.chapters(),
    }
  }

  /** Absolute path of one chapter file. */
  chapterPath(number: number): string {
    return join(this.root, 'chapters', `${chapterKey(number)}.md`)
  }

  /** Directory holding every chapter's review drafts. */
  private draftsDir(number: number): string {
    return join(this.root, 'drafts', chapterKey(number))
  }

  /** Filename for one draft round, ordered so listdir stays sorted. */
  private draftFile(number: number, round: number): string {
    return join(this.draftsDir(number), `${String(round).padStart(2, '0')}.json`)
  }

  /** Persist one draft round. The caller computes `round` and `autoFindings`. */
  async saveDraft(round: DraftRound): Promise<void> {
    await writeJson(this.draftFile(round.number, round.round), round)
  }

  /** The latest draft round for a chapter, or `undefined` when none exists. */
  async latestDraft(number: number): Promise<DraftRound | undefined> {
    const dir = this.draftsDir(number)
    const entries = await readdir(dir).catch(() => [] as string[])
    const files = entries.filter((file) => file.endsWith('.json')).sort()
    if (files.length === 0) return undefined
    return readJson<DraftRound | undefined>(join(dir, files[files.length - 1]!), undefined)
  }

  /** Every draft round for a chapter, oldest first. */
  async draftsOf(number: number): Promise<DraftRound[]> {
    const dir = this.draftsDir(number)
    const entries = await readdir(dir).catch(() => [] as string[])
    const rounds: DraftRound[] = []
    for (const file of entries.filter((file) => file.endsWith('.json')).sort()) {
      const round = await readJson<DraftRound | undefined>(join(dir, file), undefined)
      if (round) rounds.push(round)
    }
    return rounds
  }

  /**
   * Promote the latest draft of a chapter into the manuscript.
   *
   * Drafts are kept so the review history survives a later rewrite; the chapter
   * on disk is replaced by the latest approved prose. This is the one write that
   * deliberately does not compare revisions: a human said "this draft is the
   * chapter", and re-reading first would not change their answer.
   *
   * @returns the committed chapter metadata.
   */
  async commitDraft(number: number): Promise<ChapterMeta> {
    const draft = await this.latestDraft(number)
    if (!draft) throw new Error(`第${number}章没有草稿，无法 commit。先用 novel_chapter action="propose" 落草稿。`)
    const meta: ChapterMeta = {
      number: draft.number,
      title: draft.summary ? draft.summary.slice(0, 40) : `第${draft.number}章`,
      words: draft.words,
      summary: draft.summary,
      writtenAt: draft.writtenAt,
      revision: 0,
    }
    return this.writeChapter({ ...meta, text: draft.text })
  }

  /** Path of one chapter's review record. */
  reviewPath(number: number): string {
    return join(this.root, 'reviews', `${chapterKey(number)}.json`)
  }

  /** Every review round recorded for one chapter, oldest first. */
  async reviews(number: number): Promise<ReviewRound[]> {
    const file = await readJson<ReviewFile | undefined>(this.reviewPath(number), undefined)
    if (file === undefined || !Array.isArray(file.rounds)) return []
    return [...file.rounds].sort((a, b) => a.round - b.round)
  }

  /**
   * Append one reviewer's pass to a chapter's review record.
   *
   * Ids are assigned here rather than by the caller, so "which item did I just
   * resolve?" has one answer for the tool, the panel and the transcript.
   *
   * @param number - the chapter reviewed.
   * @param input - who reviewed, which draft round, and what they said.
   * @returns the round as stored, ids included.
   */
  async appendReview(
    number: number,
    input: {
      role: string
      route: string
      draftRound: number
      items: readonly { severity: ReviewItem['severity']; code: string; message: string; evidence: string }[]
    },
  ): Promise<ReviewRound> {
    const rounds = await this.reviews(number)
    const round: number = rounds.length + 1
    const at = new Date().toISOString()
    const items: ReviewItem[] = input.items.map((item, index) => ({
      id: `${chapterKey(number)}-r${round}-${index + 1}`,
      round: input.draftRound,
      severity: item.severity,
      code: item.code,
      message: item.message,
      evidence: item.evidence,
      state: 'open',
      note: '',
      updatedAt: at,
    }))
    const record: ReviewRound = {
      round,
      role: input.role,
      route: input.route,
      draftRound: input.draftRound,
      at,
      items,
    }
    const file: ReviewFile = { formatVersion: 1, chapter: number, rounds: [...rounds, record] }
    await writeJson(this.reviewPath(number), file)
    return record
  }

  /**
   * Mark one review item fixed or waived.
   *
   * @param number - the chapter the item belongs to.
   * @param id - the item id, as returned by {@link appendReview}.
   * @param state - what was done about it.
   * @param note - why, in the author's words.
   * @returns the updated item, or `undefined` when no such id exists.
   */
  async setReviewState(
    number: number,
    id: string,
    state: ReviewItem['state'],
    note: string,
  ): Promise<ReviewItem | undefined> {
    const rounds = await this.reviews(number)
    let found: ReviewItem | undefined
    const next = rounds.map((round) => ({
      ...round,
      items: round.items.map((item) => {
        if (item.id !== id) return item
        found = { ...item, state, note: note.trim(), updatedAt: new Date().toISOString() }
        return found
      }),
    }))
    if (found === undefined) return undefined
    const file: ReviewFile = { formatVersion: 1, chapter: number, rounds: next }
    await writeJson(this.reviewPath(number), file)
    return found
  }

  /** Remove the whole project directory. Used by tests and explicit resets only. */
  async destroy(): Promise<void> {
    for (const entry of await readdir(this.root).catch(() => [] as string[])) {
      await unlink(join(this.root, entry)).catch(() => undefined)
    }
  }
}

/** Next sequential ledger id for a list. */
export function nextLedgerId(entries: LedgerEntry[]): string {
  const max = entries.reduce((acc, entry) => {
    const value = Number(entry.id.replace(/^f-/, ''))
    return Number.isFinite(value) ? Math.max(acc, value) : acc
  }, 0)
  return `f-${String(max + 1).padStart(4, '0')}`
}
