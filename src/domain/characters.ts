/**
 * Editing one character card.
 *
 * A card is written as a whole object, so every write path — the panel, the
 * `novel_canon` tool, an import — has to state every field it wants to keep.
 * That is exactly how imported notes got eaten in v0.12.1: a save mentioned the
 * fields it knew about and silently dropped the rest.
 *
 * So there is one merge function, and every door goes through it: a field left
 * `undefined` keeps whatever was stored, an empty string or an empty list clears
 * it, and a value replaces it. The panel and the tool therefore cannot disagree
 * about what "I only changed the voice" means.
 */
import type { CharacterCard, CharacterRelation, CharacterStage } from './types.ts'
import type { ProjectStore } from './store.ts'

/** What one edit asks for: a value to write, or nothing to keep the old one. */
export interface CardEdit {
  role?: CharacterCard['role'] | undefined
  voice?: string | undefined
  appearance?: string | undefined
  goal?: string | undefined
  secret?: string | undefined
  personality?: string | undefined
  status?: string | undefined
  aliases?: string[] | undefined
  stages?: CharacterStage[] | undefined
  relations?: CharacterRelation[] | undefined
  notes?: string | undefined
}

/** Drop blanks from a list of one-line values. */
export function cleanLines(lines: readonly string[]): string[] {
  return lines.map((line) => line.trim()).filter((line) => line !== '')
}

/** Drop blank stages and blank relation names, keeping the order given. */
export function cleanStages(stages: readonly CharacterStage[]): CharacterStage[] {
  return stages
    .map((stage) => ({ label: stage.label.trim(), text: stage.text.trim() }))
    .filter((stage) => stage.label !== '' || stage.text !== '')
}

/** Drop relations that do not name anybody. */
export function cleanRelations(relations: readonly CharacterRelation[]): CharacterRelation[] {
  return relations
    .map((relation) => ({ name: relation.name.trim(), kind: relation.kind.trim() }))
    .filter((relation) => relation.name !== '')
}

/**
 * A text field: `undefined` keeps, empty string removes, anything else writes.
 *
 * @param next - the requested value.
 * @param previous - the stored value.
 * @returns the value to store, or `undefined` for "not there".
 */
function text(next: string | undefined, previous: string | undefined): string | undefined {
  if (next === undefined) return previous === '' ? undefined : previous
  return next.trim() === '' ? undefined : next.trim()
}

/**
 * A list field: `undefined` keeps, an empty list removes, otherwise replaces.
 *
 * @param next - the requested list.
 * @param previous - the stored list.
 * @returns the list to store, or `undefined` for "not there".
 */
function list<T>(next: readonly T[] | undefined, previous: readonly T[] | undefined): T[] | undefined {
  if (next === undefined) return previous === undefined || previous.length === 0 ? undefined : [...previous]
  return next.length === 0 ? undefined : [...next]
}

/**
 * Apply one edit to a card, creating the card when it does not exist yet.
 *
 * @param store - the book.
 * @param name - the card's name; it is the key, so a rename is a different card.
 * @param edit - the fields to touch.
 * @returns the card as stored.
 */
export async function updateCharacter(store: ProjectStore, name: string, edit: CardEdit): Promise<CharacterCard> {
  const previous = (await store.characters()).find((card) => card.name === name)
  const keep = (field: 'voice' | 'appearance' | 'goal' | 'secret'): string => previous?.[field] ?? ''
  const card: CharacterCard = {
    name,
    role: edit.role ?? previous?.role ?? 'supporting',
    voice: edit.voice === undefined ? keep('voice') : edit.voice.trim(),
    appearance: edit.appearance === undefined ? keep('appearance') : edit.appearance.trim(),
    goal: edit.goal === undefined ? keep('goal') : edit.goal.trim(),
    secret: edit.secret === undefined ? keep('secret') : edit.secret.trim(),
    updatedAt: new Date().toISOString(),
  }
  const personality = text(edit.personality, previous?.personality)
  if (personality !== undefined) card.personality = personality
  const status = text(edit.status, previous?.status)
  if (status !== undefined) card.status = status
  const aliases = list(edit.aliases === undefined ? undefined : cleanLines(edit.aliases), previous?.aliases)
  if (aliases !== undefined) card.aliases = aliases
  const stages = list(edit.stages === undefined ? undefined : cleanStages(edit.stages), previous?.stages)
  if (stages !== undefined) card.stages = stages
  const relations = list(edit.relations === undefined ? undefined : cleanRelations(edit.relations), previous?.relations)
  if (relations !== undefined) card.relations = relations
  const notes = text(edit.notes, previous?.notes)
  if (notes !== undefined) card.notes = notes
  await store.upsertCharacter(card)
  return card
}

/**
 * Whether a name written on somebody else's card points at this person.
 *
 * A relation is written the way the writer thinks of them — 「格格」 for a card
 * named 「刘紫灵（网名刘格格…）」 — so an alias counts as a hit. Without this, half
 * the relationship web of an imported book reads as "no such character".
 *
 * @param card - the candidate person.
 * @param name - the name as some other card spelled it.
 * @returns true when this card answers to that name.
 */
export function answersTo(card: CharacterCard, name: string): boolean {
  return card.name === name || (card.aliases ?? []).includes(name)
}

/**
 * The relations other cards claim with this person.
 *
 * Derived, never stored: 「刘紫灵 是 王上 的 母亲」 lives on 刘紫灵's card, and this
 * answers "who says they are related to me" for 王上's page. The two sides cannot
 * drift because there is only one side on disk.
 *
 * @param cards - the whole cast.
 * @param name - whose page is being drawn.
 * @returns one entry per inbound claim, in cast order, skipping self-claims.
 */
export function inboundRelations(
  cards: readonly CharacterCard[],
  name: string,
): { from: string; kind: string }[] {
  const subject = cards.find((card) => card.name === name)
  const matches = (written: string): boolean =>
    written === name || (subject !== undefined && answersTo(subject, written))
  const found: { from: string; kind: string }[] = []
  for (const card of cards) {
    if (card.name === name) continue
    for (const relation of card.relations ?? []) {
      if (!matches(relation.name)) continue
      found.push({ from: card.name, kind: relation.kind })
    }
  }
  return found
}
