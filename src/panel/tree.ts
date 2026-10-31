/**
 * The panel's tree.
 *
 * One book, folded into the four drawers a writer actually opens: world,
 * cast, plot, manuscript. Every row is already flattened into the payload —
 * the browser half never derives structure, it only draws what it is given.
 *
 * Why the tree lives on the host: the browser has no filesystem, and a JSON
 * shape this small is cheaper to test as a pure function than to re-derive in
 * hand-written `client.js`. The counts here are the ones the screenshot shows
 * ("人物设计 12"), so a miscount is a test failure, not a visual nit.
 */
import type { ChapterMeta, ChapterPlan, CharacterCard, DraftRound, Snapshot } from '../domain/types.ts'
import { describeWindow, resolveTimeline, windowAt } from '../domain/clock.ts'
import { cardIsStale } from '../domain/review-window.ts'

/** How one row wants to be drawn: finished work, open work, or a warning. */
export type PanelTone = 'done' | 'todo' | 'warn' | 'muted'

/** One line in the drawer. Groups carry `children`; leaves do not. */
export interface PanelRow {
  /** Stable identity, unique inside the panel; used as the React key and the collapse key. */
  id: string
  label: string
  /** Pill count, e.g. the `12` in `人物设计 12`. */
  count?: number
  /** Small chip on the right, e.g. `已批准`, `已完成`, `故事线`. */
  chip?: string
  /** Right-aligned detail that is not a number, e.g. `3.2 万字`. */
  aside?: string
  tone?: PanelTone
  /**
   * What clicking this leaf opens, when it stands for a thing with its own page.
   *
   * The browser half does not look anything up: it sends `kind` and `key` back
   * to `/entry` and draws whatever comes back. Rows without a kind only
   * highlight when clicked.
   */
  kind?: PanelEntryKind
  /** Identity inside `kind`: a character name, a world name, a chapter number. */
  key?: string
  children?: PanelRow[]
}

/** The kinds of thing a row can open. */
export type PanelEntryKind =
  | 'character'
  | 'world'
  | 'chapter'
  | 'card'
  | 'place'
  | 'story'
  | 'timeline'
  | 'relations'

/** One drawer: a top-level row group with its own count. */
export interface PanelSection {
  id: string
  label: string
  count: number
  rows: PanelRow[]
}

/** The role order the cast drawer uses, with the names a writer expects. */
const CAST_GROUPS = [
  { role: 'protagonist', label: '主角' },
  { role: 'antagonist', label: '反派' },
  { role: 'supporting', label: '配角' },
  { role: 'minor', label: '路人' },
] as const

/**
 * The most rows one list will carry.
 *
 * A drawer is windowed on the client, so a long list is a scrolling problem
 * rather than a rendering one: every chapter card can be listed. This ceiling
 * is about the payload, not the screen — a book of several thousand chapters
 * should not arrive as one JSON document the panel must parse before it can
 * draw anything. It is a guardrail, and the "还有 N 条" row says when it bites.
 */
const MAX_ROWS = 2000

/** Draft rounds keyed by chapter number, as the route already read them. */
export type DraftRounds = ReadonlyMap<number, readonly DraftRound[]>

/**
 * Format a word count the way the studio writes it.
 *
 * @param words - committed chapter words.
 * @returns `1.2 万字` past ten thousand, plain digits below.
 */
export function formatWords(words: number): string {
  if (!Number.isFinite(words) || words <= 0) return '0 字'
  if (words >= 10000) return `${(words / 10000).toFixed(1)} 万字`
  return `${words} 字`
}

/**
 * Summarise a list that may be longer than the payload should carry.
 *
 * @param rows - the rows built so far.
 * @param total - how many exist in the book.
 * @param cap - how many to keep.
 * @param prefix - id prefix for the summary row.
 * @returns the rows to send, plus the "还有 N 条" tail when it is needed.
 */
function capped(rows: PanelRow[], total: number, cap: number, prefix: string): PanelRow[] {
  if (total <= cap) return rows
  return [
    ...rows.slice(0, cap),
    {
      id: `${prefix}.more`,
      label: `还有 ${total - cap} 条`,
      tone: 'muted',
    },
  ]
}

/**
 * The world drawer: every entry that is not a person.
 *
 * @param snapshot - the book.
 * @returns the drawer.
 */
function worldSection(snapshot: Snapshot): PanelSection {
  const groups = groupByKind(snapshot.world)
  // One kind is not a grouping, it is a heading nobody asked for — and the
  // default kind covers every book that never set one, so grouping there would
  // wrap the whole drawer in a single row called 「设定」.
  const rows: PanelRow[] =
    groups.length <= 1
      ? snapshot.world.map((entry, index) => worldRow(entry, `world.${index}`, true))
      : groups.map((group) => ({
          id: `world.kind.${group.kind}`,
          label: group.label,
          count: group.entries.length,
          children: capped(
            group.entries.map((entry, index) => worldRow(entry, `world.kind.${group.kind}.${index}`, false)),
            group.entries.length,
            MAX_ROWS,
            `world.kind.${group.kind}`,
          ),
        }))
  return {
    id: 'world',
    label: '世界观',
    count: snapshot.world.length,
    rows: capped(rows, rows.length, MAX_ROWS, 'world'),
  }
}

/**
 * One world entry as a row.
 *
 * @param entry - the entry.
 * @param id - stable row id.
 * @param showKind - true in the flat list, where the kind is the only clue.
 *   Inside a group it is the heading, and repeating it on every row is noise.
 * @returns the row.
 */
function worldRow(entry: Snapshot['world'][number], id: string, showKind: boolean): PanelRow {
  return {
    id,
    label: entry.name,
    kind: 'world',
    key: entry.name,
    ...(showKind && entry.kind ? { aside: entry.kind } : {}),
  }
}

/** The kind a world entry falls under, when it never said. */
const WORLD_UNFILED = '未分类'

/**
 * Group world entries by the kind their author gave them.
 *
 * Deliberately not a fixed taxonomy. A cultivation novel has 宗门 and 功法; a
 * city novel has 公司 and 街区; a mystery has 案件 and 势力. Hard-coding a list
 * would fit one genre and misfile every other, so the kinds come from the
 * entries themselves and the biggest group sorts first — that is almost always
 * the one the author is working in.
 *
 * @param entries - every world entry.
 * @returns the groups, largest first, then by name so the order is stable.
 */
function groupByKind(entries: Snapshot['world']): { kind: string; label: string; entries: Snapshot['world'] }[] {
  const byKind = new Map<string, Snapshot['world']>()
  for (const entry of entries) {
    const kind = entry.kind.trim() === '' ? WORLD_UNFILED : entry.kind.trim()
    const list = byKind.get(kind) ?? []
    list.push(entry)
    byKind.set(kind, list)
  }
  return [...byKind.entries()]
    .map(([kind, list]) => ({
      kind,
      label: kind,
      entries: [...list].sort((a, b) => a.name.localeCompare(b.name, 'zh')),
    }))
    .sort((a, b) => b.entries.length - a.entries.length || a.label.localeCompare(b.label, 'zh'))
}

/**
 * The cast drawer: an overview row, then one group per structural role.
 *
 * @param snapshot - the book.
 * @returns the drawer.
 */
function castSection(snapshot: Snapshot): PanelSection {
  const byRole = new Map<string, CharacterCard[]>()
  for (const card of snapshot.characters) {
    const list = byRole.get(card.role) ?? []
    list.push(card)
    byRole.set(card.role, list)
  }
  const groups: PanelRow[] = CAST_GROUPS.map((group) => {
    const cards = byRole.get(group.role) ?? []
    const children: PanelRow[] = cards.map((card, index) => ({
      id: `cast.${group.role}.${index}`,
      label: card.name,
      kind: 'character',
      key: card.name,
      ...(card.goal ? { aside: card.goal } : {}),
    }))
    return {
      id: `cast.${group.role}`,
      label: group.label,
      count: cards.length,
      tone: cards.length === 0 ? 'muted' : 'todo',
      children: capped(children, cards.length, MAX_ROWS, `cast.${group.role}`),
    }
  })
  const edges = snapshot.relations.edges.length
  return {
    id: 'cast',
    label: '人物设计',
    count: snapshot.characters.length,
    rows: [
      { id: 'cast.overview', label: '概览', aside: `${snapshot.characters.length} 人` },
      // One line for the whole web: since v0.21 a relation is an edge, so this page
      // can show every pair once instead of asking the author to open each card.
      {
        id: 'cast.relations',
        label: '关系一览',
        kind: 'relations',
        key: 'relations',
        aside: `${edges} 条`,
        tone: edges === 0 ? 'muted' : 'todo',
      },
      ...groups,
      // A book with chapters and no cards is a book that was imported, and the
      // author is about to conclude this drawer is broken. One row that says
      // where they come from, in the place they are looking.
      ...(snapshot.characters.length === 0 && snapshot.chapters.length > 0
        ? [
            {
              id: 'cast.empty',
              label: '这个抽屉是空的，但书里有正文',
              aside: '让考据员读一遍',
              tone: 'muted' as const,
            },
          ]
        : []),
    ],
  }
}

/**
 * Chapter numbers a volume's outline covers.
 *
 * @param plans - chapter outlines.
 * @param volume - the volume number.
 * @returns chapter numbers in order.
 */
function chaptersOfVolume(plans: readonly ChapterPlan[], volume: number): number[] {
  return plans.filter((plan) => plan.volume === volume).map((plan) => plan.number).sort((a, b) => a - b)
}

/**
 * The plot drawer: places, story points, the clock, and the chapter cards.
 *
 * The list is short on purpose. A drawer with six entries where four are
 * derived views of the same outlines taught nobody anything; a writer opening
 * 剧情设计 wants to know *where* things happen, *which story* they are in, and
 * *when* it is — three questions the prose keeps breaking, plus the cards.
 *
 * @param snapshot - the book.
 * @returns the drawer.
 */
function plotSection(snapshot: Snapshot): PanelSection {
  const placeRows: PanelRow[] = snapshot.places.map((place, index) => ({
    id: `plot.place.${index}`,
    label: place.name,
    kind: 'place',
    key: place.name,
    aside: place.kind || undefined,
    chip: place.states.length > 1 ? `${place.states.length} 次变化` : undefined,
  }))

  const pointRows: PanelRow[] = snapshot.storyPoints.map((point) => ({
    id: `plot.story.${point.id}`,
    label: point.name,
    kind: 'story',
    key: point.id,
    aside: `第${point.startChapter}${point.endChapter === null ? ' 章起' : `–${point.endChapter} 章`}`,
    chip: point.closed ? '已收尾' : '进行中',
    tone: point.closed ? 'done' : 'todo',
  }))

  const resolution = resolveTimeline(snapshot.timeline, Math.max(1, snapshot.chapters.length, ...snapshot.plans.map((plan) => plan.number)))
  const now = windowAt(resolution, Math.max(1, snapshot.chapters.length))
  const clockCount = snapshot.timeline.anchors.length + snapshot.timeline.spans.length + (snapshot.timeline.recalls ?? []).length

  const cards: PanelRow[] = snapshot.plans.map((plan) => ({
    id: `plot.card.${plan.number}`,
    label: `第${plan.number}章 ${plan.title}`.trim(),
    kind: 'card',
    key: String(plan.number),
    chip: plan.approved ? '已批准' : '待批准',
    aside: `${plan.beats.length} 节拍`,
    tone: plan.approved ? 'done' : 'todo',
  }))

  return {
    id: 'plot',
    label: '剧情设计',
    count: snapshot.places.length + snapshot.storyPoints.length + clockCount + snapshot.plans.length,
    rows: [
      {
        id: 'plot.places',
        label: '地点',
        count: snapshot.places.length,
        tone: snapshot.places.length === 0 ? 'muted' : 'todo',
        children: capped(placeRows, snapshot.places.length, MAX_ROWS, 'plot.place'),
      },
      {
        id: 'plot.stories',
        label: '故事点',
        count: snapshot.storyPoints.length,
        tone: snapshot.storyPoints.length === 0 ? 'muted' : 'todo',
        children: capped(pointRows, snapshot.storyPoints.length, MAX_ROWS, 'plot.story'),
      },
      {
        id: 'plot.clock',
        label: '时间线',
        kind: 'timeline',
        key: 'clock',
        aside: clockCount === 0 ? '还没记' : `${snapshot.timeline.anchors.length} 锚点`,
        ...(now ? { chip: describeWindow(now) } : {}),
        tone: clockCount === 0 ? 'muted' : 'done',
      },
      {
        id: 'plot.cards',
        label: '章卡',
        count: snapshot.plans.length,
        children: capped(cards, snapshot.plans.length, MAX_ROWS, 'plot.card'),
      },
    ],
  }
}

/**
 * The manuscript drawer: volumes, then their chapters with real state.
 *
 * A chapter row is `done` once it is committed, `todo` when its outline is
 * approved and nothing is written, `warn` while a draft is waiting.
 *
 * @param snapshot - the book.
 * @param rounds - draft rounds already read by the route.
 * @returns the drawer.
 */
function textSection(snapshot: Snapshot, rounds: DraftRounds): PanelSection {
  const written = new Map<number, ChapterMeta>(snapshot.chapters.map((chapter) => [chapter.number, chapter]))
  const numbers = new Set<number>()
  for (const plan of snapshot.plans) numbers.add(plan.number)
  for (const chapter of snapshot.chapters) numbers.add(chapter.number)

  const chapterRow = (number: number): PanelRow => {
    const plan = snapshot.plans.find((entry) => entry.number === number)
    const chapter = written.get(number)
    const draftCount = rounds.get(number)?.length ?? 0
    const title = plan?.title || chapter?.title || ''
    const base = {
      id: `text.chapter.${number}`,
      label: `第${number}章 ${title}`.trim(),
      kind: 'chapter' as const,
      key: String(number),
    }
    if (chapter) {
      // A card written from an older draft no longer describes the prose. The
      // row says so rather than leaving the author to compare two pages.
      const stale = cardIsStale(plan, chapter)
      return {
        ...base,
        chip: stale ? '卡过期' : '已完成',
        aside: formatWords(chapter.words),
        tone: stale ? 'warn' : 'done',
      }
    }
    if (draftCount > 0) return { ...base, chip: `${draftCount} 稿`, tone: 'warn' }
    if (plan?.approved) return { ...base, chip: '可写', tone: 'todo' }
    return { ...base, chip: '未写', tone: 'muted' }
  }

  const assigned = new Set<number>()
  for (const volume of snapshot.volumes) {
    for (const number of chaptersOfVolume(snapshot.plans, volume.number)) assigned.add(number)
  }
  const loose = [...numbers].filter((number) => !assigned.has(number)).sort((a, b) => a - b)

  const volumeRows: PanelRow[] = snapshot.volumes.map((volume) => {
    const covered = chaptersOfVolume(snapshot.plans, volume.number)
    return {
      id: `text.volume.${volume.number}`,
      label: `第${volume.number}卷 ${volume.title}`.trim(),
      count: covered.length,
      children: capped(covered.map(chapterRow), covered.length, MAX_ROWS, `text.volume.${volume.number}`),
    }
  })

  const looseRows: PanelRow[] = loose.map(chapterRow)

  return {
    id: 'text',
    label: '正文',
    count: snapshot.chapters.length,
    rows: [
      ...volumeRows,
      ...(looseRows.length > 0
        ? [
            {
              id: 'text.loose',
              label: '未分卷',
              count: looseRows.length,
              children: capped(looseRows, looseRows.length, MAX_ROWS, 'text.loose'),
            } satisfies PanelRow,
          ]
        : []),
    ],
  }
}

/**
 * Build all drawers.
 *
 * @param snapshot - the book.
 * @param rounds - draft rounds per chapter.
 * @returns the sections, in drawing order.
 */
export function buildSections(snapshot: Snapshot, rounds: DraftRounds): PanelSection[] {
  return [worldSection(snapshot), castSection(snapshot), plotSection(snapshot), textSection(snapshot, rounds)]
}

/** Rows in use, for the panel's footer line. */
export function countRows(sections: readonly PanelSection[]): number {
  let total = 0
  const walk = (rows: readonly PanelRow[]): void => {
    for (const row of rows) {
      total += 1
      if (row.children) walk(row.children)
    }
  }
  for (const section of sections) walk(section.rows)
  return total
}
