/**
 * Pure text measurements.
 *
 * Every function here is deterministic and token-free: given the same string it
 * returns the same numbers. That property is what lets the gates run on every
 * write without spending a call, and what makes them testable.
 */

const FULL_WIDTH_OFFSET = 0xfee0

/** Fold full-width ASCII to half-width and collapse whitespace runs. */
export function normalize(text: string): string {
  return text
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - FULL_WIDTH_OFFSET))
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** Lower-cased, whitespace-free form used only for equality comparison. */
export function foldKey(text: string): string {
  return normalize(text).replace(/\s+/g, '').toLowerCase()
}

/** Count non-whitespace characters, the unit Chinese web platforms pay by. */
export function countChars(text: string): number {
  return text.replace(/\s/g, '').length
}

const SENTENCE_END = /[。！？!?…]+["'”’」』）)]*/g

/** Split into sentences, keeping terminal punctuation with the sentence. */
export function splitSentences(text: string): string[] {
  const out: string[] = []
  let cursor = 0
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length
    const piece = text.slice(cursor, end).trim()
    if (piece) out.push(piece)
    cursor = end
  }
  const rest = text.slice(cursor).trim()
  if (rest) out.push(rest)
  return out
}

/** Split into paragraphs on blank lines, dropping empties. */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

/**
 * Character shingles over a whitespace-stripped text.
 *
 * @param text - source text.
 * @param size - shingle width in characters.
 * @returns the distinct shingles.
 */
export function shingles(text: string, size: number): Set<string> {
  const flat = text.replace(/\s/g, '')
  const out = new Set<string>()
  for (let i = 0; i + size <= flat.length; i++) out.add(flat.slice(i, i + size))
  return out
}

/** Overlap of `a` inside `b` as a fraction of `a`, in [0, 1]. */
export function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0
  let shared = 0
  for (const item of a) if (b.has(item)) shared++
  return shared / a.size
}

/** Sample shared members, for evidence strings. */
export function sharedSample(a: Set<string>, b: Set<string>, limit: number): string[] {
  const out: string[] = []
  for (const item of a) {
    if (b.has(item)) out.push(item)
    if (out.length >= limit) break
  }
  return out
}

const COMMON_BIGRAMS = new Set([
  '的一', '一个', '自己', '没有', '他们', '我们', '你们', '这个', '那个', '什么',
  '就是', '可以', '已经', '还是', '因为', '所以', '但是', '然后', '现在', '如果',
  '这样', '那样', '起来', '出来', '过来', '时候', '地方', '东西', '事情', '感觉',
])

/** Overlapping two-character grams, dropping high-frequency function pairs. */
export function contentBigrams(text: string): Set<string> {
  const flat = text.replace(/[\s\p{P}]/gu, '')
  const out = new Set<string>()
  for (let i = 0; i + 2 <= flat.length; i++) {
    const gram = flat.slice(i, i + 2)
    if (!COMMON_BIGRAMS.has(gram)) out.add(gram)
  }
  return out
}

/** Last `chars` characters of a text, trimmed to a sentence boundary when possible. */
export function tailOf(text: string, chars: number): string {
  const flat = text.trim()
  if (flat.length <= chars) return flat
  const slice = flat.slice(flat.length - chars)
  const cut = slice.search(/[。！？!?…]/)
  return cut >= 0 && cut < slice.length - 1 ? slice.slice(cut + 1).trim() : slice.trim()
}

const QUOTED = /[“"「『][^”"」』]*[”"」』]/g

/** Fraction of characters that sit inside dialogue quotes, in [0, 1]. */
export function dialogueRatio(text: string): number {
  const total = countChars(text)
  if (total === 0) return 0
  let quoted = 0
  for (const match of text.matchAll(QUOTED)) quoted += countChars(match[0])
  return quoted / total
}

/** Arithmetic mean and standard deviation of a numeric series. */
export function meanStd(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 }
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  return { mean, std: Math.sqrt(variance) }
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}
