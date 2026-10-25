/**
 * Inkwell domain model.
 *
 * Everything here is plain data that round-trips through JSON on disk. No
 * model calls, no I/O. The writer's project directory is the single source of
 * truth, so a new session on a new machine sees exactly the same canon.
 */

/** Ordered production phases. The gate machine only moves forward. */
export const PHASES = ['premise', 'canon', 'outline', 'drafting', 'review', 'done'] as const

/** One production phase. */
export type Phase = (typeof PHASES)[number]

/** Character's structural position in the story. */
export const CHARACTER_ROLES = ['protagonist', 'antagonist', 'supporting', 'minor'] as const

/** One character's structural position. */
export type CharacterRole = (typeof CHARACTER_ROLES)[number]

/** Root record of a project. */
export interface ProjectFile {
  formatVersion: 1
  title: string
  phase: Phase
  premise: string
  targetWords: number
  /** Per-book model overrides, keyed by role id. Global config fills the gaps. */
  roles?: ProjectRoles
  createdAt: string
  updatedAt: string
}

/** A character card, including the voice fields that stop everyone sounding alike. */
export interface CharacterCard {
  name: string
  role: CharacterRole
  /** How this person talks: rhythm, vocabulary, verbal tics. */
  voice: string
  appearance: string
  goal: string
  secret: string
  updatedAt: string
}

/** One worldbuilding fact: place, faction, rule, item. */
export interface WorldEntry {
  name: string
  kind: string
  detail: string
  updatedAt: string
}

/** A volume-level outline. */
export interface VolumeOutline {
  number: number
  title: string
  summary: string
  approved: boolean
}

/** A chapter-level contract: what must happen, who appears, whose eyes. */
export interface ChapterPlan {
  number: number
  volume: number
  title: string
  pov: string
  characters: string[]
  /** Beats that must land in the draft. Deterministic coverage is checked after writing. */
  beats: string[]
  /** Intended chapter-end hook. */
  hooks: string[]
  approved: boolean
}

/** One asserted fact about the story world, tied to the chapter that asserts it. */
export interface LedgerEntry {
  id: string
  subject: string
  predicate: string
  value: string
  /** 0 means "declared during setup", before any chapter exists. */
  chapter: number
  /** Quoted source text that justifies the assertion. */
  quote: string
  /** Id of the entry this one replaces, if the change is intentional. */
  supersedes: string | null
  createdAt: string
}

/** Chapter metadata stored in the index. */
export interface ChapterMeta {
  number: number
  title: string
  words: number
  summary: string
  writtenAt: string
  /**
   * How many times this chapter's body has been written, starting at 1.
   *
   * Two windows can hold the same chapter at once — a panel tab and a chat
   * turn — and last-write-wins would silently eat one of them. Writes carry the
   * revision they were based on, and a stale one is refused instead of applied.
   * Files written before v0.10 have no revision on disk and read as 0; the type
   * stays optional so a hand-built snapshot in a test or a script need not
   * invent one, and every reader treats absent as 0.
   */
  revision?: number
}

/** A completed chapter on disk. */
export interface ChapterDraft extends ChapterMeta {
  text: string
}

/** Whether a review item was acted on. */
export const REVIEW_STATES = ['open', 'fixed', 'waived'] as const

/** One review item's state. */
export type ReviewState = (typeof REVIEW_STATES)[number]

/**
 * One thing a reviewer said about one draft round.
 *
 * Findings used to live only in the chat transcript, so "the logic reviewer
 * raised five points and three were addressed" was unanswerable a week later.
 * Every item is stored with who raised it, which round it judged, and what was
 * done about it.
 */
export interface ReviewItem {
  /** Stable id within the book, e.g. `c005-r2-3`. */
  id: string
  /** Draft round this item judged. */
  round: number
  severity: Severity
  code: string
  message: string
  evidence: string
  state: ReviewState
  /** Why it was fixed or waived, when someone said. */
  note: string
  updatedAt: string
}

/** One reviewer's pass over one draft round. */
export interface ReviewRound {
  /** 1-based; a book-wide counter, not per chapter. */
  round: number
  /** Who said it: a role id, or `human`. */
  role: string
  /** Which role's route ran, when a model produced the findings. */
  route: string
  /** Draft round it judged, as stored under `drafts/`. */
  draftRound: number
  at: string
  items: ReviewItem[]
}

/** Everything reviewers have said about one chapter. */
export interface ReviewFile {
  formatVersion: 1
  chapter: number
  rounds: ReviewRound[]
}


/** Role identifiers for the studio dispatch flow. */
export const ROLE_IDS = ['writer', 'logic', 'character', 'chief'] as const

/** One studio role. */
export type RoleId = (typeof ROLE_IDS)[number]

/** Per-role model route. Mirrors DSH `AgentOptions`; absent fields inherit. */
export interface RoleRoute {
  provider?: string | undefined
  model?: string | undefined
  /** Output ceiling for each call. */
  maxTokens?: number | undefined
  /** Adapter-owned reasoning effort for the selected provider/model route. */
  reasoningEffort?: string | undefined
}

/**
 * One role's route override as the book stores it.
 *
 * `null` is the third state, not a bug: it means "this book says this field is
 * unset on purpose", which stops the global default from filling it back in.
 * Clearing `reasoningEffort` on one role must not drag down the other fields.
 */
export type RoleRoutePatch = {
  provider?: string | null | undefined
  model?: string | null | undefined
  maxTokens?: number | null | undefined
  reasoningEffort?: string | null | undefined
}

/** A role's route as one book stores it: the same fields, each tri-state. */
export type ProjectRoles = Partial<Record<RoleId, RoleRoutePatch>>

/** How much a finding matters. `error` blocks, `warn` asks for a rewrite, `info` is context. */
export type Severity = 'error' | 'warn' | 'info'

/** One deterministic observation about the manuscript. */
export interface Finding {
  code: string
  severity: Severity
  message: string
  evidence: string
}

/**
 * Everything the gates, scanners and briefing need, read once.
 */
export interface Snapshot {
  project: ProjectFile
  characters: CharacterCard[]
  world: WorldEntry[]
  volumes: VolumeOutline[]
  plans: ChapterPlan[]
  ledger: LedgerEntry[]
  chapters: ChapterMeta[]
}

/** Resolved, fully-defaulted plugin configuration. */
export interface InkwellConfig {
  root: string
  premiseMinChars: number
  briefingBudgetChars: number
  briefingTailChars: number
  briefingLookback: number
  chapterMinWords: number
  chapterMaxWords: number
  repeatShingleSize: number
  repeatWarnRatio: number
  repeatErrorRatio: number
  openingRepeatMin: number
  rhythmStdRatioWarn: number
  dialogueMinRatio: number
  aiToneWarnPer1000: number
  aiToneWords: string[]
  beatCoverageMin: number
  /** Per-role global model defaults. Each book can override a role's route. */
  roles: Partial<Record<RoleId, RoleRoute>>
  /**
   * Resolve `root` against each session's working directory instead of the
   * process's. On by default: one dsh process serves many workspaces, and a
   * relative root resolved once at apply time pointed every book at the same
   * folder. Set it to `false` for the old one-book-at-the-process-directory
   * behaviour.
   */
  perWorkspace: boolean
}

/** One review round on a chapter draft, persisted under drafts/. */
export interface DraftRound {
  number: number
  /** Round number within this chapter, 1-based. */
  round: number
  text: string
  words: number
  summary: string
  /** Findings from the deterministic contract + scan run at propose time. */
  autoFindings: Finding[]
  writtenAt: string
}
