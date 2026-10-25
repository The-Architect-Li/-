/**
 * Bringing a manuscript that already exists into a book.
 *
 * Nobody starts at chapter one of an empty folder. The realistic first move is
 * "I have 86 chapters in `正文/`, six character files in `人物/`, and one
 * `全书大纲.md` — I would like the tooling that checks my continuity to know
 * about them". Until v0.12 the only way in was `novel_chapter action="write"`
 * one chapter at a time, which means the tool that is supposed to help with a
 * long book only works on books that started with it.
 *
 * So this module reads markdown that is already on disk and proposes exactly
 * what it would write, in the shape the store wants. It is deliberately pure:
 * files come in as strings, a plan comes out, and nothing touches the disk.
 * `novel_import` and the panel both show the plan first and only write when
 * asked.
 *
 * The mapping is opinionated but stated, because a silent guess is worse than
 * a stated one:
 *
 * - a file whose name carries `第N章` is that chapter; its title is the rest of
 *   the name, so `第10章-开门-v1.md` becomes chapter 10, 《开门》;
 * - `人物/名字.md` becomes a character card, section by section, with
 *   anything unrecognised kept in `notes` rather than dropped;
 * - `大纲/全书大纲.md` gives the premise (the `一句话立意` line), one volume per
 *   `## 卷…` heading, and one chapter plan per `- 第N章 标题：一句话` line.
 */
import { deriveSummary } from './save.ts'
import { countChars, splitParagraphs } from './text.ts'
import type { ChapterPlan, CharacterCard, CharacterRole, VolumeOutline } from './types.ts'

/** One markdown file lifted off the disk, before any interpretation. */
export interface SourceFile {
  /** Path relative to the folder the user picked, for reporting. */
  readonly path: string
  /** Base name including extension. */
  readonly name: string
  readonly text: string
}

/** One chapter the importer would write. */
export interface PlannedChapter {
  number: number
  title: string
  text: string
  words: number
  summary: string
  /** Where it came from, so the report can say which file landed where. */
  source: string
}

/** One character card the importer would write, plus its source file. */
export interface PlannedCast {
  card: CharacterCard
  source: string
}

/** Everything one import would write. Nothing here has touched the disk yet. */
export interface ImportPlan {
  premise: string
  chapters: PlannedChapter[]
  cast: PlannedCast[]
  volumes: VolumeOutline[]
  plans: ChapterPlan[]
  /** Markdown that looked like prose but named no chapter. */
  ignored: string[]
}

/** The Chinese numerals used in 卷一…卷十二 headings. */
const NUMERALS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

/**
 * Read a chapter number out of a file name.
 *
 * Accepts full-width digits because a manuscript typed in a Chinese IME has
 * them more often than one would hope.
 *
 * @param name - the file name, with or without extension.
 * @returns the number, or `undefined` when the name names no chapter.
 */
export function chapterNumberOf(name: string): number | undefined {
  const match = /第\s*([0-9０-９]+)\s*章/.exec(name)
  if (match === null) return undefined
  const digits = match[1]!.replace(/[０-９]/g, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
  )
  const number = Number.parseInt(digits, 10)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

/**
 * Read a chapter title out of a file name.
 *
 * @param name - the file name, with or without extension.
 * @param number - the chapter number already parsed from it.
 * @returns the title, or `第N章` when the name carries nothing but the number.
 */
export function chapterTitleOf(name: string, number: number): string {
  const bare = name.replace(/\.(md|markdown|txt)$/i, '')
  const afterChapter = bare.replace(/^.*?第\s*[0-9０-９]+\s*章/, '')
  const title = afterChapter
    .replace(/[-_—–\s]*v\d+$/i, '')
    .replace(/^[\s\-_—–·、:：]+/, '')
    .trim()
  return title === '' ? `第${number}章` : title
}

/** Turn `一`…`十二` into a number; anything else falls back. */
function numeralValue(text: string): number | undefined {
  if (text === '') return undefined
  if (text === '十') return 10
  const tens = /^十([一二三四五六七八九])$/.exec(text)
  if (tens !== null) return 10 + NUMERALS.indexOf(tens[1]!)
  const single = NUMERALS.indexOf(text)
  return single > 0 ? single : undefined
}

/**
 * Plan the chapters among a folder of markdown.
 *
 * When two files claim the same chapter number, the longer one wins: a
 * manuscript that kept `第5章-旧-v1.md` beside `第5章-新-v2.md` means the v2 is
 * the one being worked on, and length is the only signal available without
 * dates.
 *
 * @param files - every markdown file that might be prose.
 * @returns the chapters in reading order, and the names that named no chapter.
 */
export function planChapters(files: readonly SourceFile[]): {
  chapters: PlannedChapter[]
  ignored: string[]
} {
  const best = new Map<number, PlannedChapter>()
  const ignored: string[] = []
  for (const file of files) {
    const number = chapterNumberOf(file.name)
    if (number === undefined) {
      if (file.text.trim() !== '') ignored.push(file.name)
      continue
    }
    const title = chapterTitleOf(file.name, number)
    const text = stripHeading(file.text, number)
    if (text === '') continue
    const candidate: PlannedChapter = {
      number,
      title,
      text,
      words: countChars(text),
      summary: deriveSummary(text),
      source: file.path,
    }
    const previous = best.get(number)
    if (previous === undefined || candidate.text.length > previous.text.length) {
      best.set(number, candidate)
    }
  }
  return {
    chapters: [...best.values()].sort((left, right) => left.number - right.number),
    ignored,
  }
}

/**
 * Drop a leading `# 第N章 标题` line, which would otherwise be counted as prose
 * and shown twice.
 *
 * @param text - the file body.
 * @param number - the chapter number the file claims.
 * @returns the body without its redundant heading.
 */
function stripHeading(text: string, number: number): string {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  const lines = trimmed.split(/\r?\n/)
  const first = lines[0]?.trim() ?? ''
  if (/^#{1,2}\s/.test(first) && first.includes(`第${number}章`)) {
    return lines.slice(1).join('\n').trim()
  }
  return trimmed
}

/** Which card field a bullet belongs to, judged by its own key or its section. */
type Slot = 'voice' | 'appearance' | 'goal' | 'secret' | 'notes'

/** Route one bullet by the words in front of its colon. */
function slotOfKey(key: string, section: Slot): Slot {
  if (/说话|语气|口吻|语言|声音|台词/.test(key)) return 'voice'
  if (/外形|外貌|长相|年龄|出身|经济|穿着|身高/.test(key)) return 'appearance'
  if (/目标|欲望|动机|想要|目的|野心/.test(key)) return 'goal'
  if (/秘密|阈值|弱点|禁忌|软肋|隐情/.test(key)) return 'secret'
  return section
}

/** Route a `## 标题` section by its heading. */
function slotOfSection(heading: string): Slot {
  if (/说话|语气|口吻|语言|声音|台词/.test(heading)) return 'voice'
  if (/外在|外貌|外形|形象|底色|履历|出身/.test(heading)) return 'appearance'
  if (/欲望|目标|动机|野心|想要/.test(heading)) return 'goal'
  if (/秘密|阈值|弱点|禁忌|软肋|心理/.test(heading)) return 'secret'
  return 'notes'
}

/**
 * Plan the character cards among a folder of markdown.
 *
 * Everything a card has no field for — a relationship map, a timeline, a
 * warning to the author — is kept in `notes` instead of being thrown away. A
 * file that loses half its content on import teaches the writer not to trust
 * the importer.
 *
 * @param files - the markdown under the cast folder.
 * @param protagonistNames - names the outline called the lead, if any.
 * @param now - clock, injected so the plan is reproducible in tests.
 * @returns one card per file, in file-name order.
 */
export function planCast(
  files: readonly SourceFile[],
  protagonistNames: readonly string[] = [],
  now: Date = new Date(),
): PlannedCast[] {
  const planned: PlannedCast[] = []
  for (const file of files) {
    const text = file.text.replace(/^\uFEFF/, '')
    const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim()
    const name = heading ?? file.name.replace(/\.(md|markdown|txt)$/i, '').trim()
    if (name === '') continue
    const buckets: Record<Slot, string[]> = { voice: [], appearance: [], goal: [], secret: [], notes: [] }
    let section: Slot = 'notes'
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (line === '' || line.startsWith('# ')) continue
      const sub = /^#{2,4}\s+(.+)$/.exec(line)
      if (sub !== null) {
        section = slotOfSection(sub[1]!)
        continue
      }
      const bullet = /^[-*+]\s+(.+)$/.exec(line) ?? /^(.+)$/.exec(line)
      const body = bullet?.[1]?.trim()
      if (body === undefined || body === '' || body.startsWith('>')) continue
      const colon = /^([^：:]{1,12})[：:]\s*(.+)$/.exec(body)
      const slot = colon === null ? section : slotOfKey(colon[1]!, section)
      buckets[slot].push(body)
    }
    const role: CharacterRole = protagonistNames.includes(name) ? 'protagonist' : 'supporting'
    planned.push({
      card: {
        name,
        role,
        voice: buckets.voice.join('\n'),
        appearance: buckets.appearance.join('\n'),
        goal: buckets.goal.join('\n'),
        secret: buckets.secret.join('\n'),
        notes: buckets.notes.join('\n'),
        updatedAt: now.toISOString(),
      },
      source: file.path,
    })
  }
  return planned
}

/** One chapter line lifted from the outline. */
export interface OutlineChapter {
  number: number
  title: string
  line: string
  volume: number
}

/** What the outline file gave up. */
export interface OutlinePlan {
  premise: string
  protagonistNames: string[]
  volumes: VolumeOutline[]
  chapters: OutlineChapter[]
}

/**
 * Plan the premise, volumes, and chapter contracts from `全书大纲.md`.
 *
 * The manuscript's own claim file is `## 卷一·翻身（第1–11章…）` followed by
 * `- 第1章 裂缝：一句话`. That is already a contract, just written for a person
 * instead of a checker, so it is lifted as-is rather than re-invented.
 *
 * @param text - the outline file, when the folder has one.
 * @returns everything the outline could tell us; empty values when it is absent.
 */
export function planOutline(text: string): OutlinePlan {
  const body = text.replace(/^\uFEFF/, '')
  const premiseLine = /^>\s*一句话立意[：:]\s*(.+)$/m.exec(body)?.[1]?.trim()
  const leadLine = /^>\s*主角[：:]\s*(.+)$/m.exec(body)?.[1]?.trim()
  const volumes: VolumeOutline[] = []
  const chapters: OutlineChapter[] = []
  let volumeNumber = 0
  let currentVolume = 0
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading !== null && !/^###/.test(line)) {
      const title = heading[1]!.trim()
      const numeral = /^卷\s*([零一二三四五六七八九十]+)/.exec(title)?.[1]
      const number = (numeral === undefined ? undefined : numeralValue(numeral)) ?? volumeNumber + 1
      volumeNumber = number
      currentVolume = number
      volumes.push({
        number,
        title: title.replace(/（[^）]*）\s*$/, '').trim(),
        summary: '',
        approved: true,
      })
      continue
    }
    const core = /^\*\*核心\*\*[：:]\s*(.+)$/.exec(line)
    if (core !== null && currentVolume > 0) {
      const target = volumes.find((volume) => volume.number === currentVolume)
      if (target !== undefined) target.summary = core[1]!.trim()
      continue
    }
    const chapter = /^[-*+]\s*第\s*([0-9０-９]+)\s*章\s*([^：:]+)[：:]\s*(.+)$/.exec(line)
    if (chapter !== null) {
      const digits = chapter[1]!.replace(/[０-９]/g, (digit) =>
        String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
      )
      chapters.push({
        number: Number.parseInt(digits, 10),
        title: chapter[2]!.trim(),
        line: chapter[3]!.trim(),
        volume: currentVolume,
      })
    }
  }
  const protagonistNames =
    leadLine === undefined
      ? []
      : leadLine
          // The parenthesis is stripped before splitting: these lines often read
          // `主角：王上（24→32岁，由小职员爬到老板）`, and the comma inside the
          // bracket would otherwise cut the name in half.
          .replace(/（[^）]*）/g, ' ')
          .replace(/\([^)]*\)/g, ' ')
          .split(/[、,，/|]/)
          .map((part) => part.trim())
          .filter((part) => part !== '')
  return {
    premise: premiseLine ?? firstProse(body),
    protagonistNames,
    volumes: volumes.sort((left, right) => left.number - right.number),
    chapters,
  }
}

/** The first sentence-ish paragraph of a document, for when it names no premise. */
function firstProse(body: string): string {
  for (const paragraph of splitParagraphs(body)) {
    const line = paragraph.replace(/^#+\s*/, '').trim()
    if (line === '' || line.startsWith('>') || line.startsWith('|')) continue
    return line.length > 160 ? `${line.slice(0, 160)}…` : line
  }
  return ''
}

/**
 * Assemble the whole plan for one folder.
 *
 * @param input - the three folders' worth of files, already read as strings.
 * @param now - clock, injected for reproducible tests.
 * @returns what an import would write, in store order.
 */
export function planImport(
  input: {
    chapters: readonly SourceFile[]
    cast: readonly SourceFile[]
    outline?: string | undefined
  },
  now: Date = new Date(),
): ImportPlan {
  const outline = planOutline(input.outline ?? '')
  const { chapters, ignored } = planChapters(input.chapters)
  const cast = planCast(input.cast, outline.protagonistNames, now)
  const volumes = [...outline.volumes]
  const plans: ChapterPlan[] = outline.chapters.map((chapter) => ({
    number: chapter.number,
    volume: chapter.volume,
    title: chapter.title,
    pov: '',
    characters: [],
    beats: [chapter.line],
    hooks: [],
    approved: true,
  }))
  return {
    premise: outline.premise,
    chapters,
    cast,
    volumes,
    plans: plans.sort((left, right) => left.number - right.number),
    ignored,
  }
}
