/**
 * Reading a manuscript off the disk.
 *
 * The importer and the panel's create dialog ask the same question — "what is
 * already in this folder?" — and must answer it identically, so the walking and
 * the wording live here rather than in either caller.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImportPlan, SourceFile } from './import-scan.ts'

/** Folders that usually hold prose, in the order worth trying. */
const PROSE_DIRS = ['正文', 'chapters', '章', '卷']
/** Folders that usually hold character files. */
const CAST_DIRS = ['人物', 'canon', '角色', '人物设计']
/** Outline files worth trying, first hit wins. */
const OUTLINE_FILES = ['大纲/全书大纲.md', '全书大纲.md', 'outline.md', '大纲/大纲.md', '大纲.md']
/** What counts as a text file. */
const TEXT_FILE = /\.(md|markdown|txt)$/i
/** Guard against walking a folder that is not a manuscript. */
const MAX_FILES = 5000

/** What one folder offered. */
export interface Sources {
  chapters: SourceFile[]
  cast: SourceFile[]
  outline?: string | undefined
  /** Directories the files actually came from, for the report. */
  used: string[]
  /** Whether a folder held more files than the walk was willing to read. */
  capped: boolean
}

/**
 * Read every text file under one directory, one level deep.
 *
 * Recursion is deliberately shallow: manuscripts live in `正文/`, sometimes in
 * `正文/卷一/`. Going deeper invites walking `node_modules` and `.git` of a
 * folder the user picked by mistake.
 *
 * @param dir - absolute directory.
 * @param depth - remaining levels to descend.
 * @returns the files found, and whether the walk was capped.
 */
async function readTextFiles(dir: string, depth = 1): Promise<{ files: SourceFile[]; capped: boolean }> {
  const files: SourceFile[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (files.length >= MAX_FILES) return { files, capped: true }
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth <= 0) continue
      const nested = await readTextFiles(full, depth - 1)
      files.push(...nested.files)
      if (nested.capped) return { files, capped: true }
      continue
    }
    if (!entry.isFile() || !TEXT_FILE.test(entry.name)) continue
    try {
      const text = await readFile(full, 'utf8')
      files.push({ path: full, name: entry.name, text })
    } catch {
      // An unreadable file is not a reason to fail the whole scan.
    }
  }
  return { files, capped: false }
}

/** Whether a path exists and is a directory. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Gather the three folders' worth of sources.
 *
 * @param dir - the folder the user picked (absolute).
 * @returns prose, cast, outline, and which directories were used.
 */
export async function readSources(dir: string): Promise<Sources> {
  const used: string[] = []
  const chapters: SourceFile[] = []
  const cast: SourceFile[] = []
  let capped = false
  for (const name of PROSE_DIRS) {
    const folder = join(dir, name)
    if (!(await isDirectory(folder))) continue
    const found = await readTextFiles(folder)
    chapters.push(...found.files)
    capped ||= found.capped
    used.push(name)
    break
  }
  for (const name of CAST_DIRS) {
    const folder = join(dir, name)
    if (!(await isDirectory(folder))) continue
    const found = await readTextFiles(folder, 0)
    cast.push(...found.files)
    capped ||= found.capped
    used.push(name)
    break
  }
  if (chapters.length === 0) {
    // No 正文/: maybe the chapters sit right here, next to this folder's own
    // `.novel`. Read one level, and let `planChapters` ignore what it cannot
    // number — the picker's job is to look, not to be sure.
    const found = await readTextFiles(dir, 0)
    chapters.push(...found.files)
    capped ||= found.capped
    used.push('.')
  }
  let outline: string | undefined
  for (const name of OUTLINE_FILES) {
    try {
      outline = await readFile(join(dir, name), 'utf8')
      used.push(name)
      break
    } catch {
      // Try the next name.
    }
  }
  return { chapters, cast, outline, used, capped }
}

/** `12.5 万字` — a number a person can read at a glance. */
export function wordsText(words: number): string {
  return words >= 10_000 ? `${(words / 10_000).toFixed(1)} 万字` : `${words} 字`
}

/** A headline for one plan, used by both the scan and the panel. */
export interface ScanSummary {
  dir: string
  chapters: number
  words: number
  cast: number
  volumes: number
  plans: number
  premise: string
  /** Chapter numbers that already exist in the book. */
  conflicts: number[]
  /** Characters whose card has no `voice` yet, which the gate will hold on. */
  voiceless: string[]
  ignored: string[]
  used: string[]
  /** Whether some folder held more files than the walk read. */
  capped: boolean
}

/**
 * Summarise what a plan would import.
 *
 * @param dir - the folder scanned.
 * @param plan - the plan built from it.
 * @param existing - chapter numbers already in the book.
 * @param used - directories that supplied the files.
 * @param capped - whether a folder held more files than the walk read.
 * @returns the numbers the panel and the report both show.
 */
export function summarize(
  dir: string,
  plan: ImportPlan,
  existing: ReadonlySet<number>,
  used: readonly string[],
  capped = false,
): ScanSummary {
  return {
    dir,
    chapters: plan.chapters.length,
    words: plan.chapters.reduce((sum, chapter) => sum + chapter.words, 0),
    cast: plan.cast.length,
    volumes: plan.volumes.length,
    plans: plan.plans.length,
    premise: plan.premise,
    conflicts: plan.chapters
      .map((chapter) => chapter.number)
      .filter((number) => existing.has(number)),
    voiceless: plan.cast
      .filter((entry) => entry.card.voice.trim() === '')
      .map((entry) => entry.card.name),
    ignored: [...plan.ignored],
    used: [...used],
    capped,
  }
}

/**
 * Render a scan as prose.
 *
 * @param summary - what was found.
 * @param root - the book it would go into, when there is one.
 * @returns the report body.
 */
export function describeScan(summary: ScanSummary, root: string | undefined): string {
  if (summary.chapters === 0 && summary.cast === 0 && summary.volumes === 0) {
    return [
      `这个文件夹里没找到能导入的东西：${summary.dir}`,
      '看过这些位置：正文/（或 chapters/）、人物/（或 canon/）、大纲/全书大纲.md。',
      '如果稿子在别处，把 dir 指向装着它们的那个文件夹。',
    ].join('\n')
  }
  const lines = [`扫了一遍，还没写任何文件：${summary.dir}`]
  if (root !== undefined) lines.push(`会写进：${root}`)
  lines.push(
    `正文：${summary.chapters} 章，共 ${wordsText(summary.words)}`,
    `人物：${summary.cast} 张角色卡`,
    `大纲：${summary.volumes} 卷，${summary.plans} 条章纲`,
  )
  if (summary.premise !== '') {
    const premise = summary.premise.length > 60 ? `${summary.premise.slice(0, 60)}…` : summary.premise
    lines.push(`一句话立意：${premise}`)
  }
  if (summary.chapters > 0) {
    lines.push('章号按文件名里的「第N章」排；同一章有两份时取更长的那份。')
  }
  if (summary.voiceless.length > 0) {
    const head = summary.voiceless.slice(0, 4).join('、')
    lines.push(
      `说话方式还空着：${head}${summary.voiceless.length > 4 ? ' 等' : ''}（${summary.voiceless.length} 张卡）。人物稿里没写这一项时留着空——补齐才能推进到「大纲」阶段，闸门会拦。`,
    )
  }
  if (summary.conflicts.length > 0) {
    const head = summary.conflicts.slice(0, 8).join('、')
    lines.push(
      `本书已有的章：${summary.conflicts.length} 章（第 ${head}${summary.conflicts.length > 8 ? ' …' : ''}）。默认不覆盖，要覆盖得明确说 overwrite=true。`,
    )
  }
  if (summary.ignored.length > 0) {
    lines.push(
      `没写章号、跳过：${summary.ignored.length} 个（${summary.ignored.slice(0, 3).join('、')}${summary.ignored.length > 3 ? ' …' : ''}）`,
    )
  }
  if (summary.capped) {
    lines.push(`文件夹里的文件太多，只读了前 ${MAX_FILES} 个；后面那些没进这份计划。`)
  }
  lines.push('apply 就照这个写。')
  return lines.join('\n')
}
