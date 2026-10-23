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
  LedgerEntry,
  ProjectFile,
  Snapshot,
  VolumeOutline,
  WorldEntry,
} from './types.ts'

const PROJECT_FILE = 'project.json'
const CHARACTERS_FILE = 'canon/characters.json'
const WORLD_FILE = 'canon/world.json'
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

  /** All volume outlines. */
  async volumes(): Promise<VolumeOutline[]> {
    return readJson<VolumeOutline[]>(join(this.root, VOLUMES_FILE), [])
  }

  /** Insert or replace one volume outline by number. */
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
    return list.sort((a, b) => a.number - b.number)
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

  /** Write one chapter body plus its index row. */
  async writeChapter(draft: ChapterDraft): Promise<void> {
    const file = this.chapterPath(draft.number)
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, `${draft.text.trim()}\n`, 'utf8')
    await rename(temp, file)
    const index = await this.chapters()
    const meta: ChapterMeta = {
      number: draft.number,
      title: draft.title,
      words: draft.words,
      summary: draft.summary,
      writtenAt: draft.writtenAt,
    }
    const existing = index.findIndex((item) => item.number === draft.number)
    if (existing >= 0) index[existing] = meta
    else index.push(meta)
    index.sort((a, b) => a.number - b.number)
    await writeJson(join(this.root, INDEX_FILE), index)
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
