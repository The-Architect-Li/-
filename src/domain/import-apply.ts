/**
 * Writing an import plan into a book.
 *
 * The tool and the panel's create dialog both import, and both must land the
 * same plan the same way — chapter bodies through `writeChapter` so the index
 * gets a revision, cards through `upsertCharacter` so names collide correctly.
 * That rule lives here once.
 */
import { PHASES, type Phase } from './types.ts'
import type { ImportPlan } from './import-scan.ts'
import type { ProjectStore } from './store.ts'

/** What one apply wrote. */
export interface AppliedImport {
  /** Chapters actually written. */
  written: number
  /** Chapters left alone because the book already had them. */
  skipped: number
  words: number
  /** Set when the import moved the book forward; absent when it did not. */
  phase?: Phase | undefined
}

/**
 * Write a plan into a book.
 *
 * Order matters in one place: the premise is only filled when the book has no
 * premise of its own, because an import must never overwrite something the
 * writer typed. Chapters are skipped per number unless `overwrite` is set, so
 * re-running an import after adding three chapters adds those three and
 * touches nothing else.
 *
 * @param store - the book to write into; must exist.
 * @param plan - what to write.
 * @param options - `overwrite` replaces chapters the book already has.
 * @returns how much was written, and where it went.
 */
export async function applyImport(
  store: ProjectStore,
  plan: ImportPlan,
  options: { overwrite?: boolean | undefined } = {},
): Promise<AppliedImport> {
  const existing = new Set((await store.chapters()).map((meta) => meta.number))
  const project = await store.readProject()
  if (project.premise.trim() === '' && plan.premise !== '') {
    await store.writeProject({ ...project, premise: plan.premise })
  }
  for (const volume of plan.volumes) await store.upsertVolume(volume)
  for (const chapterPlan of plan.plans) await store.upsertPlan(chapterPlan)
  for (const { card } of plan.cast) await store.upsertCharacter(card)

  let written = 0
  let skipped = 0
  const now = new Date().toISOString()
  for (const chapter of plan.chapters) {
    if (existing.has(chapter.number) && options.overwrite !== true) {
      skipped += 1
      continue
    }
    await store.writeChapter({
      number: chapter.number,
      title: chapter.title,
      text: chapter.text,
      words: chapter.words,
      summary: chapter.summary,
      writtenAt: now,
    })
    written += 1
  }

  // An imported book arrives with its chapters already written, so the phase
  // machine's question — "is this book ready to write?" — is already answered.
  // Leaving it in premise would block chapter 86 of an eighty-chapter book,
  // which is exactly the trap this branch exists to close. The move is a floor,
  // never a ceiling: a book already past drafting keeps the phase it had.
  const phase = await landInDrafting(store)

  return {
    written,
    skipped,
    words: plan.chapters.reduce((sum, chapter) => sum + chapter.words, 0),
    ...(phase === undefined ? {} : { phase }),
  }
}

/**
 * Raise a book's phase to drafting when it has chapters but has not got there.
 *
 * @param store - the book just written into.
 * @returns the phase it was moved to, or undefined when it already qualified.
 */
async function landInDrafting(store: ProjectStore): Promise<Phase | undefined> {
  const chapters = await store.chapters()
  if (chapters.length === 0) return undefined
  const project = await store.readProject()
  if (PHASES.indexOf(project.phase) >= PHASES.indexOf('drafting')) return undefined
  await store.writeProject({ ...project, phase: 'drafting' })
  return 'drafting'
}
