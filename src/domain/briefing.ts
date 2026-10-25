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
  Snapshot,
  StoryPoint,
} from './types.ts'
import { describeWindow, resolveTimeline, windowAt } from './clock.ts'
import { activeEntries } from './ledger.ts'
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
}

function formatCharacter(snapshot: Snapshot, name: string): string {
  const card = snapshot.characters.find((item) => item.name === name)
  if (!card) return `- ${name}（角色卡缺失）`
  const parts = [
    `**${card.name}**（${card.role}）`,
    card.voice ? `说话方式：${card.voice}` : '',
    card.appearance ? `外形：${card.appearance}` : '',
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

  const subjects = new Set(castNames)
  const relevant = activeEntries(snapshot.ledger).filter(
    (entry) => subjects.has(entry.subject) || entry.subject === '世界',
  )
  sections.push({
    name: '已确立事实',
    priority: 5,
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
    priority: 6,
    chars: 0,
    kept: true,
    content: summaries.length > 0
      ? summaries.map((item) => `- 第${item.number}章：${item.summary || '（未写摘要）'}`).join('\n')
      : '（无前情）',
  })

  const pending = activeEntries(snapshot.ledger).filter((entry) => /伏笔|线索|悬念/.test(entry.predicate))
  sections.push({
    name: '待回收线索',
    priority: 7,
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
      continue
    }
    const cut = section.content.slice(0, allowance)
    kept.push({ ...section, kept: true, content: `${cut}\n…（已截断，原文 ${section.chars} 字）`, chars: countChars(cut) })
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
  }
}
