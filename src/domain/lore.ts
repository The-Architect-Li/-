/**
 * Reading the canon out of prose that is already written.
 *
 * A half-finished novel arrives with a mature world and a cast the author has
 * spent a year on. All of it is in the prose; none of it is in the book's
 * shape. The gap is not cosmetic — an empty character drawer says "this tool
 * does not recognise your book", and a reviewer with no card has nothing to be
 * consistent with.
 *
 * Three rules keep this from producing confident nonsense:
 *
 * - every entry must carry a quote from the text it was read out of;
 * - fields the text does not state stay empty, and `voice` is never guessed —
 *   it is the one field a later check measures against, and a guess there
 *   condemns every character who grows;
 * - a card that already exists is topped up, never overwritten.
 */
import type { CharacterCard, CharacterRole, PlaceCard, WorldEntry } from './types.ts'

/** One person the text names. */
export interface LoreCharacter {
  name: string
  aliases: string[]
  appearance: string
  goal: string
  secret: string
  personality: string
  /** How often the name came up, when the caller counted it. */
  chapters: number
  /** The line this was read from. */
  quote: string
}

/** One place the text names. */
export interface LorePlace {
  name: string
  kind: string
  detail: string
  chapters: number
  quote: string
}

/** One faction, rule, item or historical event. */
export interface LoreWorld {
  name: string
  kind: string
  detail: string
  quote: string
}

/** Everything one reading produced. */
export interface LoreResult {
  characters: LoreCharacter[]
  places: LorePlace[]
  world: LoreWorld[]
  premise: string
}

/** An empty result, for the batches that read nothing usable. */
export function emptyLore(): LoreResult {
  return { characters: [], places: [], world: [], premise: '' }
}

/** What one lore batch is told. */
export interface LorePromptInput {
  /** Where the text came from, e.g. 第1–40章. */
  span: string
  /** The prose, already trimmed by the caller. */
  text: string
}

/**
 * The lorekeeper's prompt for one batch.
 *
 * A batch is many chapters at once on purpose: a character's goal is stated
 * once in chapter 3 and shown again in chapter 60, and a reader who has only
 * one chapter cannot tell a main character from a walk-on. The cost is that the
 * prompt holds a lot of prose, so the caller decides how much.
 *
 * @param input - the span label and the text.
 * @param persona - the role's persona.
 * @param contract - the role's output contract.
 * @returns the prompt.
 */
export function buildLorePrompt(input: LorePromptInput, persona: string, contract: string): string {
  return [
    persona,
    '',
    `## 这一段是：${input.span}`,
    '读完它，把里面已经写明白的人、地点、势力与规则整理出来。每一条都要附上你是从哪一句读到的。',
    '',
    input.text,
    '',
    contract,
  ].join('\n')
}

/** Strip fences and everything outside the outermost braces. */
function sliceJsonObject(output: string): string {
  const cleaned = output.replace(/```json|```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return cleaned
  return cleaned.slice(start, end + 1)
}

/** A trimmed string field, or `''`. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** An array of names, deduped, blanks dropped. */
function names(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const name = text(item)
    if (name !== '' && !out.includes(name)) out.push(name)
  }
  return out
}

/**
 * Read the lorekeeper's answer.
 *
 * An entry without a quote is dropped rather than trusted: the quote is the
 * only thing separating "read from the text" from "sounds plausible", and this
 * is the pass that decides what every later review measures against.
 *
 * @param output - the child's raw text.
 * @returns whatever parsed, with the unquotable entries removed.
 */
export function parseLoreOutput(output: string): LoreResult {
  let value: unknown
  try {
    value = JSON.parse(sliceJsonObject(output))
  } catch {
    return emptyLore()
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return emptyLore()
  const record = value as Record<string, unknown>

  const characters: LoreCharacter[] = []
  for (const entry of Array.isArray(record.characters) ? record.characters : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as Record<string, unknown>
    const name = text(item.name)
    if (name === '') continue
    const quote = text(item.quote)
    if (quote === '') continue
    characters.push({
      name,
      aliases: names(item.aliases).filter((alias) => alias !== name),
      appearance: text(item.appearance),
      goal: text(item.goal),
      secret: text(item.secret),
      personality: text(item.personality),
      chapters: 0,
      quote,
    })
  }

  const places: LorePlace[] = []
  for (const entry of Array.isArray(record.places) ? record.places : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as Record<string, unknown>
    const name = text(item.name)
    const quote = text(item.quote)
    if (name === '' || quote === '') continue
    places.push({
      name,
      kind: text(item.kind) || '地点',
      detail: text(item.detail),
      chapters: 0,
      quote,
    })
  }

  const world: LoreWorld[] = []
  for (const entry of Array.isArray(record.world) ? record.world : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as Record<string, unknown>
    const name = text(item.name)
    const quote = text(item.quote)
    if (name === '' || quote === '') continue
    world.push({ name, kind: text(item.kind) || '设定', detail: text(item.detail), quote })
  }

  return { characters, places, world, premise: text(record.premise) }
}

/**
 * Roll several readings into one, keeping the fuller answer for each name.
 *
 * Reading in batches means the same person is described four times with four
 * different amounts of detail. The first answer is not the best one — a
 * character is stranger in chapter 80 than in chapter 2 — so the longer field
 * wins, and the chapter count is summed as evidence of weight.
 *
 * @param parts - one result per batch.
 * @returns the combined reading.
 */
export function mergeLore(parts: readonly LoreResult[]): LoreResult {
  const characters = new Map<string, LoreCharacter>()
  const places = new Map<string, LorePlace>()
  const world = new Map<string, LoreWorld>()
  let premise = ''

  for (const part of parts) {
    if (premise === '' && part.premise.trim() !== '') premise = part.premise.trim()
    for (const entry of part.characters) {
      const previous = characters.get(entry.name)
      if (previous === undefined) {
        characters.set(entry.name, { ...entry })
        continue
      }
      characters.set(entry.name, {
        name: previous.name,
        aliases: [...new Set([...previous.aliases, ...entry.aliases])].filter((alias) => alias !== previous.name),
        // Longer wins: detail accumulates across a book, never shrinks.
        appearance: entry.appearance.length > previous.appearance.length ? entry.appearance : previous.appearance,
        goal: entry.goal.length > previous.goal.length ? entry.goal : previous.goal,
        secret: entry.secret.length > previous.secret.length ? entry.secret : previous.secret,
        personality: entry.personality.length > previous.personality.length ? entry.personality : previous.personality,
        chapters: previous.chapters + entry.chapters,
        quote: previous.quote,
      })
    }
    for (const entry of part.places) {
      const previous = places.get(entry.name)
      if (previous === undefined) {
        places.set(entry.name, { ...entry })
        continue
      }
      places.set(entry.name, {
        ...previous,
        kind: previous.kind === '地点' && entry.kind !== '地点' ? entry.kind : previous.kind,
        detail: entry.detail.length > previous.detail.length ? entry.detail : previous.detail,
        chapters: previous.chapters + entry.chapters,
      })
    }
    for (const entry of part.world) {
      const previous = world.get(entry.name)
      if (previous === undefined) {
        world.set(entry.name, { ...entry })
        continue
      }
      world.set(entry.name, {
        ...previous,
        detail: entry.detail.length > previous.detail.length ? entry.detail : previous.detail,
      })
    }
  }

  return {
    characters: [...characters.values()].sort((a, b) => b.chapters - a.chapters || a.name.localeCompare(b.name, 'zh')),
    places: [...places.values()].sort((a, b) => b.chapters - a.chapters || a.name.localeCompare(b.name, 'zh')),
    world: [...world.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh')),
    premise,
  }
}

/**
 * The role a character card is created with.
 *
 * Everyone starts as `supporting`. Promoting someone to protagonist is a claim
 * about the book's shape, and `role` is what the gate counts to decide the book
 * is ready to outline — an automatic promotion would open that gate on a guess.
 *
 * @returns the role for a newly created card.
 */
export function roleForNewCard(): CharacterRole {
  return 'supporting'
}

/**
 * Build a card for a name the book has never held.
 *
 * `voice` is left empty on purpose. It is the field the character-consistency
 * reviewer compares dialogue against; a guessed voice turns every later
 * deviation into a reported error, and every real growth into a defect.
 *
 * @param entry - what the reading found.
 * @param now - timestamp for the card.
 * @returns the card to store.
 */
export function characterFromLore(entry: LoreCharacter, now: Date = new Date()): CharacterCard {
  return {
    name: entry.name,
    role: roleForNewCard(),
    voice: '',
    appearance: entry.appearance,
    goal: entry.goal,
    secret: entry.secret,
    ...(entry.aliases.length > 0 ? { aliases: entry.aliases } : {}),
    ...(entry.personality === '' ? {} : { personality: entry.personality }),
    ...(entry.quote === '' ? {} : { notes: `考据自正文：「${entry.quote.slice(0, 80)}」` }),
    updatedAt: now.toISOString(),
  }
}

/**
 * Fill the gaps in a card that already exists.
 *
 * Same rule as the importer's `topUpCard`: a field the author wrote is never
 * replaced by a field a model read. What is empty gets filled, what is written
 * stays — including `voice`, which this pass never writes at all.
 *
 * @param previous - the card on disk.
 * @param entry - what the reading found.
 * @param now - timestamp.
 * @returns the card to store.
 */
export function topUpFromLore(previous: CharacterCard, entry: LoreCharacter, now: Date = new Date()): CharacterCard {
  const keep = (stored: string | undefined, next: string): string =>
    stored !== undefined && stored.trim() !== '' ? stored : next
  const card: CharacterCard = {
    ...previous,
    appearance: keep(previous.appearance, entry.appearance),
    goal: keep(previous.goal, entry.goal),
    secret: keep(previous.secret, entry.secret),
    updatedAt: now.toISOString(),
  }
  const personality = keep(previous.personality, entry.personality)
  if (personality !== '') card.personality = personality
  if ((previous.aliases ?? []).length === 0 && entry.aliases.length > 0) card.aliases = entry.aliases
  return card
}

/**
 * Build a place card for a name the book has never held.
 *
 * @param entry - what the reading found.
 * @param chapter - the chapter it was read from.
 * @param now - timestamp.
 * @returns the card to store.
 */
export function placeFromLore(entry: LorePlace, chapter: number, now: Date = new Date()): PlaceCard {
  return {
    name: entry.name,
    aliases: [],
    kind: entry.kind,
    firstChapter: chapter,
    latestChapter: chapter,
    detail: entry.detail,
    states: entry.detail === '' ? [] : [{ chapter, detail: entry.detail }],
    updatedAt: now.toISOString(),
  }
}

/**
 * Build a world entry for a name the book has never held.
 *
 * @param entry - what the reading found.
 * @param now - timestamp.
 * @returns the entry to store.
 */
export function worldFromLore(entry: LoreWorld, now: Date = new Date()): WorldEntry {
  return { name: entry.name, kind: entry.kind, detail: entry.detail, updatedAt: now.toISOString() }
}
