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
import { presentInText } from '../domain/cards.ts'
import { cardIsStale } from '../domain/review-window.ts'
import { answersTo } from '../domain/characters.ts'
import { describeRelation, relationsOf, sameName } from '../domain/relations.ts'
import { describeWindow, resolveTimeline, windowAt } from '../domain/clock.ts'
import { buildSpine, whenLabel } from '../domain/spine.ts'
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
  /**
   * Chapters that can be given a date at once, and the dates they already have.
   *
   * The timeline page is the one page whose edit is not a field: dating eighty
   * chapters one box at a time is why the clock stayed empty. The client draws a
   * checklist from this and posts the picked numbers with one date.
   */
  clock?: { chapters: number[]; dated: Record<string, string> }
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

/** One bubble hanging off the time rail. */
export interface EntrySpineEvent {
  /** Chapter the bubble belongs to. */
  chapter: number
  kind: 'anchor' | 'chapter'
  /** `2021-03`, as the rail writes dates. */
  when: string
  /** `第12章 换地方`. */
  label: string
  /** One line of what happened; may be empty. */
  text: string
  /** The anchor's own words, when the chapter was also dated on purpose. */
  note?: string
}

/** One point on the rail, with the bubbles that fall between it and the next. */
export interface EntrySpinePoint {
  /** `2020-10`. */
  when: string
  kind: 'start' | 'year'
  events: EntrySpineEvent[]
}

/**
 * The clock drawn as a rail: points every twelve months, events between them.
 *
 * A timeline file can be perfectly consistent and still unreadable — ninety
 * anchors do not show the shape of the story's time. This is that shape, and it
 * is derived on every read, so it cannot disagree with the anchors behind it.
 */
export interface EntrySpine {
  report: string
  points: EntrySpinePoint[]
  /** Chapters with no date yet: they exist, the clock has not reached them. */
  loose: EntrySpineEvent[]
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
  /** The rail, on the timeline page only. */
  spine?: EntrySpine
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
  const aliases = (card.aliases ?? []).filter((alias) => alias.trim() !== '')
  // A recorded turn carries a chapter and a cause; the panel says both, so the
  // page reads as a life rather than a list of moods. Older stages keep the
  // 阶段：发生了什么 shape they were imported with.
  const stages = (card.stages ?? []).map((stage) => {
    const head = stage.label === '' ? stage.text : `${stage.label}：${stage.text}`
    return stage.chapter === undefined ? head : `第${stage.chapter}章起 — ${head}`
  })
  const relations = relationsOf(snapshot.relations, snapshot.characters, name)
  const known = (other: string): boolean =>
    snapshot.characters.some((entry) => sameName(entry.name, other) || (entry.aliases ?? []).some((alias) => sameName(alias, other)))
  return {
    kind: 'character',
    title: card.name,
    subtitle: `${roleLabel}${card.status ? ` · ${card.status}` : card.goal ? ` · ${card.goal}` : ''}`,
    chip: roleLabel,
    breadcrumb: ['人物设计', roleLabel],
    fields: [
      ...(aliases.length > 0 ? [{ label: '别称', value: aliases.join('、') }] : []),
      { label: '性格', value: card.personality || '（还没写）' },
      { label: '外貌', value: card.appearance || '（还没写）' },
      { label: '说话方式', value: card.voice || '（还没写）' },
      { label: '目标', value: card.goal || '（还没写）' },
      { label: '秘密', value: card.secret || '（还没写）' },
      { label: '当前状态', value: card.status || '（还没写）' },
      // Material the importer could not map onto a field of its own.
      // Hidden when empty so a hand-written card looks unchanged.
      ...(card.notes ? [{ label: '其他材料', value: card.notes }] : []),
      { label: '最近改动', value: card.updatedAt },
    ],
    lists: [
      ...(stages.length > 0 ? [{ label: '经历的阶段', items: stages }] : []),
      // One list, both directions: since v0.21 a relation is one edge, so a line
      // written on the other person's page is the same record and is editable here.
      ...(relations.length > 0
        ? [
            {
              label: '关系',
              items: relations.map((relation) =>
                known(relation.other)
                  ? describeRelation(relation)
                  : `${describeRelation(relation)}（角色卡里还没有这个人）`,
              ),
            },
          ]
        : []),
      ...(appearances.length > 0 ? [{ label: '出场章节', items: appearances }] : []),
      ...(facts.length > 0
        ? [{ label: '账本里的事实', items: facts.map((entry) => `${entry.predicate}＝${entry.value}${entry.chapter > 0 ? `（第${entry.chapter}章）` : '（设定）'}`) }]
        : []),
    ],
    edit: {
      inputs: [
        { key: 'role', label: '角色位置', value: card.role, options: ROLE_OPTIONS },
        { key: 'aliases', label: '别称（用、分隔）', value: aliases.join('、') },
        { key: 'personality', label: '性格', value: card.personality ?? '', multiline: true },
        { key: 'appearance', label: '外貌', value: card.appearance, multiline: true },
        { key: 'voice', label: '说话方式', value: card.voice, multiline: true },
        { key: 'goal', label: '目标', value: card.goal },
        { key: 'secret', label: '秘密', value: card.secret, multiline: true },
        { key: 'status', label: '当前状态', value: card.status ?? '', multiline: true },
        { key: 'stages', label: '经历的阶段（一行一段：阶段：发生了什么）', value: stages.join('\n'), multiline: true },
        { key: 'relations', label: '关系（一行一条：对方：关系）', value: relations.map((relation) => `${relation.other}：${relation.kind}`).join('\n'), multiline: true },
        { key: 'notes', label: '其他材料', value: card.notes ?? '', multiline: true },
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
 * Every relation in the book, once, as one page.
 *
 * v0.19 could only answer this per card, which meant the shape of the web — who
 * is central, who is only ever reached through somebody else — was invisible.
 * Since v0.21 a relation is an edge, so the whole table is one list.
 *
 * @param snapshot - the book.
 * @param root - project directory, for the footer.
 * @returns the page.
 */
function relationsPage(snapshot: Snapshot, root: string): EntryPayload {
  const edges = snapshot.relations.edges
  const known = (name: string): boolean =>
    snapshot.characters.some((card) => answersTo(card, name))
  const line = (edge: (typeof edges)[number]): string => {
    const head = edge.symmetric
      ? `${edge.from} —— ${edge.kind} —— ${edge.to}`
      : `${edge.from} —— ${edge.kind} → ${edge.to}`
    const tail = [
      ...(edge.reverse === undefined ? [] : [`反过来：${edge.reverse}`]),
      ...(edge.note === undefined ? [] : [edge.note]),
      ...(edge.since === undefined ? [] : [`第${edge.since}章起`]),
    ]
    const missing = [edge.from, edge.to].filter((name) => !known(name))
    const warn = missing.length === 0 ? '' : `（角色卡里还没有：${missing.join('、')}）`
    return `${head}${tail.length === 0 ? '' : ` · ${tail.join(' · ')}`}${warn}`
  }
  const asymmetric = edges.filter((edge) => !edge.symmetric)
  const symmetric = edges.filter((edge) => edge.symmetric)
  const touched = new Set(edges.flatMap((edge) => [edge.from, edge.to]))
  const lonely = snapshot.characters.filter((card) => !touched.has(card.name)).map((card) => card.name)
  return {
    kind: 'relations',
    title: '关系一览',
    subtitle: `${edges.length} 条关系 · ${touched.size} 人`,
    chip: '关系',
    breadcrumb: ['人物设计', '关系一览'],
    fields: [
      { label: '怎么改', value: '在任何一个人的页面上改「关系」那一栏即可：一条关系只存一份，从哪一头改都是同一条记录。' },
      ...(lonely.length > 0 ? [{ label: '还没有任何关系的人', value: lonely.join('、') }] : []),
    ],
    lists: [
      ...(symmetric.length > 0
        ? [{ label: '双向（同一个词两边都通）', items: symmetric.map(line) }]
        : []),
      ...(asymmetric.length > 0 ? [{ label: '单向（反过来另有说法）', items: asymmetric.map(line) }] : []),
      ...(edges.length === 0
        ? [{ label: '还没有关系', items: ['在角色页的「关系」里写「对方：关系」，例如「刘紫灵：母亲」。'] }]
        : []),
    ],
    edit: { inputs: [] },
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
  // A promised character who never walks on, and a walk-on nobody planned, are
  // different facts; the card keeps the promise and this keeps the page.
  const named = presentInText(body ?? '', snapshot.characters.map((item) => item.name))
  // A card describes a body. Editing the body does not edit the card, so the
  // page has to say when the two have come apart — otherwise the recap reads
  // authoritative while describing text that no longer exists.
  const stale = cardIsStale(plan, chapter)
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
      { label: '场景', value: plan?.scene || '（未写）' },
      { label: '章纲', value: plan === undefined ? '（没有章纲）' : plan.approved ? '已批准' : '待批准' },
      { label: '字数', value: written ? `${chapter.words} 字` : rounds.length > 0 ? `${rounds.at(-1)?.words ?? 0} 字（草稿）` : '0 字' },
      ...(stale
        ? [{ label: '章卡', value: `过期：卡写在第 ${plan?.cardRevision ?? 1} 版，正文现在是第 ${chapter?.revision ?? 1} 版。下面这四栏（故事梗概/关键事件/场景）说的是改之前的正文，重新保存一次就盖成当前版本。` }]
        : []),
      ...(plan?.summary ? [{ label: '故事梗概', value: plan.summary }] : []),
    ],
    lists: [
      ...(plan?.events?.length ? [{ label: '关键事件', items: plan.events }] : []),
      ...(plan?.characters.length ? [{ label: '出场人物（章纲）', items: plan.characters }] : []),
      ...(named.length > 0 ? [{ label: '正文里出现了', items: named }] : []),
      ...(plan?.beats.length ? [{ label: '必写节拍', items: plan.beats }] : []),
      ...(plan?.hooks.length ? [{ label: '章末钩子', items: plan.hooks }] : []),
      ...(findings.length > 0 ? [{ label: '最新一稿的自动发现', items: findings }] : []),
      ...(totalItems > 0
        ? [{ label: `审稿（${openItems.length}/${totalItems} 条未结）`, items: openItems.slice(0, 6).map((item) => `[${item.severity}] ${item.message}　${item.id}`) }]
        : []),
    ],
    edit: {
      inputs: [
        { key: 'title', label: '标题', value: title },
        { key: 'scene', label: '场景', value: plan?.scene ?? '' },
        { key: 'story', label: '故事梗概', value: plan?.summary ?? '', multiline: true },
        { key: 'events', label: '关键事件（一行一件）', value: (plan?.events ?? []).join('\n'), multiline: true },
      ],
      body: { key: 'text', label: '正文', value: body ?? '' },
      ...(chapter === undefined ? {} : { revision: chapter.revision }),
    },
    root,
  }
}

/**
 * The place page: what the corner of the world looks like *now*, and what it
 * looked like in earlier chapters.
 *
 * `states` is why this page exists. A courtyard in chapter 1 and a flat there in
 * chapter 100 are the same address; a place card that only holds one description
 * silently overwrites the first one, and later chapters "remember" the flat.
 *
 * @param snapshot - the book.
 * @param name - the place's name.
 * @param root - project directory, for the footer.
 * @returns the page, or `undefined` when no such place exists.
 */
function placePage(snapshot: Snapshot, name: string, root: string): EntryPayload | undefined {
  const place = snapshot.places.find((item) => item.name === name)
  if (place === undefined) return undefined
  const facts = snapshot.ledger.filter((item) => item.subject === name && item.supersedes === null)
  const states = place.states.slice().sort((a, b) => a.chapter - b.chapter)
  // `detail` is meant to be the newest description, but a card can arrive from
  // an import with only states filled in — the newest state wins when it exists,
  // so the page never shows chapter 1 while claiming to show "now".
  const current = states.at(-1)?.detail || place.detail
  return {
    kind: 'place',
    title: place.name,
    subtitle: place.kind ? `${place.kind} · 第${place.firstChapter}章起` : `第${place.firstChapter}章起`,
    chip: states.length > 1 ? `${states.length} 次变化` : undefined,
    breadcrumb: ['剧情设计', '地点'],
    fields: [
      { label: '类别', value: place.kind || '（未分类）' },
      { label: '别名', value: place.aliases.length > 0 ? place.aliases.join('、') : '（无）' },
      { label: '首次出现', value: `第${place.firstChapter}章` },
      { label: '最近出现', value: `第${place.latestChapter}章` },
      { label: '现在的样子', value: current || '（还没写）' },
      ...(place.notes ? [{ label: '备注', value: place.notes }] : []),
    ],
    lists: [
      ...(states.length > 0
        ? [{ label: '样子变过几次', items: states.map((state) => `第${state.chapter}章：${state.detail}${state.note ? `（${state.note}）` : ''}`) }]
        : []),
      ...(facts.length > 0
        ? [{ label: '账本里的事实', items: facts.map((item) => `${item.predicate}＝${item.value}${item.chapter > 0 ? `（第${item.chapter}章）` : '（设定）'}`) }]
        : []),
    ],
    edit: {
      inputs: [
        { key: 'detail', label: '现在的样子', value: place.detail, multiline: true },
        { key: 'notes', label: '备注', value: place.notes ?? '', multiline: true },
      ],
    },
    root,
  }
}

/**
 * The story-point page: one stretch of the book that is *about* one thing.
 *
 * @param snapshot - the book.
 * @param id - the story point's id (`sp-001`).
 * @param root - project directory, for the footer.
 * @returns the page, or `undefined` when no such point exists.
 */
function storyPage(snapshot: Snapshot, id: string, root: string): EntryPayload | undefined {
  const point = snapshot.storyPoints.find((item) => item.id === id)
  if (point === undefined) return undefined
  const covered = snapshot.plans
    .filter((plan) => plan.number >= point.startChapter && (point.endChapter === null || plan.number <= point.endChapter))
    .sort((a, b) => a.number - b.number)
  const span = point.endChapter === null ? `第${point.startChapter}章起` : `第${point.startChapter}–${point.endChapter}章`
  return {
    kind: 'story',
    title: point.name,
    subtitle: `${span} · ${point.characters.length} 人`,
    chip: point.closed ? '已收尾' : '进行中',
    breadcrumb: ['剧情设计', '故事点'],
    fields: [
      { label: '范围', value: span },
      { label: '状态', value: point.closed ? '已经收尾，后面不属于这里' : '还在进行，新的一章默认归到这里' },
      { label: '这段讲什么', value: point.premise || '（还没写）' },
      { label: '主要人物', value: point.characters.length > 0 ? point.characters.join('、') : '（未指定）' },
      { label: '建立于', value: point.createdAt },
      ...(point.notes ? [{ label: '备注', value: point.notes }] : []),
    ],
    lists: [
      ...(covered.length > 0
        ? [{ label: `覆盖 ${covered.length} 张章卡`, items: covered.slice(0, 12).map((plan) => `第${plan.number}章 ${plan.title}`.trim()) }]
        : []),
    ],
    edit: {
      inputs: [
        { key: 'premise', label: '这段讲什么', value: point.premise, multiline: true },
        { key: 'notes', label: '备注', value: point.notes ?? '', multiline: true },
      ],
    },
    root,
  }
}

/**
 * The timeline page: the book's clock, chapter by chapter.
 *
 * Read-only on purpose. A date is a fact about the prose, so it is written by
 * `novel_timeline` where the sentence that asserted it can be kept as evidence;
 * a date typed into a panel has no sentence behind it.
 *
 * @param snapshot - the book.
 * @param root - project directory, for the footer.
 * @returns the page.
 */
function timelinePage(snapshot: Snapshot, root: string): EntryPayload {
  const highest = Math.max(1, snapshot.chapters.length, ...snapshot.plans.map((plan) => plan.number))
  const resolution = resolveTimeline(snapshot.timeline, highest)
  const now = windowAt(resolution, highest)
  const recalls = snapshot.timeline.recalls ?? []
  const errors = resolution.findings.filter((finding) => finding.severity === 'error')
  const spine = buildSpine(snapshot)
  const pinned = snapshot.project.bookStart

  const points: EntrySpinePoint[] = spine.nodes.map((node) => ({
    when: node.label,
    kind: node.kind,
    events: spine.events
      .filter((event) => event.node === spine.nodes.indexOf(node))
      .map((event) => ({
        chapter: event.chapter,
        kind: event.kind,
        when: whenLabel(event.at, false),
        label: event.label,
        text: event.text,
        ...(event.note === undefined ? {} : { note: event.note }),
      })),
  }))
  const loose: EntrySpineEvent[] = spine.loose.map((event) => ({
    chapter: event.chapter,
    kind: event.kind,
    when: '',
    label: event.label,
    text: event.text,
  }))

  return {
    kind: 'timeline',
    title: '时间线',
    subtitle: `${spine.events.length} 个事件 · ${spine.nodes.length} 个年点 · ${recalls.length} 次回忆`,
    chip: now ? describeWindow(now) : undefined,
    breadcrumb: ['剧情设计', '时间线'],
    fields: [
      {
        label: '起点',
        value: pinned !== undefined && pinned !== ''
          ? `${pinned}（钉住的起点，novel_timeline action="start" 可改）`
          : spine.start === undefined
            ? '（还没有锚点）'
            : `${whenLabel(spine.start, false)}（取第一个锚点；要另定就用 novel_timeline action="start"）`,
      },
      { label: '现在', value: now ? `写到第${highest}章时约 ${describeWindow(now)}` : '（算不出来，先记一个锚点）' },
      { label: '体检', value: errors.length > 0 ? `${errors.length} 个矛盾需要处理` : resolution.findings.length > 0 ? `${resolution.findings.length} 条提醒` : '没有矛盾' },
    ],
    lists: [
      ...(recalls.length > 0
        ? [{
            label: '回忆',
            items: recalls.map((recall) => `第${recall.chapter}章回忆${recall.eventChapter === null ? '' : `第${recall.eventChapter}章的`}「${recall.about}」，说成 ${recall.claimed}`),
          }]
        : []),
    ],
    spine: { report: spine.report, points, loose },
    edit: {
      inputs: [
        {
          key: 'start',
          label: '起点（例如 2020-10；留空就回到第一个锚点）',
          value: pinned ?? '',
        },
        { key: 'clockWhen', label: '给选中的章节打这个日期（例如 2021-03-07）', value: '' },
        { key: 'clockChapters', label: '选了哪些章', value: '' },
      ],
      // Which chapters can be picked, and which ones already have a date — the
      // client draws the checklist from here rather than guessing from the tree.
      // Planned chapters are in the list too: a clock that can only be filled in
      // after the prose exists is a clock that arrives too late.
      clock: {
        chapters: [...new Set([
          ...snapshot.chapters.map((chapter) => chapter.number),
          ...snapshot.plans.map((plan) => plan.number),
        ])].sort((a, b) => a - b),
        dated: Object.fromEntries(
          snapshot.timeline.anchors
            .filter((anchor) => anchor.chapter > 0)
            .map((anchor) => [String(anchor.chapter), anchor.when]),
        ),
      },
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
  if (key === '' && kind !== 'timeline') return undefined
  if (kind === 'character') return characterPage(snapshot, key, root)
  if (kind === 'relations') return relationsPage(snapshot, root)
  if (kind === 'world') return worldPage(snapshot, key, root)
  if (kind === 'place') return placePage(snapshot, key, root)
  if (kind === 'story') return storyPage(snapshot, key, root)
  if (kind === 'timeline') return timelinePage(snapshot, root)
  const rounds = drafts.find((entry) => entry.number === Number(key))?.rounds ?? []
  return chapterPage(snapshot, key, rounds, root, body, reviews)
}
