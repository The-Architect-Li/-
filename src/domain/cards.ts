/**
 * The chapter card: what a chapter was about, kept next to the outline.
 *
 * A card is written twice over a book's life — first as an intention in the
 * outline, then as a record of what actually got written. Both go through
 * {@link updateCard}, which merges instead of replacing: this repository has
 * already lost imported notes once to a "write the whole card" path, and a card
 * is exactly the kind of object that grows fields nobody thinks to pass back.
 */
import type { ChapterPlan } from './types.ts'
import type { ProjectStore } from './store.ts'

/** The fields a card edit may touch. Omitted means "leave what is there". */
export interface CardPatch {
  title?: string | undefined
  pov?: string | undefined
  characters?: string[] | undefined
  beats?: string[] | undefined
  hooks?: string[] | undefined
  summary?: string | undefined
  events?: string[] | undefined
  scene?: string | undefined
  approved?: boolean | undefined
}

/** A card edit aimed at a chapter that has no outline. */
export class MissingPlanError extends Error {
  constructor(number: number) {
    super(`第${number}章还没有章纲，先建一张再写它的章卡。`)
    this.name = 'MissingPlanError'
  }
}

/**
 * Merge a patch into one chapter's card and write it back.
 *
 * An empty string clears a text field and an empty array clears a list: both are
 * real edits. Only an *absent* field means "leave it alone".
 *
 * @param store - the book to write into.
 * @param number - the chapter whose card is being edited.
 * @param patch - fields to change; every field left out keeps its old value.
 * @returns the card as it now stands on disk.
 * @throws {MissingPlanError} when the chapter has no outline to attach a card to.
 */
export async function updateCard(store: ProjectStore, number: number, patch: CardPatch): Promise<ChapterPlan> {
  const plans = await store.plans()
  const previous = plans.find((plan) => plan.number === number)
  if (previous === undefined) throw new MissingPlanError(number)
  const next: ChapterPlan = { ...previous }

  if (patch.title !== undefined && patch.title !== '') next.title = patch.title
  if (patch.pov !== undefined) next.pov = patch.pov
  if (patch.characters !== undefined) next.characters = patch.characters
  if (patch.beats !== undefined) next.beats = patch.beats
  if (patch.hooks !== undefined) next.hooks = patch.hooks
  if (patch.events !== undefined) next.events = patch.events
  if (patch.approved !== undefined) next.approved = patch.approved
  if (patch.summary !== undefined) {
    if (patch.summary === '') delete next.summary
    else next.summary = patch.summary
  }
  if (patch.scene !== undefined) {
    if (patch.scene === '') delete next.scene
    else next.scene = patch.scene
  }

  await store.upsertPlan(next)
  return next
}

/**
 * The people the prose actually names.
 *
 * The card lists the cast the outline promised; this lists the ones whose names
 * are on the page. They disagree often enough — a promised character who never
 * walks on, a walk-on nobody planned — that showing both is worth the second
 * line.
 *
 * @param text - the chapter body.
 * @param names - every character name the book knows.
 * @returns the names found in the text, in the order the book lists them.
 */
export function presentInText(text: string, names: readonly string[]): string[] {
  if (text === '') return []
  return names.filter((name) => name !== '' && text.includes(name))
}
