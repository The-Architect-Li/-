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
import { relationId, removeRelation, upsertRelation } from './relations.ts'

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

  // Relations live in their own table since v0.21: one edge per pair, both ends
  // named, so the other person's page can edit the same record. A card edit that
  // mentions relations rewrites exactly the lines it gives and leaves every other
  // edge alone — the same "only what you named" rule the rest of this file
  // follows. Reading the table first is what folds a pre-v0.21 book's one-sided
  // lines in, so an edit cannot silently drop what the card used to say.
  const table = await store.relations()
  if (edit.relations === undefined) {
    // Keeping the stored relations means keeping the edges too, not re-stating them.
    delete card.relations
  } else {
    const incoming = cleanRelations(edit.relations)
    const stated = new Set(incoming.map((relation) => relationId(name, relation.name)))
    let next = table
    // A line the author deleted: drop the edge if this card was the one claiming it.
    for (const edge of table.edges) {
      if (edge.from === name && !stated.has(edge.id)) next = removeRelation(next, edge.id)
    }
    for (const relation of incoming) {
      const id = relationId(name, relation.name)
      const existing = next.edges.find((edge) => edge.id === id)
      if (existing === undefined) {
        next = upsertRelation(next, { from: name, to: relation.name, kind: relation.kind })
        continue
      }
      // The edge exists. The author is on one of its two pages, and the word they
      // typed describes the other person *from this page*. If this page is the
      // `from` end it is the kind; otherwise it is the reverse, and flipping the
      // direction instead would quietly take the other person's word away.
      next = existing.from === name
        ? upsertRelation(next, { ...existing, kind: relation.kind })
        : upsertRelation(next, { ...existing, reverse: relation.kind })
    }
    await store.writeRelations(next)
    delete card.relations
  }

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
