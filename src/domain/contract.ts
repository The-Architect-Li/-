/**
 * Chapter contract coverage.
 *
 * A chapter outline is a promise: these beats, these people, this viewpoint.
 * After drafting, the promise is checked against the prose. Character presence
 * and length are exact; beat coverage is a bigram heuristic and is reported as
 * a warning, never a hard failure, because no deterministic measure can judge
 * whether a beat truly landed.
 */
import type { ChapterPlan, Finding, InkwellConfig } from './types.ts'
import { contentBigrams, countChars } from './text.ts'

/** How much of one beat's content vocabulary appears in the draft. */
export interface BeatCoverage {
  beat: string
  ratio: number
  missing: string[]
}

/** Bigram coverage of every beat, plus the miss list for each. */
export function beatCoverage(beats: string[], text: string): BeatCoverage[] {
  const present = contentBigrams(text)
  return beats.map((beat) => {
    const grams = [...contentBigrams(beat)]
    if (grams.length === 0) return { beat, ratio: 1, missing: [] }
    const missing = grams.filter((gram) => !present.has(gram))
    return { beat, ratio: (grams.length - missing.length) / grams.length, missing: missing.slice(0, 6) }
  })
}

/**
 * Compare a draft against its contract.
 *
 * @param plan - the approved chapter contract.
 * @param text - the drafted prose.
 * @param config - resolved thresholds.
 * @returns findings ordered error, then warn, then info.
 */
export function checkContract(plan: ChapterPlan, text: string, config: InkwellConfig): Finding[] {
  const findings: Finding[] = []

  const absent = plan.characters.filter((name) => name.trim() !== '' && !text.includes(name))
  if (absent.length > 0) {
    findings.push({
      code: 'contract/character-missing',
      severity: 'error',
      message: `章纲要求出场但正文里没出现的角色：${absent.join('、')}`,
      evidence: `第${plan.number}章 characters=[${plan.characters.join('、')}]`,
    })
  }

  const coverage = beatCoverage(plan.beats, text)
  const missed = coverage.filter((item) => item.ratio < config.beatCoverageMin)
  if (missed.length > 0) {
    findings.push({
      code: 'contract/beat-uncovered',
      severity: 'warn',
      message: `${missed.length}/${plan.beats.length} 个必写节拍可能没写到（按词面重合度估算，仅供参考）`,
      evidence: missed
        .map((item) => `「${item.beat}」缺词：${item.missing.join('/') || '—'}`)
        .join('；'),
    })
  }

  const chars = countChars(text)
  if (chars < config.chapterMinWords) {
    findings.push({
      code: 'contract/too-short',
      severity: 'warn',
      message: `本章 ${chars} 字，低于下限 ${config.chapterMinWords} 字`,
      evidence: `目标区间 ${config.chapterMinWords}–${config.chapterMaxWords} 字`,
    })
  } else if (chars > config.chapterMaxWords) {
    findings.push({
      code: 'contract/too-long',
      severity: 'warn',
      message: `本章 ${chars} 字，超出上限 ${config.chapterMaxWords} 字`,
      evidence: `目标区间 ${config.chapterMinWords}–${config.chapterMaxWords} 字`,
    })
  }

  if (plan.pov.trim() !== '' && !text.includes(plan.pov)) {
    findings.push({
      code: 'contract/pov-missing',
      severity: 'warn',
      message: `章纲指定视角人物「${plan.pov}」，正文里没出现这个名字`,
      evidence: '若采用第一人称，请把 pov 写成「我」或明确视角标记',
    })
  }

  const missingHooks = plan.hooks.filter((hook) => hook.trim() !== '' && !text.includes(hook))
  if (plan.hooks.length > 0 && missingHooks.length === plan.hooks.length) {
    findings.push({
      code: 'contract/hook-unclear',
      severity: 'info',
      message: '章末钩子没有按字面出现，确认结尾是否留了悬念',
      evidence: `章纲钩子：${plan.hooks.join('；')}`,
    })
  }

  return rank(findings)
}

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 } as const

/** Stable sort by severity, then original order. */
export function rank(findings: Finding[]): Finding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => {
      const delta = SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity]
      return delta !== 0 ? delta : a.index - b.index
    })
    .map((item) => item.finding)
}
