/**
 * On-demand context packaging.
 *
 * The failure mode this prevents is not "too little context" but "all of it":
 * a 40-chapter project cannot be pasted in, and a naive summary loses the exact
 * details that contradict later. So the pack is assembled by priority inside a
 * fixed character budget, and it reports what it dropped.
 */
import type {
  ChapterDraft,
  ChapterPlan,
  InkwellConfig,
  PlaceCard,
  Snapshot,
  StoryPoint,
} from './types.ts'
import { currentStage } from './characters.ts'
import { describeWindow, resolveTimeline, windowAt } from './clock.ts'
import { activeEntries } from './ledger.ts'
import { describeRelation, relationsOf } from './relations.ts'
import { countChars, tailOf } from './text.ts'

/** One candidate block of the pack. */
export interface BriefingSection {
  name: string
  /** Lower runs first and survives truncation longer. */
  priority: number
  chars: number
  kept: boolean
  content: string
}

/** The assembled pack plus bookkeeping about what survived. */
export interface BriefingResult {
  markdown: string
  sections: BriefingSection[]
  totalChars: number
  budgetChars: number
  /**
   * Plain sentences about rules that did not make it in.
   *
   * A section that gets squeezed out used to disappear without a word, and the
   * author went on believing the style rule applied. Silence is the one answer
   * this must never give.
   */
  warnings: string[]
}

function formatCharacter(snapshot: Snapshot, name: string): string {
  const card = snapshot.characters.find((item) => item.name === name)
  if (!card) return `- ${name}（角色卡缺失）`
  const stage = currentStage(card)
  const parts = [
    `**${card.name}**（${card.role}）`,
    card.voice ? `说话方式：${card.voice}` : '',
    card.appearance ? `外形：${card.appearance}` : '',
    card.personality ? `现在：${card.personality}` : '',
    stage === undefined ? '' : `转折：第${stage.chapter}章${stage.cause ?? ''}`,
    card.goal ? `目标：${card.goal}` : '',
    card.secret ? `隐秘：${card.secret}` : '',
  ].filter(Boolean)
  return `- ${parts.join('｜')}`
}

/**
 * The chapter's place on the book's clock, plus the story point it belongs to.
 *
 * Reviewers keep asking "is this the right month"; answering that needs the date
 * computed from what earlier chapters said, not a date invented here.
 *
 * @param snapshot - project state.
 * @param chapter - the chapter about to be written.
 * @param drafts - every chapter already written.
 * @returns the section body.
 */
function formatClock(snapshot: Snapshot, chapter: number, drafts: ChapterDraft[]): string {
  const highest = Math.max(chapter, drafts.length, ...snapshot.chapters.map((item) => item.number), 1)
  const resolution = resolveTimeline(snapshot.timeline, highest)
  const window = windowAt(resolution, chapter)
  const point = snapshot.storyPoints
    .filter((item) => item.startChapter <= chapter && (item.endChapter === null || chapter <= item.endChapter))
    .sort((a, b) => b.startChapter - a.startChapter)[0] as StoryPoint | undefined
  const covering = snapshot.timeline.spans.filter((span) => span.toChapter === chapter)
  const lines = [
    point
      ? `所属故事点：${point.name}${point.closed ? '（已收尾）' : ''}　${point.premise}`
      : '所属故事点：（还没有故事点，这一段故事没有名字，审核时无从判断跑没跑题）',
    window
      ? `本章故事时间：${describeWindow(window)}`
      : '本章故事时间：（全书还没有日期锚点。正文里第一次写明时间时，用 novel_timeline anchor 记一条）',
  ]
  for (const span of covering) {
    lines.push(
      `时间跨度：第${span.fromChapter}章到本章过去了 ${span.days.min === span.days.max ? `${span.days.min}` : `${span.days.min}–${span.days.max}`} 天（原文「${span.text}」）`,
    )
  }
  if (window) {
    lines.push('正文里写死的日期要落在这个窗口内；「这几个月」不要写成「这几年」。')
  }
  return lines.join('\n')
}

/**
 * The relationship graph, from the point of view of whoever is in this chapter.
 *
 * A writer who knows 沈砚 is in the scene but not that 阿蘅 is his creditor will
 * write two strangers meeting. The edges are already in `canon/relations.json`;
 * this section is the part that decides which of them belong in this chapter.
 *
 * @param snapshot - project state.
 * @param castNames - who is in this chapter.
 * @returns the section body.
 */
function formatRelations(snapshot: Snapshot, castNames: readonly string[]): string {
  const lines: string[] = []
  for (const name of castNames) {
    const seen = relationsOf(snapshot.relations, snapshot.characters, name)
    if (seen.length === 0) continue
    const onStage = seen.filter((relation) => castNames.includes(relation.other))
    const offStage = seen.filter((relation) => !castNames.includes(relation.other))
    lines.push(`- **${name}**`)
    // Who is in the room first: those are the relations the scene will press on.
    for (const relation of onStage) lines.push(`  - 与 ${describeRelation(relation)}　（本章在场）`)
    for (const relation of offStage.slice(0, 3)) lines.push(`  - 与 ${describeRelation(relation)}`)
    if (lines.length >= 14) break
  }
  if (lines.length === 0) {
    return '（关系表里没有这几个人。人物之间的亲疏要用 novel_canon upsert_character 的 relations 写进去，两页都能改）'
  }
  return lines.slice(0, 14).join('\n')
}

/** Which places the chapter plan names, in the order the plan names them. */
function placesInPlan(snapshot: Snapshot, plan: ChapterPlan | undefined): PlaceCard[] {
  if (!plan) return []
  const haystack = [plan.title, plan.scene ?? '', plan.summary ?? '', ...plan.beats, ...plan.hooks].join(' ')
  return snapshot.places.filter((place) =>
    [place.name, ...place.aliases].some((name) => name !== '' && haystack.includes(name)),
  )
}

/**
 * What the places this chapter uses look like *by now*.
 *
 * A place is a history, not a description: the dock in chapter 3 and the dock in
 * chapter 80 are the same card with a newer state. Handing the writer the last
 * state as of this chapter is the whole point of storing states.
 *
 * @param snapshot - project state.
 * @param plan - this chapter's outline.
 * @param chapter - the chapter about to be written.
 * @returns the section body.
 */
function formatPlaces(snapshot: Snapshot, plan: ChapterPlan | undefined, chapter: number): string {
  const mentioned = placesInPlan(snapshot, plan)
  const recent = snapshot.places
    .filter((place) => !mentioned.includes(place) && place.latestChapter <= chapter && place.latestChapter >= chapter - 10)
    .sort((a, b) => b.latestChapter - a.latestChapter)
  const chosen = [...mentioned, ...recent.slice(0, 3)]
  if (chosen.length === 0) {
    return '（章纲没有点名地点。写到确定的场所时，用 novel_canon upsert_place 记一条，下一次它就会出现在这里）'
  }
  return chosen
    .map((place) => {
      const state = place.states
        .filter((item) => item.chapter <= chapter)
        .sort((a, b) => a.chapter - b.chapter)
        .at(-1)
      const detail = state?.detail ?? place.detail
      const when = state === undefined ? '' : `第${state.chapter}章时：`
      const later = mentioned.includes(place) ? '' : `（最近出现于第${place.latestChapter}章）`
      return `- **${place.name}**（${place.kind}）${when}${detail}${later}`
    })
    .join('\n')
}

function collectSections(
  snapshot: Snapshot,
  drafts: ChapterDraft[],
  chapter: number,
  config: InkwellConfig,
): BriefingSection[] {
  const plan: ChapterPlan | undefined = snapshot.plans.find((item) => item.number === chapter)
  const previous = drafts.filter((item) => item.number < chapter).sort((a, b) => b.number - a.number)
  const last = previous[0]
  const castNames = plan && plan.characters.length > 0
    ? plan.characters
    : snapshot.characters.filter((item) => item.role === 'protagonist').map((item) => item.name)

  const sections: BriefingSection[] = []

  sections.push({
    name: '本章合同',
    priority: 1,
    chars: 0,
    kept: true,
    content: plan
      ? [
          `第${plan.number}章《${plan.title}》　视角：${plan.pov || '未定'}`,
          `必写节拍：`,
          ...plan.beats.map((beat, index) => `  ${index + 1}. ${beat}`),
          plan.hooks.length > 0 ? `章末钩子：${plan.hooks.join('；')}` : '',
        ].filter(Boolean).join('\n')
      : `第${chapter}章还没有章纲。先写章纲，否则这一章没有可验证的目标。`,
  })

  sections.push({
    name: '本章时间与故事点',
    priority: 2,
    chars: 0,
    kept: true,
    content: formatClock(snapshot, chapter, drafts),
  })

  sections.push({
    name: '出场角色',
    priority: 3,
    chars: 0,
    kept: true,
    content: castNames.length > 0
      ? castNames.map((name) => formatCharacter(snapshot, name)).join('\n')
      : '（还没有角色卡，先补齐再动笔）',
  })

  sections.push({
    name: '上一章结尾',
    priority: 4,
    chars: 0,
    kept: true,
    content: last ? `第${last.number}章《${last.title}》结尾：\n${tailOf(last.text, config.briefingTailChars)}` : '（这是第一章）',
  })

  sections.push({
    name: '人物关系',
    priority: 5,
    chars: 0,
    kept: true,
    content: formatRelations(snapshot, castNames),
  })

  sections.push({
    name: '本章地点',
    priority: 6,
    chars: 0,
    kept: true,
    content: formatPlaces(snapshot, plan, chapter),
  })

  const subjects = new Set(castNames)
  const relevant = activeEntries(snapshot.ledger).filter(
    (entry) => subjects.has(entry.subject) || entry.subject === '世界',
  )
  sections.push({
    name: '已确立事实',
    priority: 7,
    chars: 0,
    kept: true,
    content: relevant.length > 0
      ? relevant
          .map((entry) => `- ${entry.subject}·${entry.predicate}＝${entry.value}${entry.quote ? `（原文：「${entry.quote}」）` : ''}`)
          .join('\n')
      : '（账本为空。写到确定的设定时，用 novel_ledger 记下来）',
  })

  const summaries = previous.slice(0, config.briefingLookback).sort((a, b) => a.number - b.number)
  sections.push({
    name: '前情摘要',
    priority: 8,
    chars: 0,
    kept: true,
    content: summaries.length > 0
      ? summaries.map((item) => `- 第${item.number}章：${item.summary || '（未写摘要）'}`).join('\n')
      : '（无前情）',
  })

  const pending = activeEntries(snapshot.ledger).filter((entry) => /伏笔|线索|悬念/.test(entry.predicate))
  sections.push({
    name: '待回收线索',
    priority: 9,
    chars: 0,
    kept: true,
    content: pending.length > 0
      ? pending.map((entry) => `- ${entry.id}｜${entry.subject}·${entry.predicate}＝${entry.value}`).join('\n')
      : '（账本里没有标记为伏笔/线索的条目）',
  })

  return sections.map((section) => ({ ...section, chars: countChars(section.content) }))
}

/**
 * Assemble the writing pack for one chapter.
 *
 * @param snapshot - project state.
 * @param drafts - every chapter already written.
 * @param chapter - the chapter about to be written.
 * @param config - budget and depth knobs.
 * @returns the markdown pack, section bookkeeping, and the amount dropped.
 */
export function buildBriefing(
  snapshot: Snapshot,
  drafts: ChapterDraft[],
  chapter: number,
  config: InkwellConfig,
): BriefingResult {
  const candidates = collectSections(snapshot, drafts, chapter, config).sort(
    (a, b) => a.priority - b.priority,
  )

  let remaining = config.briefingBudgetChars
  const kept: BriefingSection[] = []
  /** What did not fit, in the sections' own words. */
  const warnings: string[] = []
  for (const section of candidates) {
    if (section.chars <= remaining) {
      kept.push({ ...section, kept: true })
      remaining -= section.chars
      continue
    }
    // Priority 1 and 2 are non-negotiable: the contract and the cast are the
    // reason the pack exists. Everything else degrades to a truncation or a drop.
    const floor = section.priority <= 2 ? Math.floor(config.briefingBudgetChars / 4) : 0
    const allowance = Math.max(remaining, floor)
    if (allowance < 120) {
      kept.push({ ...section, kept: false, content: '' })
      warnings.push(`「${section.name}」没有装进这一章的包（预算不够）。`)
      continue
    }
    const cut = section.content.slice(0, allowance)
    kept.push({ ...section, kept: true, content: `${cut}\n…（已截断，原文 ${section.chars} 字）`, chars: countChars(cut) })
    warnings.push(`「${section.name}」被截断：只装进前 ${allowance} 字，原文 ${section.chars} 字。`)
    remaining = Math.max(0, remaining - allowance)
  }

  const markdown = kept
    .filter((section) => section.kept && section.content !== '')
    .map((section) => `### ${section.name}\n${section.content}`)
    .join('\n\n')

  return {
    markdown,
    sections: kept,
    totalChars: kept.reduce((sum, section) => sum + section.chars, 0),
    budgetChars: config.briefingBudgetChars,
    warnings,
  }
}
