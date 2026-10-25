/**
 * The page behind a row.
 *
 * The tree is a table of contents; a reader who clicks 「沈砚」 expects his card,
 * not a highlight. This module turns one row's identity into a page: labelled
 * fields, and where the book has them, lists — plus the {@link EntryEdit} block
 * that says which of those fields can be typed into.
 *
 * The shape is deliberately generic — `fields`, `lists`, `edit` — so the browser
 * half stays a dumb renderer. Adding a fourth kind of page changes data here,
 * not layout there.
 *
 * Only what is already in the snapshot is used: no new reads, no prose beyond
 * what the book already stores. This module is pure, so the panel's read view and
 * its edit view are always describing the same book.
 */
import type { ChapterDrafts } from './model.ts'
import type { PanelEntryKind } from './tree.ts'
import { CHARACTER_ROLES } from '../domain/types.ts'
import type { ChapterPlan, DraftRound, ReviewRound, Snapshot } from '../domain/types.ts'

/** One labelled line, e.g. `说话方式` → `短句，问句多`. */
export interface EntryField {
  label: string
  value: string
}

/** One labelled block, e.g. `必写节拍` → three lines. */
export interface EntryList {
  label: string
  items: string[]
}

/** One input the page offers when it is in edit mode. */
export interface EntryInput {
  /** Field name in the write API. */
  key: string
  label: string
  value: string
  /** Long text wants a box, not a line. */
  multiline?: boolean
  /** Fixed choices, for a field whose values are an enum. */
  options?: { value: string; label: string }[]
}

/** The editable face of a page. */
export interface EntryEdit {
  inputs: EntryInput[]
  /** The long body, when the thing has one (a chapter's prose). */
  body?: { key: string; label: string; value: string }
  /**
   * The version this page is showing, for things that have versions.
   *
   * A chapter is edited from two places at once in real life — a panel tab and
   * the conversation. Sending this back with the save is what turns "last write
   * wins" into "the second writer is told to reload".
   */
  revision?: number
}

/** Everything the detail page draws. */
export interface EntryPayload {
  kind: PanelEntryKind
  /** The row's own name, as the tree spells it. */
  title: string
  /** The line under the title: role plus goal, or volume plus point of view. */
  subtitle: string
  /** Right-hand chip, when the thing has a state worth showing. */
  chip?: string
  /** Where the page sits, for the second-level header: `人物设计 › 主角`. */
  breadcrumb: string[]
  fields: EntryField[]
  lists: EntryList[]
  /** Inputs this page accepts. Always present: an empty list means read-only. */
  edit: EntryEdit
  /**
   * Why a save would be refused right now, when the host already knows.
   *
   * Filled by the route (which can consult the gate), not by this module: the
   * page still renders its inputs, but the editor can say "先批准章纲" instead of
   * letting the writer type two thousand words into a refusal.
   */
  blocked?: string
  /** Absolute project directory, echoed for the footer. */
  root: string
}

/** How each structural role is named in the cast drawer. */
const ROLE_LABEL: Record<string, string> = {
  protagonist: '主角',
  antagonist: '反派',
  supporting: '配角',
  minor: '路人',
}

/** The four role choices, as a select wants them. */
const ROLE_OPTIONS = CHARACTER_ROLES.map((role) => ({ value: role, label: ROLE_LABEL[role] ?? role }))

/**
 * Chapter state in the studio's words.
 *
 * @param plan - the outline, when one exists.
 * @param written - whether the chapter is committed.
 * @param rounds - draft rounds on disk.
 * @returns a short chip label.
 */
function chapterChip(plan: ChapterPlan | undefined, written: boolean, rounds: readonly DraftRound[]): string {
  if (written) return '已完成'
  if (rounds.length > 0) return `${rounds.length} 稿`
  if (plan?.approved) return '可写'
  return '未写'
}

/**
 * Biggest findings on the newest draft, one line each.
 *
 * @param rounds - draft rounds for the chapter, oldest first.
 * @returns up to five `severity code: message` lines.
 */
function newestFindings(rounds: readonly DraftRound[]): string[] {
  const latest = rounds.at(-1)
  if (latest === undefined) return []
  return latest.autoFindings.slice(0, 5).map((finding) => `${finding.severity === 'error' ? '✗' : finding.severity === 'warn' ? '!' : '·'} ${finding.message}`)
}

/**
 * The character page.
 *
 * The four prose fields and the structural role are editable in the panel; the
 * name is not, because it is the key the route and the store address the card by.
 *
 * @param snapshot - the book.
 * @param name - the card's name, exactly as the tree spells it.
 * @param root - project directory, for the footer.
 * @returns the page, or `undefined` when no such card exists.
 */
function characterPage(snapshot: Snapshot, name: string, root: string): EntryPayload | undefined {
  const card = snapshot.characters.find((entry) => entry.name === name)
  if (card === undefined) return undefined
  const appearances = snapshot.plans
    .filter((plan) => plan.characters.includes(name))
    .map((plan) => `第${plan.number}章 ${plan.title}`.trim())
  const facts = snapshot.ledger.filter((entry) => entry.subject === name && entry.supersedes === null)
  const roleLabel = ROLE_LABEL[card.role] ?? card.role
  return {
    kind: 'character',
    title: card.name,
    subtitle: `${roleLabel}${card.goal ? ` · ${card.goal}` : ''}`,
    chip: roleLabel,
    breadcrumb: ['人物设计', roleLabel],
    fields: [
      { label: '说话方式', value: card.voice || '（还没写）' },
      { label: '外貌', value: card.appearance || '（还没写）' },
      { label: '目标', value: card.goal || '（还没写）' },
      { label: '秘密', value: card.secret || '（还没写）' },
      { label: '最近改动', value: card.updatedAt },
    ],
    lists: [
      ...(appearances.length > 0 ? [{ label: '出场章节', items: appearances }] : []),
      ...(facts.length > 0
        ? [{ label: '账本里的事实', items: facts.map((entry) => `${entry.predicate}＝${entry.value}${entry.chapter > 0 ? `（第${entry.chapter}章）` : '（设定）'}`) }]
        : []),
    ],
    edit: {
      inputs: [
        { key: 'role', label: '角色位置', value: card.role, options: ROLE_OPTIONS },
        { key: 'voice', label: '说话方式', value: card.voice, multiline: true },
        { key: 'appearance', label: '外貌', value: card.appearance, multiline: true },
        { key: 'goal', label: '目标', value: card.goal },
        { key: 'secret', label: '秘密', value: card.secret, multiline: true },
      ],
    },
    root,
  }
}

/**
 * The world-entry page.
 *
 * @param snapshot - the book.
 * @param name - the entry's name.
 * @param root - project directory, for the footer.
 * @returns the page, or `undefined` when no such entry exists.
 */
function worldPage(snapshot: Snapshot, name: string, root: string): EntryPayload | undefined {
  const entry = snapshot.world.find((item) => item.name === name)
  if (entry === undefined) return undefined
  const facts = snapshot.ledger.filter((item) => item.subject === name && item.supersedes === null)
  return {
    kind: 'world',
    title: entry.name,
    subtitle: entry.kind || '设定',
    chip: entry.kind || undefined,
    breadcrumb: ['世界观', entry.kind || '设定'],
    fields: [
      { label: '类别', value: entry.kind || '（未分类）' },
      { label: '细节', value: entry.detail || '（还没写）' },
      { label: '最近改动', value: entry.updatedAt },
    ],
    lists:
      facts.length > 0
        ? [{ label: '账本里的事实', items: facts.map((item) => `${item.predicate}＝${item.value}${item.chapter > 0 ? `（第${item.chapter}章）` : '（设定）'}`) }]
        : [],
    edit: {
      inputs: [
        { key: 'kind', label: '类别', value: entry.kind },
        { key: 'detail', label: '细节', value: entry.detail, multiline: true },
      ],
    },
    root,
  }
}

/**
 * The chapter page: outline, state, the prose itself, and what the last draft
 * was told.
 *
 * The prose is the page's main body — a chapter page without the chapter in it
 * would be a spec sheet for something the reader cannot see.
 *
 * @param snapshot - the book.
 * @param key - the chapter number as a string.
 * @param rounds - that chapter's draft rounds.
 * @param root - project directory, for the footer.
 * @param body - the committed prose, when there is any.
 * @returns the page, or `undefined` when neither an outline nor a chapter exists.
 */
function chapterPage(
  snapshot: Snapshot,
  key: string,
  rounds: readonly DraftRound[],
  root: string,
  body: string | undefined,
  reviews: readonly ReviewRound[] = [],
): EntryPayload | undefined {
  const number = Number(key)
  if (!Number.isInteger(number) || number <= 0) return undefined
  const plan = snapshot.plans.find((entry) => entry.number === number)
  const chapter = snapshot.chapters.find((entry) => entry.number === number)
  if (plan === undefined && chapter === undefined) return undefined
  const volume = plan === undefined ? undefined : snapshot.volumes.find((entry) => entry.number === plan.volume)
  const written = chapter !== undefined
  const chip = chapterChip(plan, written, rounds)
  const findings = newestFindings(rounds)
  // Reviewer notes are permanent now, so the page shows the ones nobody has
  // answered yet. The rest stay in `reviews/` and in `novel_chapter review`.
  const openItems = reviews.flatMap((round) => round.items).filter((item) => item.state === 'open')
  const totalItems = reviews.reduce((sum, round) => sum + round.items.length, 0)
  // Once a chapter exists its own title wins: the outline names the chapter in
  // advance, but the thing you wrote is what you renamed. Before that, the
  // outline is the only name there is.
  const title = chapter?.title || plan?.title || ''
  return {
    kind: 'chapter',
    title: `第${number}章 ${title}`.trim(),
    subtitle: [volume ? `第${volume.number}卷 ${volume.title}` : '', written ? `${chapter.words} 字` : '还没写']
      .filter((part) => part !== '')
      .join(' · '),
    chip,
    breadcrumb: ['正文', volume ? `第${volume.number}卷` : '未分卷'],
    fields: [
      { label: '状态', value: chip },
      { label: '分卷', value: volume ? `第${volume.number}卷 ${volume.title}` : '（未分卷）' },
      { label: '视点', value: plan?.pov || '（未定）' },
      { label: '章纲', value: plan === undefined ? '（没有章纲）' : plan.approved ? '已批准' : '待批准' },
      { label: '字数', value: written ? `${chapter.words} 字` : rounds.length > 0 ? `${rounds.at(-1)?.words ?? 0} 字（草稿）` : '0 字' },
    ],
    lists: [
      ...(plan?.characters.length ? [{ label: '出场人物', items: plan.characters }] : []),
      ...(plan?.beats.length ? [{ label: '必写节拍', items: plan.beats }] : []),
      ...(plan?.hooks.length ? [{ label: '章末钩子', items: plan.hooks }] : []),
      ...(findings.length > 0 ? [{ label: '最新一稿的自动发现', items: findings }] : []),
      ...(totalItems > 0
        ? [{ label: `审稿（${openItems.length}/${totalItems} 条未结）`, items: openItems.slice(0, 6).map((item) => `[${item.severity}] ${item.message}　${item.id}`) }]
        : []),
    ],
    edit: {
      inputs: [{ key: 'title', label: '标题', value: title }],
      body: { key: 'text', label: '正文', value: body ?? '' },
      ...(chapter === undefined ? {} : { revision: chapter.revision }),
    },
    root,
  }
}

/**
 * Build the page for one row.
 *
 * @param snapshot - the book.
 * @param kind - which sort of thing the row stands for.
 * @param key - its identity: a name, or a chapter number as a string.
 * @param drafts - draft rounds per chapter, as the route already read them.
 * @param root - project directory, for the footer.
 * @param body - the committed prose, for a chapter page.
 * @returns the page, or `undefined` when the thing is gone (a stale tree in the browser).
 */
export function buildEntry(
  snapshot: Snapshot,
  kind: PanelEntryKind,
  key: string,
  drafts: readonly ChapterDrafts[],
  root: string,
  body?: string | undefined,
  reviews: readonly ReviewRound[] = [],
): EntryPayload | undefined {
  if (key === '') return undefined
  if (kind === 'character') return characterPage(snapshot, key, root)
  if (kind === 'world') return worldPage(snapshot, key, root)
  const rounds = drafts.find((entry) => entry.number === Number(key))?.rounds ?? []
  return chapterPage(snapshot, key, rounds, root, body, reviews)
}
