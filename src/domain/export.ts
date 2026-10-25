/**
 * Turning a book into files someone else can open.
 *
 * Everything here is a pure function of the snapshot: the tool does the writing,
 * these decide what the bytes say. That split is what lets the whole export be
 * tested by comparing strings instead of reading a temporary directory back.
 *
 * The two shapes are deliberately different. `text` is what a writer pastes into
 * a submission system: chapter headings, paragraphs, no markup. `markdown` is
 * what a second reader opens: one file per volume, so a 94-chapter book is not a
 * single unreadable scroll.
 */
import type { ChapterDraft, ChapterMeta, Snapshot, VolumeOutline } from './types.ts'

/** Characters Windows refuses in a filename, plus control codes. */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g

/**
 * Make a title safe to use as a file name.
 *
 * @param name - a book, volume or chapter title.
 * @returns the same name with illegal characters replaced and length capped.
 */
export function safeFileName(name: string): string {
  const cleaned = name.replace(ILLEGAL, '-').replace(/\s+/g, ' ').trim()
  const trimmed = cleaned.replace(/[. ]+$/, '')
  return (trimmed === '' ? '未命名' : trimmed).slice(0, 80)
}

/**
 * The heading one chapter gets in an export.
 *
 * @param number - chapter number.
 * @param title - chapter title, if it has one.
 * @returns `第3章 过秤`, or just the number when the title is empty.
 */
export function chapterHeading(number: number, title: string): string {
  const trimmed = title.trim()
  return trimmed === '' ? `第${number}章` : `第${number}章 ${trimmed}`
}

/** Chapters in reading order, skipping numbers that are not written yet. */
function inOrder(chapters: readonly ChapterDraft[]): ChapterDraft[] {
  return [...chapters].sort((left, right) => left.number - right.number)
}

/** Paragraph text with blank lines kept, trailing whitespace dropped per line. */
function paragraphs(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.split('\n').map((line) => line.trimEnd()).join('\n').trim())
    .filter((block) => block !== '')
    .join('\n\n')
}

/**
 * The whole book as one plain-text file.
 *
 * @param snapshot - the book.
 * @param chapters - the written chapter bodies.
 * @returns title, then every chapter under its heading, separated by blank lines.
 */
export function bookText(snapshot: Snapshot, chapters: readonly ChapterDraft[]): string {
  const head = [`《${snapshot.project.title}》`, '']
  if (snapshot.project.premise.trim() !== '') head.push(paragraphs(snapshot.project.premise), '')
  const body = inOrder(chapters).flatMap((draft) => [
    chapterHeading(draft.number, draft.title),
    '',
    paragraphs(draft.text),
    '',
  ])
  return [...head, ...body].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/** One volume's worth of chapters, as markdown. */
function volumeMarkdown(
  volume: VolumeOutline | undefined,
  drafts: readonly ChapterDraft[],
): string {
  const title = volume === undefined ? '未分卷' : `第${volume.number}卷 ${volume.title}`.trim()
  const lines = [`# ${title}`, '']
  if (volume !== undefined && volume.summary.trim() !== '') lines.push(volume.summary.trim(), '')
  for (const draft of drafts) {
    lines.push(`## ${chapterHeading(draft.number, draft.title)}`, '', paragraphs(draft.text), '')
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/**
 * Split the book into one markdown file per volume.
 *
 * Written chapters that have no volume outline land in a `未分卷` file rather
 * than disappearing: an export that silently drops text is worse than an
 * untidy one.
 *
 * @param snapshot - the book.
 * @param chapters - the written chapter bodies.
 * @returns file name and body, in volume order.
 */
export function volumeFiles(
  snapshot: Snapshot,
  chapters: readonly ChapterDraft[],
): { name: string; body: string }[] {
  const volumes = [...snapshot.volumes].sort((left, right) => left.number - right.number)
  const volumeOf = new Map<number, number>()
  for (const plan of snapshot.plans) volumeOf.set(plan.number, plan.volume)

  const files: { name: string; body: string }[] = []
  const taken = new Set<number>()
  for (const draft of inOrder(chapters)) taken.add(draft.number)

  for (const volume of volumes) {
    const drafts = inOrder(chapters).filter((draft) => volumeOf.get(draft.number) === volume.number)
    if (drafts.length === 0) continue
    files.push({
      name: `${safeFileName(`第${volume.number}卷 ${volume.title}`)}.md`,
      body: volumeMarkdown(volume, drafts),
    })
    for (const draft of drafts) taken.delete(draft.number)
  }

  const loose = inOrder(chapters).filter((draft) => taken.has(draft.number))
  if (loose.length > 0) {
    files.push({ name: '未分卷.md', body: volumeMarkdown(undefined, loose) })
  }
  return files
}

/** Role labels used in the canon sheet, matching the panel's vocabulary. */
const ROLE_LABEL: Record<string, string> = {
  protagonist: '主角',
  antagonist: '反派',
  supporting: '配角',
  minor: '路人',
}

/**
 * The setting book: characters, world, outline, and the fact ledger.
 *
 * This is the file a new co-writer reads before touching a draft, so it holds
 * what a chapter body cannot tell you — voices, secrets, and what has already
 * been established as true.
 *
 * @param snapshot - the book.
 * @returns one markdown document.
 */
export function canonMarkdown(snapshot: Snapshot): string {
  const lines = [`# 《${snapshot.project.title}》设定集`, '', `- 阶段：${snapshot.project.phase}`, `- 目标字数：${snapshot.project.targetWords}`, '']

  const premise = snapshot.project.premise.trim()
  if (premise !== '') lines.push('## 一句话前提', '', paragraphs(premise), '')

  lines.push(`## 人物（${snapshot.characters.length}）`, '')
  for (const card of [...snapshot.characters].sort((left, right) => left.name.localeCompare(right.name))) {
    lines.push(`### ${card.name}（${ROLE_LABEL[card.role] ?? card.role}）`, '')
    if (card.voice.trim() !== '') lines.push(`- 说话方式：${card.voice.trim()}`)
    if (card.appearance.trim() !== '') lines.push(`- 外貌：${card.appearance.trim()}`)
    if (card.goal.trim() !== '') lines.push(`- 目标：${card.goal.trim()}`)
    if (card.secret.trim() !== '') lines.push(`- 秘密：${card.secret.trim()}`)
    lines.push('')
  }

  lines.push(`## 世界观（${snapshot.world.length}）`, '')
  for (const entry of [...snapshot.world].sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name))) {
    lines.push(`### ${entry.name}（${entry.kind}）`, '', paragraphs(entry.detail), '')
  }

  lines.push(`## 分卷（${snapshot.volumes.length}）`, '')
  for (const volume of [...snapshot.volumes].sort((left, right) => left.number - right.number)) {
    lines.push(`- 第${volume.number}卷 ${volume.title}${volume.approved ? '' : '（未批准）'}${volume.summary.trim() === '' ? '' : `：${volume.summary.trim()}`}`)
  }
  lines.push('')

  if (snapshot.plans.length > 0) {
    lines.push(`## 章纲（${snapshot.plans.length}）`, '')
    for (const plan of [...snapshot.plans].sort((left, right) => left.number - right.number)) {
      lines.push(`### ${chapterHeading(plan.number, plan.title)}${plan.approved ? '' : '（未批准）'}`, '')
      if (plan.pov.trim() !== '') lines.push(`- 视点：${plan.pov.trim()}`)
      if (plan.characters.length > 0) lines.push(`- 出场：${plan.characters.join('、')}`)
      for (const beat of plan.beats) lines.push(`- 节拍：${beat}`)
      for (const hook of plan.hooks) lines.push(`- 钩子：${hook}`)
      lines.push('')
    }
  }

  // A fact stops being current when a *later* entry supersedes it — the entry
  // that replaced it is the live one. Filtering on `supersedes === null` would
  // do the exact opposite: keep the replaced facts and drop the replacements.
  const replaced = new Set(
    snapshot.ledger.map((entry) => entry.supersedes).filter((id): id is string => typeof id === 'string' && id !== ''),
  )
  const active = snapshot.ledger.filter((entry) => !replaced.has(entry.id))
  if (active.length > 0) {
    lines.push(`## 已确立的事实（${active.length}）`, '')
    lines.push('| id | 主体 | 属性 | 值 | 第几章 | 原文 |', '| --- | --- | --- | --- | --- | --- |')
    for (const entry of active) {
      const quote = entry.quote.replace(/\|/g, '\\|').replace(/\s+/g, ' ')
      const chapter = entry.chapter === 0 ? '设定' : `第${entry.chapter}章`
      lines.push(`| ${entry.id} | ${entry.subject} | ${entry.predicate} | ${entry.value} | ${chapter} | ${quote} |`)
    }
    lines.push('')
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/**
 * The chapter list a table of contents needs.
 *
 * @param chapters - the written chapters, in any order.
 * @returns one markdown line per chapter, in reading order.
 */
export function contentsMarkdown(chapters: readonly ChapterMeta[]): string {
  return inOrder(chapters as ChapterDraft[])
    .map((draft) => `- ${chapterHeading(draft.number, draft.title)}`)
    .join('\n')
}
