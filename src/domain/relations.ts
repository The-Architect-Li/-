/**
 * Relations as edges: one record per pair, both ends named.
 *
 * v0.19 stored a relation on one card (`{ name, kind }`) and showed the other
 * side as 「别人写的」. That answered "who is X to me" but never "who am I to
 * them", so the reverse could only be displayed, never edited, and a symmetric
 * fact (夫妻) had to be written twice to look complete.
 *
 * An edge names both ends. `kind` is the word `from` uses about `to`; `reverse`
 * is the word `to` uses about `from` when the book bothers to say it. That keeps
 * one record instead of two, and both pages read the same record.
 */
import type { CharacterCard, Finding, RelationEdge, RelationFile, SeenRelation } from './types.ts'
/** Words where the same term describes both directions. Only a default. */
export const SYMMETRIC_KINDS = [
  '夫妻', '夫妇', '两口子', '兄弟', '姐妹', '兄妹', '姐弟', '双胞胎',
  '朋友', '好友', '挚友', '同事', '同学', '室友', '搭档', '邻居', '亲家', '对手', '宿敌',
]

/**
 * Whether a kind is normally symmetric.
 *
 * Used to pre-fill the tool's `symmetric` argument, never to override what the
 * author said: 「对手」 is symmetric in most books and asymmetric in some.
 *
 * @param kind - the relationship word.
 * @returns true when the word usually reads the same from both sides.
 */
export function looksSymmetric(kind: string): boolean {
  const word = kind.trim()
  return SYMMETRIC_KINDS.some((item) => word.includes(item))
}

/**
 * The names a written string could be answering to.
 *
 * Novelists write 「晨琳（端木晨琳）」 and 「刘紫灵（网名刘格格）」 — the same person,
 * spelled the way the sentence needed. Splitting on brackets and separators turns
 * both spellings into the same set, so a relation written under either name lands
 * on the right card. Exact matching alone found seven "no such character" entries
 * in a real book that were all one cast.
 *
 * @param name - a name as a card or a relation wrote it.
 * @returns the pieces worth comparing, longest first.
 */
export function nameTokens(name: string): string[] {
  return name
    .split(/[（）()【】[\]「」<>《》,，、·/|\s]+/)
    .map((token) => token.trim())
    .filter((token) => token !== '')
    .sort((left, right) => right.length - left.length)
}

/**
 * Whether two spellings could be the same person.
 *
 * Deliberately conservative: one side's piece has to equal a piece of the other,
 * so 「王上」 does not match 「王上势」 and 「格格」 does not match 「大格格」.
 *
 * @param left - one spelling.
 * @param right - the other.
 * @returns true when they share a name piece.
 */
export function sameName(left: string, right: string): boolean {
  if (left === right) return true
  const rightTokens = new Set(nameTokens(right))
  return nameTokens(left).some((token) => rightTokens.has(token))
}

/**
 * Every spelling a card answers to: its name, its pieces, and its aliases.
 *
 * @param card - the card.
 * @returns the strings to compare against.
 */
function spellings(card: CharacterCard): string[] {
  return [card.name, ...(card.aliases ?? [])]
}

/**
 * Whether an end of an edge is this person.
 *
 * @param end - the name written on the edge.
 * @param cards - the cast.
 * @param name - the card whose page is asking.
 * @returns true when one of that card's spellings matches the end.
 */
function endIs(end: string, cards: readonly CharacterCard[], name: string): boolean {
  const card = cards.find((item) => item.name === name)
  if (card === undefined) return end === name
  return spellings(card).some((spelling) => sameName(end, spelling))
}

/**
 * The stable id of the pair `a`–`b`, whichever end names it first.
 *
 * One edge per pair on purpose: a person who is 「母亲」 and 「徒弟」 of the same
 * person is a contradiction, not two rows, and the check below only sees it
 * because both would land here.
 *
 * @param a - one end.
 * @param b - the other end.
 * @returns an id that does not depend on argument order.
 */
export function relationId(a: string, b: string): string {
  const ends = [a.trim(), b.trim()].sort((left, right) => left.localeCompare(right, 'zh'))
  return `rel-${ends[0]}|${ends[1]}`
}

/**
 * An empty table.
 *
 * @returns a table with no edges.
 */
export function emptyRelations(): RelationFile {
  return { formatVersion: 1, edges: [] }
}

/**
 * Coerce whatever was on disk into a table.
 *
 * Missing fields and hand-edited files are normal in a writing tool: a book
 * directory gets copied, half-merged and edited in a text editor. Nothing here
 * throws on a malformed edge; a bad one is dropped so the rest still shows.
 *
 * @param raw - the parsed file, or undefined.
 * @returns a usable table.
 */
export function normaliseRelations(raw: RelationFile | undefined): RelationFile {
  const edges: RelationEdge[] = []
  const seen = new Set<string>()
  for (const item of raw?.edges ?? []) {
    if (item === null || typeof item !== 'object') continue
    const from = typeof item.from === 'string' ? item.from.trim() : ''
    const to = typeof item.to === 'string' ? item.to.trim() : ''
    const kind = typeof item.kind === 'string' ? item.kind.trim() : ''
    if (from === '' || to === '' || kind === '') continue
    if (from === to) continue
    const id = relationId(from, to)
    if (seen.has(id)) continue
    seen.add(id)
    edges.push({
      id,
      from,
      to,
      kind,
      symmetric: item.symmetric === true,
      ...(typeof item.note === 'string' && item.note.trim() !== '' ? { note: item.note.trim() } : {}),
      ...(typeof item.reverse === 'string' && item.reverse.trim() !== '' ? { reverse: item.reverse.trim() } : {}),
      ...(typeof item.since === 'number' && Number.isFinite(item.since) ? { since: Math.trunc(item.since) } : {}),
    })
  }
  return { formatVersion: 1, ...(raw?.migrated === true ? { migrated: true } : {}), edges }
}

/**
 * Fold the old one-sided card relations into edges.
 *
 * `from` is the card that carried the line, which is exactly what the old shape
 * meant. Notes written as free text stay in `kind` — splitting 「母女，但彼此不认」
 * into a kind and a note would guess where the word ends, and a wrong guess is
 * worse than a long word.
 *
 * @param cards - the cast as it stands.
 * @returns edges, one per pair, in cast order.
 */
export function deriveRelations(cards: readonly CharacterCard[]): RelationEdge[] {
  const edges: RelationEdge[] = []
  const seen = new Set<string>()
  for (const card of cards) {
    for (const relation of card.relations ?? []) {
      const to = relation.name.trim()
      const kind = relation.kind.trim()
      if (to === '' || kind === '') continue
      const id = relationId(card.name, to)
      if (seen.has(id)) continue
      seen.add(id)
      edges.push({ id, from: card.name, to, kind, symmetric: looksSymmetric(kind) })
    }
  }
  return edges
}

/**
 * Bring an old book up to date without losing what it already said.
 *
 * Runs once per book: after the fold, `migrated` is set and later card edits
 * cannot re-add edges the author has since deleted. A table that already has
 * edges is left alone — it is the file of record, not a cache of the cards.
 *
 * @param raw - the table on disk, if any.
 * @param cards - the cast, used only when the table is missing or empty.
 * @returns the table, and whether it changed.
 */
export function migrateRelations(
  raw: RelationFile | undefined,
  cards: readonly CharacterCard[],
): { file: RelationFile; changed: boolean } {
  const file = normaliseRelations(raw)
  if (file.migrated === true || file.edges.length > 0) return { file, changed: false }
  const derived = deriveRelations(cards)
  if (derived.length === 0) return { file, changed: false }
  return { file: { formatVersion: 1, migrated: true, edges: derived }, changed: true }
}

/**
 * How one page reads one edge.
 *
 * @param edge - the record.
 * @param viewer - whose page this is.
 * @returns the other end and the word *this* page uses about them.
 */
export function seenFrom(edge: RelationEdge, viewer: string): SeenRelation {
  const viewerIsFrom = edge.from === viewer
  const other = viewerIsFrom ? edge.to : edge.from
  const kind = viewerIsFrom ? edge.kind : edge.reverse ?? edge.kind
  return {
    id: edge.id,
    other,
    kind,
    symmetric: edge.symmetric,
    ...(edge.note === undefined ? {} : { note: edge.note }),
    ...(edge.since === undefined ? {} : { since: edge.since }),
  }
}

/**
 * Whether an edge touches a person, by card name or by any alias.
 *
 * @param edge - the record.
 * @param cards - the cast, for alias lookup.
 * @param name - the card name whose page is asking.
 * @returns true when either end is that person.
 */
export function touches(edge: RelationEdge, cards: readonly CharacterCard[], name: string): boolean {
  return endIs(edge.from, cards, name) || endIs(edge.to, cards, name)
}

/**
 * Every relation a person's page should show, other pages' claims included.
 *
 * @param file - the table.
 * @param cards - the cast, for alias lookup.
 * @param name - the card name whose page is asking.
 * @returns the relations, sorted by the other person's name.
 */
export function relationsOf(file: RelationFile, cards: readonly CharacterCard[], name: string): SeenRelation[] {
  // A relation may be written under a nickname or a bracketed spelling. Both ends
  // are settled to the card's own name when one answers to them, so the same
  // person cannot appear twice under two spellings on one page.
  const settle = (written: string): string =>
    cards.find((card) => spellings(card).some((spelling) => sameName(written, spelling)))?.name ?? written
  return file.edges
    .filter((edge) => touches(edge, cards, name))
    .map((edge) => {
      // Which end is the reader: an edge names both people, and the page may be
      // reached through any of that person's spellings.
      const mine = endIs(edge.from, cards, name) ? edge.from : edge.to
      const theirs = edge.from === mine ? edge.to : edge.from
      return { ...seenFrom(edge, mine), other: settle(theirs) }
    })
    .sort((left, right) => left.other.localeCompare(right.other, 'zh'))
}

/**
 * One relation as a single line of text.
 *
 * @param seen - the relation as one page reads it.
 * @returns 「王上 —— 母亲 · 但彼此不认（第3章起）」.
 */
export function describeRelation(seen: SeenRelation): string {
  const parts = [`${seen.other} —— ${seen.kind}`]
  if (seen.note !== undefined) parts.push(seen.note)
  if (seen.since !== undefined) parts.push(`第${seen.since}章起`)
  return parts.join(' · ')
}

/**
 * Add or change one edge, replacing any edge between the same two people.
 *
 * `kind` is always written from `from`'s point of view. When the author edits the
 * other page, `reverse` is what changes, so 「刘紫灵 → 王上：母亲」 and 「王上 → 刘紫灵：
 * 儿子」 stay one record that both pages can fix.
 *
 * @param file - the table.
 * @param draft - the ends, the word, and the flags.
 * @returns the table with the edge written.
 */
export function upsertRelation(
  file: RelationFile,
  draft: { from: string; to: string; kind: string; symmetric?: boolean; note?: string; reverse?: string; since?: number },
): RelationFile {
  const from = draft.from.trim()
  const to = draft.to.trim()
  if (from === '' || to === '' || from === to) return file
  const id = relationId(from, to)
  const previous = file.edges.find((item) => item.id === id)
  const symmetric = draft.symmetric ?? previous?.symmetric ?? looksSymmetric(draft.kind)
  const next: RelationEdge = {
    id,
    from,
    to,
    kind: draft.kind.trim(),
    symmetric,
    ...(draft.note === undefined || draft.note.trim() === '' ? {} : { note: draft.note.trim() }),
    ...(draft.reverse === undefined || draft.reverse.trim() === '' ? {} : { reverse: draft.reverse.trim() }),
    ...(draft.since === undefined ? {} : { since: draft.since }),
  }
  const edges = file.edges.filter((item) => item.id !== id)
  edges.push(next)
  edges.sort((left, right) => left.from.localeCompare(right.from, 'zh') || left.to.localeCompare(right.to, 'zh'))
  return { formatVersion: 1, migrated: true, edges }
}

/**
 * Remove one edge.
 *
 * @param file - the table.
 * @param id - the edge to drop.
 * @returns the table without it.
 */
export function removeRelation(file: RelationFile, id: string): RelationFile {
  return { formatVersion: 1, migrated: true, edges: file.edges.filter((item) => item.id !== id) }
}

/**
 * The problems a relation table can have on its own.
 *
 * Duplicate and self edges cannot exist after `normaliseRelations`, so the two
 * that matter are a name that answers to no card, and a pair claimed by two kinds
 * at once (the author wrote 「母亲」 on one page and 「徒弟」 on the other).
 *
 * @param file - the table.
 * @param cards - the cast.
 * @returns findings, error for a contradiction, info for an unknown name.
 */
export function checkRelations(file: RelationFile, cards: readonly CharacterCard[]): Finding[] {
  const findings: Finding[] = []
  for (const edge of file.edges) {
    const known = cards.some((card) => spellings(card).some((spelling) => sameName(spelling, edge.from)))
      && cards.some((card) => spellings(card).some((spelling) => sameName(spelling, edge.to)))
    if (!known) {
      findings.push({
        code: 'relations/unknown-person',
        severity: 'info',
        message: `关系里有一个名字对不上角色卡：${edge.from} —— ${edge.kind} —— ${edge.to}`,
        evidence: 'novel_canon action="list" 能看到现有角色卡；写到一半的人先开着卡再补关系也可以。',
      })
    }
    if (edge.symmetric && edge.reverse !== undefined && edge.reverse !== edge.kind) {
      findings.push({
        code: 'relations/contradiction',
        severity: 'error',
        message: `对称关系却写了两个词：${edge.from} 叫 ${edge.to} 「${edge.kind}」，反过来叫「${edge.reverse}」`,
        evidence: '夫妻、兄弟这类关系两边是同一个词；如果一个方向另有说法，那它就不是对称关系。',
      })
    }
  }
  return findings
}
