/**
 * Looking for a word in a book you can no longer hold in your head.
 *
 * Past a few hundred thousand characters a novel stops being something an
 * author remembers and becomes something they look things up in: where did I
 * first call it 瑶光境, has 老周 been on stage since chapter 74, did I already
 * use this sentence. Without a lookup, writing the next chapter runs on
 * memory — and memory is exactly what a long book wears out first.
 *
 * The scan is a plain substring walk over prose already on disk. No model, no
 * index, no tokens: 1.2 million characters take a few milliseconds and the
 * answer is the same every time, which is what a reference tool has to be.
 *
 * Terms are space-separated and **all** must appear in a chapter for it to
 * count. That is the useful default —「沈砚 瑶光境」should find the chapter where
 * both happen, not the union of two unrelated lists.
 */
import { countChars } from './text.ts'
import type { ChapterDraft } from './types.ts'

/** Characters of context kept on each side of a hit. */
export const SPREAD = 28

/** One chapter that matched. */
export interface SearchHit {
  number: number
  title: string
  /** How many times the whole query appears in this chapter. */
  count: number
  /** A sample of where it appears, one line each. */
  samples: string[]
  words: number
}

/** What one search found. */
export interface SearchResult {
  /** The terms that were actually searched for. */
  terms: string[]
  hits: SearchHit[]
  /** Chapters that were read. */
  scanned: number
  /** Words read, for the "this was not free" line. */
  words: number
  /** Chapters that held every term, including the ones past `limit`. */
  matched: number
  /** True when the result was cut at `limit`. */
  truncated: boolean
}

/** Longest query worth honouring. */
export const MAX_TERMS = 8
/** Longest single term. */
const MAX_TERM_CHARS = 60
/** How many occurrences one chapter is allowed to count before "999+" is enough. */
const COUNT_CAP = 999

/**
 * Split a query into terms.
 *
 * Chinese has no spaces, so a multi-word query is the author's own grouping —
 * 「沈砚 瑶光境」means both, 「瑶光境」means the word itself. Quoted runs are kept
 * whole so a phrase with a space inside it stays one term.
 *
 * @param raw - what the caller typed.
 * @returns the terms, deduped, in the order given.
 */
export function parseTerms(raw: string): string[] {
  const out: string[] = []
  const cleaned = String(raw ?? '').trim()
  if (cleaned === '') return out
  const quoted = /"[^"]+"|“[^”]+”|「[^」]+」/g
  const phrases: string[] = []
  const rest = cleaned.replace(quoted, (match) => {
    phrases.push(match.slice(1, -1).trim())
    return ' '
  })
  for (const term of [...phrases, ...rest.split(/[\s,，、]+/)]) {
    const value = term.trim().slice(0, MAX_TERM_CHARS)
    if (value !== '' && !out.includes(value)) out.push(value)
  }
  return out.slice(0, MAX_TERMS)
}

/**
 * All positions of one term in one text, up to a cap.
 *
 * @param text - the haystack.
 * @param term - the needle.
 * @param cap - how many positions to collect.
 * @returns byte offsets, ascending.
 */
function positionsOf(text: string, term: string, cap: number): number[] {
  const found: number[] = []
  let at = text.indexOf(term)
  while (at >= 0 && found.length < cap) {
    found.push(at)
    at = text.indexOf(term, at + term.length)
  }
  return found
}

/**
 * A hit with its surroundings, flattened to one line.
 *
 * Newlines are folded to spaces because the panel and the transcript both draw
 * one line per sample; a paragraph break inside the snippet would silently cut
 * the rest of it.
 *
 * @param text - the chapter body.
 * @param at - offset of the first term.
 * @param length - length of the matched text.
 * @returns the context line.
 */
export function contextAt(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SPREAD)
  const end = Math.min(text.length, at + length + SPREAD)
  const head = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${head}${body}${tail}`
}

/**
 * Search every chapter for the terms.
 *
 * A chapter counts only when it holds all of them; `count` is the occurrences of
 * the first term, which is the one the author is usually tracking.
 *
 * @param chapters - every chapter with its text.
 * @param terms - what to look for.
 * @param options - range and cap.
 * @returns the hits in reading order.
 */
export function searchChapters(
  chapters: readonly ChapterDraft[],
  terms: readonly string[],
  options: { from?: number; to?: number; limit?: number; samples?: number } = {},
): SearchResult {
  const limit = options.limit ?? 40
  const samples = options.samples ?? 2
  const hits: SearchHit[] = []
  let scanned = 0
  let words = 0
  let matched = 0

  for (const chapter of chapters) {
    if (options.from !== undefined && chapter.number < options.from) continue
    if (options.to !== undefined && chapter.number > options.to) continue
    const text = chapter.text
    if (text.trim() === '') continue
    scanned += 1
    words += countChars(text)

    // Every term must be present; the cheap one-first order matters on a big
    // book — the rarest term usually kills the chapter immediately.
    let missing = false
    for (const term of terms) {
      if (!text.includes(term)) {
        missing = true
        break
      }
    }
    if (missing) continue

    // Keep counting after the display cap so the totals stay honest: "40 章命中"
    // must mean forty, not "we stopped looking after forty".
    matched += 1
    if (hits.length >= limit) continue
    // Count with a high cap and sample with a low one: 「3 次」 must mean three
    // times, not "as many as we bothered to collect".
    const all = positionsOf(text, terms[0]!, COUNT_CAP)
    if (all.length === 0) continue
    hits.push({
      number: chapter.number,
      title: chapter.title,
      count: all.length,
      samples: all.slice(0, samples).map((offset) => contextAt(text, offset, terms[0]!.length)),
      words: chapter.words,
    })
  }

  return { terms: [...terms], hits, matched, scanned, words, truncated: matched > hits.length }
}

/**
 * The report, in the shape a writer reads.
 *
 * @param result - what the search found.
 * @param query - what was typed, for the heading.
 * @returns the report text.
 */
export function describeSearch(result: SearchResult, query: string): string {
  if (result.terms.length === 0) {
    return '要搜什么？给一个词。多个词用空格分开，表示「都要出现」；带空格的短语用引号括起来。'
  }
  const terms = result.terms.map((term) => `「${term}」`).join(' ')
  if (result.hits.length === 0) {
    return [
      `没有找到 ${terms}。`,
      `看过的范围：${result.scanned} 章、${(result.words / 10000).toFixed(1)} 万字。`,
      '',
      '多个词是全都要出现。只记得一个词就只给一个；不确定写法就搜短一点的两三个字。',
    ].join('\n')
  }
  const lines = [
    `${terms}：${result.matched} 章命中${result.truncated ? `（只列前 ${result.hits.length} 章）` : ''}。`,
    '',
  ]
  for (const hit of result.hits) {
    lines.push(`第${hit.number}章《${hit.title}》　${hit.count} 次`)
    for (const sample of hit.samples) lines.push(`    ${sample}`)
  }
  lines.push('', `看了 ${result.scanned} 章、${(result.words / 10000).toFixed(1)} 万字。要读某一章：novel_chapter action="read" number=N`)
  return lines.join('\n')
}
