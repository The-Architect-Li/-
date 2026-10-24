/**
 * The page behind a row.
 *
 * The tree is a table of contents; a reader who clicks 「沈砚」 expects his card,
 * not a highlight. This module turns one row's identity into a page: labelled
 * fields and, where the book has them, lists.
 *
 * The shape is deliberately generic — `fields` plus `lists` — so the browser
 * half stays a dumb renderer. Adding a chapter page instead of a character page
 * changes data here, not layout there.
 *
 * Only what is already in the snapshot is used: no new reads, no prose beyond
 * what the book already stores. The panel is still a window, not an editor.
 */
import type { ChapterDrafts } from './model.ts'
import type { PanelEntryKind } from './tree.ts'
import type { ChapterPlan, DraftRound, Snapshot } from '../domain/types.ts'

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

/** Everything the detail page draws. */
export interface EntryPayload {
  kind: PanelEntryKind
  /** The row's own name, as the tree spells it. */
  title: string
  /** The line under the title: role plus goal, or volume plus point of view. */
  subtitle: string
  /** Right-hand chip, when the thing has a state worth showing. */
  chip?: string
  fields: EntryField[]
  lists: EntryList[]
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
  return {
    kind: 'character',
    title: card.name,
    subtitle: `${ROLE_LABEL[card.role] ?? card.role}${card.goal ? ` · ${card.goal}` : ''}`,
    chip: ROLE_LABEL[card.role] ?? card.role,
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
    fields: [
      { label: '类别', value: entry.kind || '（未分类）' },
      { label: '细节', value: entry.detail || '（还没写）' },
      { label: '最近改动', value: entry.updatedAt },
    ],
    lists:
      facts.length > 0
        ? [{ label: '账本里的事实', items: facts.map((item) => `${item.predicate}＝${item.value}${item.chapter > 0 ? `（第${item.chapter}章）` : '（设定）'}`) }]
        : [],
    root,
  }
}

/**
 * The chapter page: outline, state, and what the last draft was told.
 *
 * @param snapshot - the book.
 * @param key - the chapter number as a string.
 * @param rounds - that chapter's draft rounds.
 * @param root - project directory, for the footer.
 * @returns the page, or `undefined` when neither an outline nor a chapter exists.
 */
function chapterPage(
  snapshot: Snapshot,
  key: string,
  rounds: readonly DraftRound[],
  root: string,
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
  return {
    kind: 'chapter',
    title: `第${number}章 ${plan?.title || chapter?.title || ''}`.trim(),
    subtitle: [volume ? `第${volume.number}卷 ${volume.title}` : '', written ? `${chapter.words} 字` : '还没写']
      .filter((part) => part !== '')
      .join(' · '),
    chip,
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
    ],
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
 * @returns the page, or `undefined` when the thing is gone (a stale tree in the browser).
 */
export function buildEntry(
  snapshot: Snapshot,
  kind: PanelEntryKind,
  key: string,
  drafts: readonly ChapterDrafts[],
  root: string,
): EntryPayload | undefined {
  if (key === '') return undefined
  if (kind === 'character') return characterPage(snapshot, key, root)
  if (kind === 'world') return worldPage(snapshot, key, root)
  const rounds = drafts.find((entry) => entry.number === Number(key))?.rounds ?? []
  return chapterPage(snapshot, key, rounds, root)
}
