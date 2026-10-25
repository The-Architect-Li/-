/**
 * Writing an import plan into a book.
 *
 * The tool and the panel's create dialog both import, and both must land the
 * same plan the same way — chapter bodies through `writeChapter` so the index
 * gets a revision, cards through `upsertCharacter` so names collide correctly.
 * That rule lives here once.
 */
import { PHASES, type CharacterCard, type Phase } from './types.ts'
import type { ImportPlan } from './import-scan.ts'
import type { ProjectStore } from './store.ts'

/**
 * Fill a card in, without overwriting anything already written.
 *
 * The second import of the same folder must be safe: by then the writer has
 * probably typed a status or a relation that the 人物/*.md file never had, and a
 * whole-card replace would take those away. So an imported value only lands
 * where the stored one is empty — the same rule the premise follows, for the
 * same reason.
 *
 * @param previous - the card on disk, when there is one.
 * @param incoming - the card the plan wants to write.
 * @returns the card to store.
 */
function topUpCard(previous: CharacterCard | undefined, incoming: CharacterCard): CharacterCard {
  if (previous === undefined) return incoming
  const pick = (field: 'voice' | 'appearance' | 'goal' | 'secret' | 'personality' | 'status' | 'notes', next: string | undefined): string | undefined => {
    const stored = previous[field]
    if (stored !== undefined && stored.trim() !== '') return stored
    return next
  }
  const card: CharacterCard = {
    ...previous,
    role: previous.role === 'supporting' && incoming.role !== 'supporting' ? incoming.role : previous.role,
    voice: pick('voice', incoming.voice) ?? '',
    appearance: pick('appearance', incoming.appearance) ?? '',
    goal: pick('goal', incoming.goal) ?? '',
    secret: pick('secret', incoming.secret) ?? '',
    updatedAt: new Date().toISOString(),
  }
  const personality = pick('personality', incoming.personality)
  if (personality !== undefined) card.personality = personality
  const status = pick('status', incoming.status)
  if (status !== undefined) card.status = status
  const notes = pick('notes', incoming.notes)
  if (notes !== undefined) card.notes = notes
  if ((previous.aliases ?? []).length === 0 && (incoming.aliases ?? []).length > 0) card.aliases = incoming.aliases
  if ((previous.stages ?? []).length === 0 && (incoming.stages ?? []).length > 0) card.stages = incoming.stages
  if ((previous.relations ?? []).length === 0 && (incoming.relations ?? []).length > 0) card.relations = incoming.relations
  return card
}

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
  const cards = new Map((await store.characters()).map((card) => [card.name, card]))
  for (const { card } of plan.cast) await store.upsertCharacter(topUpCard(cards.get(card.name), card))

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
