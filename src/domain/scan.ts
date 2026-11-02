/**
 * Deterministic manuscript scanner.
 *
 * These checks cost no tokens and give the same answer twice. They find the
 * failure modes that models are blind to in their own output: cross-chapter
 * repetition, flat sentence rhythm, stock phrasing, and a chapter that simply
 * stops instead of ending.
 */
import type { ChapterDraft, Finding, InkwellConfig } from './types.ts'
import {
  containment,
  countChars,
  countOccurrences,
  dialogueRatio,
  meanStd,
  sharedSample,
  shingles,
  splitParagraphs,
  splitSentences,
} from './text.ts'

/**
 * Words that start a sentence as grammar, not as a name.
 *
 * They are deliberately *not* treated as names below: a chapter where forty
 * sentences begin with 「他」 has a real problem, and excluding it would hide the
 * one thing this check is good at. Pronouns and connectives are exactly the
 * openings that can be flat.
 */
const GRAMMAR_OPENERS = new Set([
  '他', '她', '它', '我', '你', '您', '咱', '这', '那', '其', '此', '该', '每', '各',
  '但', '而', '却', '也', '又', '只', '就', '便', '才', '还', '再', '已', '曾', '正',
  '忽', '突', '猛', '骤', '顿', '渐', '依', '仍', '终', '于', '在', '从', '随', '被',
  '把', '将', '为', '因', '若', '如', '虽', '即', '凡', '所', '众', '一', '两', '三',
  '半', '片', '声', '有', '没', '不', '无', '是', '就', '要', '想', '能', '会', '可',
])

/**
 * Find the names in a manuscript that has no character cards yet.
 *
 * An imported book starts with prose and nothing else, so `properNames` has
 * nothing to offer — and the opening check then reports the protagonist's name
 * as a stylistic tic, forty times per chapter. But a name has a signature the
 * prose can be read for: **it opens sentences in chapter after chapter**. 「路长」
 * appears at the start of sentences across hundreds of chapters because 路长远 is
 * the protagonist; 「仿佛」 might too, and that one is caught by the tone check
 * instead.
 *
 * @param chapters - every chapter with its text.
 * @param ratio - share of chapters a two-character opening must appear in. 15%
 *   was measured on a 521-chapter book: it caught the three leads and left the
 *   ordinary adverbs alone. Higher misses a lead whose arc is one third of the
 *   book; lower starts excluding 「仿佛」, which the tone check needs to report.
 * @returns the openings that behave like names.
 */
export function discoverOpeners(chapters: readonly ChapterDraft[], ratio = 0.15): string[] {
  const usable = chapters.filter((chapter) => chapter.text.trim() !== '')
  if (usable.length < 5) return []
  const spread = new Map<string, number>()
  for (const chapter of usable) {
    const seen = new Set<string>()
    for (const sentence of splitSentences(chapter.text)) {
      const opening = sentence.replace(OPENING_STRIP, '').slice(0, 2)
      if (opening.length < 2) continue
      if (GRAMMAR_OPENERS.has(opening[0]!)) continue
      seen.add(opening)
    }
    for (const opening of seen) spread.set(opening, (spread.get(opening) ?? 0) + 1)
  }
  const need = Math.max(3, Math.ceil(usable.length * ratio))
  return [...spread.entries()]
    .filter(([, count]) => count >= need)
    .map(([opening]) => opening)
    .sort((a, b) => b.length - a.length)
}

/**
 * Every proper noun the book has already named.
 *
 * The opening check needs this to tell 「他推开门」 from 「路长远推开门」: the first is a
 * flat opening, the second is a sentence about a person. A name is not a
 * stylistic tic, and reporting it as one teaches the author to ignore the
 * report.
 *
 * @param source - the book's characters, places and world entries.
 * @returns names and aliases, longest first so a longer name wins the match.
 */
export function properNames(source: {
  characters?: readonly { name: string; aliases?: readonly string[] }[]
  places?: readonly { name: string; aliases?: readonly string[] }[]
  world?: readonly { name: string }[]
}): string[] {
  const names = new Set<string>()
  for (const card of source.characters ?? []) {
    if (card.name.trim() !== '') names.add(card.name.trim())
    for (const alias of card.aliases ?? []) if (alias.trim() !== '') names.add(alias.trim())
  }
  for (const card of source.places ?? []) {
    if (card.name.trim() !== '') names.add(card.name.trim())
    for (const alias of card.aliases ?? []) if (alias.trim() !== '') names.add(alias.trim())
  }
  for (const entry of source.world ?? []) if (entry.name.trim() !== '') names.add(entry.name.trim())
  return [...names].sort((a, b) => b.length - a.length)
}

const OPENING_STRIP = /^["'“”「『（(\s]+/

/** Compare one draft against every earlier chapter for reused phrasing. */
export function scanRepetition(
  draft: ChapterDraft,
  previous: ChapterDraft[],
  config: InkwellConfig,
): Finding[] {
  const size = config.repeatShingleSize
  const current = shingles(draft.text, size)
  if (current.size === 0) return []

  const findings: Finding[] = []
  for (const earlier of previous) {
    if (earlier.number === draft.number) continue
    const other = shingles(earlier.text, size)
    const ratio = containment(current, other)
    if (ratio < config.repeatWarnRatio) continue
    const samples = sharedSample(current, other, 3)
    findings.push({
      code: 'scan/repetition',
      severity: ratio >= config.repeatErrorRatio ? 'warn' : 'info',
      message: `与第${earlier.number}章有 ${(ratio * 100).toFixed(1)}% 的 ${size} 字片段重合，超过阈值 ${(config.repeatWarnRatio * 100).toFixed(0)}%`,
      evidence: samples.map((item) => `「${item}」`).join(' '),
    })
  }
  return findings
}

/** Sentences that all begin with the same characters. */
export function scanOpenings(
  text: string,
  config: InkwellConfig,
  proper: readonly string[] = [],
): Finding[] {
  const sentences = splitSentences(text)
  // A name at the start of a sentence is not a flat opening, it is a character
  // doing something. Without this the main character's name — 路长远, appearing
  // forty times in one chapter — is reported as 「40 个句子以『路长』开头」, and a
  // report that is wrong forty times in a row is one the author turns off.
  const names = proper.filter((name) => name.length >= 2)
  const counts = new Map<string, number>()
  for (const sentence of sentences) {
    const cleaned = sentence.replace(OPENING_STRIP, '')
    if (names.some((name) => cleaned.startsWith(name))) continue
    const opening = cleaned.slice(0, 2)
    if (opening.length < 2) continue
    counts.set(opening, (counts.get(opening) ?? 0) + 1)
  }

  // One finding, not one per opening: `scanChapter` keeps the first finding per
  // code, so a chapter with seven flat openings used to report whichever one
  // happened to be seen first — often the least interesting. Ranking them and
  // naming the top few is both shorter and more useful.
  const offenders = [...counts.entries()]
    .filter(([, count]) => count >= config.openingRepeatMin)
    .sort((a, b) => b[1] - a[1])
  if (offenders.length === 0) return []
  const top = offenders.slice(0, 3).map(([opening, count]) => `${opening}×${count}`)
  return [
    {
      code: 'scan/opening-repeat',
      severity: 'warn',
      message: `${offenders.length} 种开头反复出现，段落起手太单一`,
      evidence: `最高几个：${top.join(' ')}（阈值：同一开头最多 ${config.openingRepeatMin - 1} 次）`,
    },
  ]
}

/** Sentence-length dispersion as a proxy for rhythm. */
export function scanRhythm(text: string, config: InkwellConfig): Finding[] {
  const lengths = splitSentences(text).map((sentence) => countChars(sentence))
  if (lengths.length < 8) return []
  const { mean, std } = meanStd(lengths)
  if (mean === 0) return []
  const ratio = std / mean
  if (ratio >= config.rhythmStdRatioWarn) return []
  return [
    {
      code: 'scan/rhythm-flat',
      severity: 'warn',
      message: `句长离散度只有 ${ratio.toFixed(2)}（阈值 ${config.rhythmStdRatioWarn}），句子长短太均匀，读起来平`,
      evidence: `平均句长 ${mean.toFixed(1)} 字，标准差 ${std.toFixed(1)}，共 ${lengths.length} 句`,
    },
  ]
}

/** Stock phrases and filler adverbs, counted per 1000 characters. */
export function scanTone(text: string, config: InkwellConfig): Finding[] {
  const chars = Math.max(countChars(text), 1)
  const hits = config.aiToneWords
    .map((word) => ({ word, count: countOccurrences(text, word) }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)

  const total = hits.reduce((sum, item) => sum + item.count, 0)
  if (total === 0) return []
  const density = (total / chars) * 1000
  const top = hits.slice(0, 6).map((item) => `${item.word}×${item.count}`)

  // 「密度在阈值内」 is not a finding. It used to be reported as an info line, and
  // a full-book pass then showed dozens of lines saying nothing was wrong —
  // which is how the one line that matters gets skimmed past.
  if (density < config.aiToneWarnPer1000) return []
  return [
    {
      code: 'scan/tone-heavy',
      severity: 'warn',
      message: `套路词密度 ${density.toFixed(1)}/千字，超过阈值 ${config.aiToneWarnPer1000}`,
      evidence: top.join(' '),
    },
  ]
}

/** Dialogue share and paragraph shape. */
export function scanShape(text: string, config: InkwellConfig): Finding[] {
  const findings: Finding[] = []
  const ratio = dialogueRatio(text)
  if (ratio < config.dialogueMinRatio) {
    findings.push({
      code: 'scan/dialogue-low',
      severity: 'info',
      message: `对话占比 ${(ratio * 100).toFixed(0)}%，低于 ${(config.dialogueMinRatio * 100).toFixed(0)}%，场景可能变成了概述`,
      evidence: '连续叙述超过两屏时，考虑改成对话或动作来推进',
    })
  }

  const paragraphs = splitParagraphs(text)
  if (paragraphs.length > 0) {
    const long = paragraphs.filter((paragraph) => countChars(paragraph) > 200)
    if (long.length > 0) {
      findings.push({
        code: 'scan/paragraph-long',
        severity: 'info',
        message: `${long.length} 个自然段超过 200 字，手机阅读会成块`,
        evidence: `最长一段 ${Math.max(...long.map((p) => countChars(p)))} 字`,
      })
    }
  }
  return findings
}

/** Whether the last paragraph leaves something open. */
export function scanEnding(text: string): Finding[] {
  const paragraphs = splitParagraphs(text)
  const last = paragraphs[paragraphs.length - 1]
  if (!last) return []
  const tail = last.trim().slice(-12)
  if (/[？?…—]$/.test(tail) || /[！!]$/.test(tail)) return []
  if (tail.endsWith('。')) {
    return [
      {
        code: 'scan/ending-flat',
        severity: 'info',
        message: '章末是陈述句收尾，没有留钩子',
        evidence: `结尾：「${tail}」`,
      },
    ]
  }
  return []
}

/**
 * Run every chapter-level check.
 *
 * @param draft - the chapter under test.
 * @param previous - earlier chapters, used for repetition.
 * @param config - resolved thresholds.
 * @returns findings, most severe first, deduplicated by code.
 */
export function scanChapter(
  draft: ChapterDraft,
  previous: ChapterDraft[],
  config: InkwellConfig,
  options: { proper?: readonly string[] } = {},
): Finding[] {
  const findings = [
    ...scanRepetition(draft, previous, config),
    ...scanOpenings(draft.text, config, options.proper ?? []),
    ...scanRhythm(draft.text, config),
    ...scanTone(draft.text, config),
    ...scanShape(draft.text, config),
    ...scanEnding(draft.text),
  ]

  const seen = new Set<string>()
  return findings
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .filter((finding) => {
      if (seen.has(finding.code)) return false
      seen.add(finding.code)
      return true
    })
}

function severityRank(severity: Finding['severity']): number {
  return severity === 'error' ? 0 : severity === 'warn' ? 1 : 2
}
