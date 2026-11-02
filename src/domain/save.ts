/**
 * The one place a chapter body reaches the disk.
 *
 * `novel_chapter action="write"` and the panel's chapter editor must not be
 * able to disagree: if the tool refuses a body because a required character
 * never appears, the editor has to refuse it too, with the same words. The
 * rules live here and both callers only decorate the result.
 */
import { checkContract, rank } from './contract.ts'
import { discoverOpeners, properNames, scanChapter } from './scan.ts'
import { countChars, splitParagraphs } from './text.ts'
import { adoptClock, type ClockAdoption } from './timeline-edit.ts'
import type { ChapterDraft, Finding, InkwellConfig } from './types.ts'
import type { ProjectStore } from './store.ts'

/** What a caller must supply to save a chapter body. */
export interface ChapterSaveInput {
  number: number
  text: string
  title?: string | undefined
  summary?: string | undefined
  /**
   * The revision the caller was looking at when it edited.
   *
   * Omitted means "write regardless" — the tool prompt and the panel both pass
   * it, so the only callers that leave it out are the ones that deliberately
   * overwrite (a commit of an approved draft, a restore, an explicit force).
   */
  baseRevision?: number | undefined
}

/** One-sentence summary taken from the last paragraph, for later briefings. */
export function deriveSummary(text: string): string {
  const paragraphs = splitParagraphs(text)
  const last = paragraphs[paragraphs.length - 1] ?? ''
  return last.length > 80 ? `${last.slice(0, 80)}…` : last
}

/** A chapter body the outline contract will not accept. */
export class ChapterBlockedError extends Error {
  readonly blockers: Finding[]

  constructor(number: number, blockers: Finding[]) {
    super(`第${number}章未通过章纲合同：${blockers.map((item) => item.code).join('、')}`)
    this.name = 'ChapterBlockedError'
    this.blockers = blockers
  }
}

/**
 * Save a chapter body, enforcing the outline contract.
 *
 * Errors block: a chapter that silently drops a required character would make
 * the outline a decoration. Warnings and infos ride along for the report.
 *
 * @param store - the book to write into.
 * @param config - thresholds for the contract and the deterministic scan.
 * @param input - chapter number and body.
 * @returns the saved draft and everything the checks found.
 * @throws ChapterBlockedError when the contract has errors.
 */
export async function saveChapterBody(
  store: ProjectStore,
  config: InkwellConfig,
  input: ChapterSaveInput,
): Promise<{ draft: ChapterDraft; findings: Finding[]; clock?: ClockAdoption }> {
  const text = input.text.trim()
  if (text === '') throw new Error('正文不能为空。')
  const number = input.number
  const snapshot = await store.snapshot()
  const plan = snapshot.plans.find((item) => item.number === number)
  if (!plan) throw new Error(`第${number}章没有章纲，先写章纲再落笔。`)

  const contract = checkContract(plan, text, config)
  const blocking = contract.filter((finding) => finding.severity === 'error')
  if (blocking.length > 0) throw new ChapterBlockedError(number, blocking)

  const previous = await store.allChapters()
  const draft: ChapterDraft = {
    number,
    title: input.title?.trim() || plan.title,
    words: countChars(text),
    summary: input.summary?.trim() || deriveSummary(text),
    writtenAt: new Date().toISOString(),
    revision: 0,
    text,
  }
  // Names come from the book, not from the text: a chapter that opens with the
  // protagonist's name is an ordinary sentence, not a flat opening.
  const proper = [
    ...properNames({
      characters: await store.characters(),
      places: await store.places(),
      world: await store.world(),
    }),
    ...discoverOpeners(previous),
  ]
  const findings: Finding[] = rank([...contract, ...scanChapter(draft, previous, config, { proper })])
  const meta = await store.writeChapter(draft, { baseRevision: input.baseRevision })
  // The prose has just told the book when it happens; the clock should hear it
  // in the same breath as the save, not on some later sweep that nobody runs.
  const clock = config.autoClock ? await adoptClock(store, number, text) : undefined
  return { draft: { ...draft, ...meta }, findings, ...(clock === undefined ? {} : { clock }) }
}

/**
 * Save a chapter as a draft: contract check, deterministic scan, no commitment.
 *
 * Extracted from the tool because a whole round of the pipeline needs it: the
 * writer hands back prose, and the next thing that must happen is exactly this
 * — keep it as a draft, run the checks, and let the reviewers look. A caller
 * that has to remember the order (scan with these names, rank, save, then
 * dispatch) is a caller that will get it slightly wrong in one of the branches.
 *
 * Nothing here refuses the text. A draft is a candidate, and the reviewers are
 * the ones who judge it; a contract error is recorded on the round so the
 * author can see it, not thrown at the writer.
 *
 * @param store - the book.
 * @param config - resolved configuration.
 * @param input - chapter number, prose, and optional title/summary.
 * @returns the round number, the findings, and their counts.
 */
export async function proposeDraft(
  store: ProjectStore,
  config: InkwellConfig,
  input: { number: number; text: string; title?: string | undefined; summary?: string | undefined },
): Promise<{ round: number; words: number; findings: Finding[]; errors: number; warnings: number }> {
  const plan = (await store.plans()).find((item) => item.number === input.number)
  if (plan === undefined) throw new Error(`第${input.number}章没有章纲。先 novel_outline add_chapter，再派发。`)
  const contract = checkContract(plan, input.text, config)
  const previous = await store.allChapters()
  const round = (await store.draftsOf(input.number)).length + 1
  const words = countChars(input.text)
  const summary = input.summary?.trim() || deriveSummary(input.text)
  const proper = [
    ...properNames({
      characters: await store.characters(),
      places: await store.places(),
      world: await store.world(),
    }),
    ...discoverOpeners(previous),
  ]
  const findings = rank([
    ...contract,
    ...scanChapter(
      { number: input.number, title: input.title?.trim() || plan.title, text: input.text, words, summary, writtenAt: new Date().toISOString() },
      previous,
      config,
      { proper },
    ),
  ])
  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warnings = findings.filter((finding) => finding.severity === 'warn').length
  await store.saveDraft({
    number: input.number,
    round,
    text: input.text,
    words,
    summary,
    autoFindings: findings,
    writtenAt: new Date().toISOString(),
  })
  return { round, words, findings, errors, warnings }
}
