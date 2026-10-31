/**
 * The workshop panel's data model.
 *
 * The browser half of this plugin cannot read `.novel/` itself, so the host
 * half projects one book into a small JSON payload and the panel renders that.
 * The projection is a pure function of an already-read snapshot plus the draft
 * rounds, which keeps it testable without HTTP and keeps the route handler thin.
 *
 * The payload is deliberately narrow: what a side panel can show at a glance,
 * not the manuscript. Prose stays in the conversation and on disk.
 */
import { nextPhase, blockersFor } from '../domain/phase.ts'
import { countChars } from '../domain/text.ts'
import type { SkillNote } from '../domain/skills.ts'
import type {
  ChapterMeta,
  ChapterPlan,
  DraftRound,
  InkwellConfig,
  LedgerEntry,
  Snapshot,
} from '../domain/types.ts'
import { buildSections, type PanelSection } from './tree.ts'

/** One planned-but-unwritten chapter, or both, as the panel lists it. */
export interface PanelChapter {
  number: number
  title: string
  /** Word count of the committed chapter; `0` while unwritten. */
  words: number
  /** Whether the chapter has been written to the index. */
  written: boolean
  /** Whether its outline is approved. */
  approved: boolean
  /** How many draft rounds exist for it. */
  drafts: number
  /** Error findings on the newest draft, as the writer tool left them. */
  errors: number
  /** Warning findings on the newest draft. */
  warnings: number
}

/** One fact as the panel's strip shows it. */
export interface PanelFact {
  id: string
  subject: string
  predicate: string
  value: string
  /** `0` for setup-time facts. */
  chapter: number
}

/** Everything the side panel draws. */
export interface PanelSnapshot {
  /** The book's title, or `''` when nothing exists yet. */
  title: string
  /** Current phase; `null` when there is no project. */
  phase: string | null
  /** The phase after it, `null` once the book is done. */
  next: string | null
  /** What still blocks the next phase, in the studio's own words. */
  blockers: string[]
  /** Absolute project directory, shown in the panel's footer. */
  root: string
  targetWords: number
  /** Sum of committed chapter words. */
  words: number
  chapters: PanelChapter[]
  /** Committed chapter count. */
  written: number
  /** Approved chapter outlines. */
  approved: number
  /** Outline count, including unapproved. */
  planned: number
  /** Active ledger facts, newest last. */
  facts: PanelFact[]
  /** Facts superseded by a later entry. */
  retired: number
  characterCount: number
  worldCount: number
  volumeCount: number
  /** Premise length in characters, so the panel can show canon readiness. */
  premiseChars: number
  /** When the project record last changed. */
  updatedAt: string | null
  /** How many craft notes this book keeps. */
  skillCount: number
  /** The four drawers the panel draws: world, cast, plot, manuscript. */
  sections: PanelSection[]
}

/** Draft rounds for one chapter, as the caller already listed them. */
export interface ChapterDrafts {
  number: number
  rounds: readonly DraftRound[]
}

/**
 * The active facts, i.e. those no later entry supersedes.
 *
 * Mirrors `activeEntries` from the ledger domain but works on the raw list so
 * the panel needs no second read.
 *
 * @param entries - every ledger entry in file order.
 * @returns the entries no other entry supersedes.
 */
function activeOf(entries: readonly LedgerEntry[]): LedgerEntry[] {
  const superseded = new Set(entries.map((entry) => entry.supersedes).filter((id): id is string => Boolean(id)))
  return entries.filter((entry) => !superseded.has(entry.id))
}

/**
 * Sum the committed word counts.
 *
 * @param chapters - committed chapter metadata.
 * @returns total words.
 */
function totalWords(chapters: readonly ChapterMeta[]): number {
  return chapters.reduce((sum, chapter) => sum + chapter.words, 0)
}

/**
 * Merge what is planned with what is written into one list.
 *
 * The union matters: an approved outline with no chapter yet is the panel's
 * most useful row ("ready to write"), and a written chapter with no outline is
 * a real state after a plan was edited or removed.
 *
 * @param plans - chapter outlines.
 * @param chapters - committed chapters.
 * @param drafts - draft rounds per chapter.
 * @returns rows ordered by chapter number.
 */
function chapterRows(
  plans: readonly ChapterPlan[],
  chapters: readonly ChapterMeta[],
  drafts: readonly ChapterDrafts[],
): PanelChapter[] {
  const numbers = new Set<number>()
  for (const plan of plans) numbers.add(plan.number)
  for (const chapter of chapters) numbers.add(chapter.number)
  const roundsOf = new Map(drafts.map((entry) => [entry.number, entry.rounds]))
  const rows: PanelChapter[] = []
  for (const number of [...numbers].sort((a, b) => a - b)) {
    const plan = plans.find((entry) => entry.number === number)
    const chapter = chapters.find((entry) => entry.number === number)
    const rounds = roundsOf.get(number) ?? []
    const latest = rounds.at(-1)
    const findings = latest?.autoFindings ?? []
    rows.push({
      number,
      title: plan?.title || chapter?.title || '',
      words: chapter?.words ?? 0,
      written: chapter !== undefined,
      approved: plan?.approved ?? false,
      drafts: rounds.length,
      errors: findings.filter((finding) => finding.severity === 'error').length,
      warnings: findings.filter((finding) => finding.severity === 'warn').length,
    })
  }
  return rows
}

/**
 * Project one book into the panel payload.
 *
 * @param snapshot - the book, already read from disk.
 * @param config - resolved plugin configuration.
 * @param drafts - draft rounds per chapter; chapters without drafts may be omitted.
 * @param root - the book's absolute directory, echoed back for the footer.
 * @returns the payload the panel renders.
 */
export function buildPanelSnapshot(
  snapshot: Snapshot,
  config: InkwellConfig,
  drafts: readonly ChapterDrafts[],
  root: string,
  skills: readonly SkillNote[] = [],
): PanelSnapshot {
  const { project, plans, chapters, ledger } = snapshot
  const next = nextPhase(project.phase)
  const active = activeOf(ledger)
  return {
    title: project.title,
    phase: project.phase,
    next,
    blockers: next === null ? [] : blockersFor(next, snapshot, config),
    root,
    targetWords: project.targetWords,
    words: totalWords(chapters),
    chapters: chapterRows(plans, chapters, drafts),
    written: chapters.length,
    approved: plans.filter((plan) => plan.approved).length,
    planned: plans.length,
    facts: active.slice(-8).map((entry) => ({
      id: entry.id,
      subject: entry.subject,
      predicate: entry.predicate,
      value: entry.value,
      chapter: entry.chapter,
    })),
    retired: ledger.length - active.length,
    characterCount: snapshot.characters.length,
    worldCount: snapshot.world.length,
    volumeCount: snapshot.volumes.length,
    premiseChars: countChars(project.premise),
    updatedAt: project.updatedAt ?? null,
    skillCount: skills.length,
    sections: buildSections(snapshot, new Map(drafts.map((entry) => [entry.number, entry.rounds])), skills),
  }
}

/** The payload when no book exists at a root yet. */
export function emptyPanelSnapshot(root: string): PanelSnapshot {
  return {
    title: '',
    phase: null,
    next: null,
    blockers: [],
    root,
    targetWords: 0,
    words: 0,
    chapters: [],
    written: 0,
    approved: 0,
    planned: 0,
    facts: [],
    retired: 0,
    characterCount: 0,
    worldCount: 0,
    volumeCount: 0,
    premiseChars: 0,
    updatedAt: null,
    skillCount: 0,
    sections: [],
  }
}
