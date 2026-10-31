/**
 * The book's own skill notes: how *this* book wants to be written.
 *
 * Every book needs a different hand. One wants short sentences and no
 * adjectives; another wants long breathless paragraphs. That knowledge is not
 * canon (it is not a fact about the world), and it is not a chapter plan (it does
 * not belong to one chapter) — it used to live in the author's head, or in a
 * prompt they retyped every session.
 *
 * Notes are plain Markdown under `<root>/skills/`, one file per note, so they can
 * be read in any editor, versioned with the book, and quoted by the model.
 * `recordHistory` keeps the last few versions of each note, because "I rewrote my
 * hook rules and lost the good one" is the same failure as any other overwrite.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { recordHistory } from './history.ts'

/** Folder inside a project that holds the notes. */
export const SKILLS_DIR = 'skills'

/** A note longer than this is a draft of the novel, not a rule of thumb. */
export const SKILL_MAX_CHARS = 20_000

/** Long enough for 「开篇三句之内必须有问题」, short enough for a file name. */
export const SKILL_NAME_MAX = 40

/** One note as the tree and the tool list it. */
export interface SkillNote {
  name: string
  title: string
  chars: number
}

/** One note as the context pack quotes it: a title and the head of the body. */
export interface SkillExcerpt {
  name: string
  title: string
  text: string
}

/** Strip anything that would change which file we are talking about. */
export function normaliseSkillName(raw: string): string {
  const clean = String(raw ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, SKILL_NAME_MAX)
  if (clean === '') throw new Error('技能名不能为空。')
  return clean
}

/** Absolute path of one note. */
export function skillPath(root: string, name: string): string {
  return join(root, SKILLS_DIR, `${normaliseSkillName(name)}.md`)
}

/** Title is the first `# ` heading; falling back to the file name keeps the tree readable. */
function titleOf(name: string, text: string): string {
  const heading = text.split(/\r?\n/).find((line) => line.trim().startsWith('# '))
  return heading === undefined ? name : heading.replace(/^#\s*/, '').trim() || name
}

/** Every note, ordered by name. Missing folder means "none yet", not an error. */
export async function listSkills(root: string): Promise<SkillNote[]> {
  const dir = join(root, SKILLS_DIR)
  const files = (await readdir(dir).catch(() => [] as string[])).filter((file) => file.endsWith('.md'))
  const out: SkillNote[] = []
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8').catch(() => '')
    const name = file.replace(/\.md$/, '')
    out.push({ name, title: titleOf(name, text), chars: text.length })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/** One note's body, or `undefined` when it does not exist. */
export async function readSkill(root: string, name: string): Promise<string | undefined> {
  return readFile(skillPath(root, name), 'utf8').catch(() => undefined)
}

/**
 * Write one note, keeping the previous version in history first.
 *
 * @param root - project directory.
 * @param name - note name; normalised, so `开篇 钩子` and `开篇-钩子` are different files.
 * @param text - the whole note.
 * @returns the note as listed.
 * @throws when the text exceeds {@link SKILL_MAX_CHARS}.
 */
export async function writeSkill(root: string, name: string, text: string): Promise<SkillNote> {
  const clean = normaliseSkillName(name)
  const body = String(text ?? '')
  if (body.length > SKILL_MAX_CHARS) {
    throw new Error(`这一篇有 ${body.length} 字，超过单篇上限 ${SKILL_MAX_CHARS}。拆成两篇，或者把例子删掉一些。`)
  }
  const file = skillPath(root, clean)
  const before = await readFile(file, 'utf8').catch(() => '')
  if (before.trim() !== '' && before !== body) await recordHistory(root, 'skill', clean, before)

  await mkdir(join(root, SKILLS_DIR), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, body, 'utf8')
  await rename(temp, file)
  return { name: clean, title: titleOf(clean, body), chars: body.length }
}

/**
 * Every note, trimmed to a readable head, for the context pack.
 *
 * A note is a rule, not a chapter: the head is where the rule is stated, and
 * the rest is usually examples. Six hundred characters is enough to carry
 * "第一句必须留一个问题" and the two lines that qualify it, and it keeps six
 * notes inside a budget that also has to hold the cast and the contract.
 *
 * @param root - project directory.
 * @param perNote - characters kept from each note.
 * @returns one excerpt per note, in list order.
 */
export async function skillExcerpts(root: string, perNote = 600): Promise<SkillExcerpt[]> {
  const notes = await listSkills(root)
  const out: SkillExcerpt[] = []
  for (const note of notes) {
    const text = (await readSkill(root, note.name)) ?? ''
    const body = text.replace(/^#\s.*(\r?\n)?/, '').trim()
    out.push({
      name: note.name,
      title: note.title,
      text: body.length > perNote ? `${body.slice(0, perNote)}…` : body,
    })
  }
  return out
}

/** Delete one note. Returns whether there was one to delete. */
export async function deleteSkill(root: string, name: string): Promise<boolean> {
  const file = skillPath(root, name)
  const before = await readFile(file, 'utf8').catch(() => undefined)
  if (before === undefined) return false
  await recordHistory(root, 'skill', normaliseSkillName(name), before)
  await rm(file, { force: true })
  return true
}
