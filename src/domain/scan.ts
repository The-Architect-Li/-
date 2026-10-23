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
export function scanOpenings(text: string, config: InkwellConfig): Finding[] {
  const sentences = splitSentences(text)
  const counts = new Map<string, number>()
  for (const sentence of sentences) {
    const opening = sentence.replace(OPENING_STRIP, '').slice(0, 2)
    if (opening.length < 2) continue
    counts.set(opening, (counts.get(opening) ?? 0) + 1)
  }

  const findings: Finding[] = []
  for (const [opening, count] of counts) {
    if (count < config.openingRepeatMin) continue
    findings.push({
      code: 'scan/opening-repeat',
      severity: 'warn',
      message: `有 ${count} 个句子以「${opening}」开头，段落起手太单一`,
      evidence: `阈值：同一开头最多 ${config.openingRepeatMin - 1} 次`,
    })
  }
  return findings
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

  if (density < config.aiToneWarnPer1000) {
    return [
      {
        code: 'scan/tone-ok',
        severity: 'info',
        message: `套路词密度 ${density.toFixed(1)}/千字，在阈值内`,
        evidence: top.join(' '),
      },
    ]
  }
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
): Finding[] {
  const findings = [
    ...scanRepetition(draft, previous, config),
    ...scanOpenings(draft.text, config),
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
