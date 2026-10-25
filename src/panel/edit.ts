/**
 * What the panel may change, and how much of it.
 *
 * Every write door validates here first, so a malformed body is a 400 with a
 * sentence a writer can act on, never a half-applied store update. The limits
 * are deliberately generous but finite: a paste of two megabytes into a voice
 * field is a mistake, not a style.
 */
import { CHARACTER_ROLES, type CharacterRole } from '../domain/types.ts'
import { PanelInputError } from './dirs.ts'

/** Longest a free-text canon field may be. */
export const MAX_FIELD_CHARS = 4000

/** Longest a chapter body may be, in characters. */
export const MAX_CHAPTER_CHARS = 200_000

/** Longest a chapter title or one-line summary may be. */
export const MAX_TITLE_CHARS = 120

function readText(body: Record<string, unknown>, key: string, limit: number, label: string): string | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new PanelInputError(`${label} 必须是字符串。`)
  const trimmed = value.trim()
  if (trimmed.length > limit) throw new PanelInputError(`${label} 太长了（上限 ${limit} 字）。`)
  return trimmed
}

/** A validated character-card patch: every field optional, omit to keep. */
export interface CharacterPatch {
  name: string
  role?: CharacterRole | undefined
  voice?: string | undefined
  appearance?: string | undefined
  goal?: string | undefined
  secret?: string | undefined
}

/**
 * Validate a character edit.
 *
 * The name is the key, not a field: renaming here would write a second card and
 * leave the first one behind, so the panel edits a character in place and a
 * rename stays a job for `novel_canon`.
 *
 * @param key - the character's current name, from the route.
 * @param body - the submitted fields.
 * @returns the patch to apply.
 * @throws {PanelInputError} when a field is the wrong type or too long.
 */
export function readCharacterPatch(key: string, body: Record<string, unknown>): CharacterPatch {
  const patch: CharacterPatch = { name: key }
  const rawRole = body.role
  if (rawRole !== undefined) {
    if (typeof rawRole !== 'string' || !(CHARACTER_ROLES as readonly string[]).includes(rawRole)) {
      throw new PanelInputError(`role 只能是 ${CHARACTER_ROLES.join('／')}。`)
    }
    patch.role = rawRole as CharacterRole
  }
  patch.voice = readText(body, 'voice', MAX_FIELD_CHARS, '说话方式')
  patch.appearance = readText(body, 'appearance', MAX_FIELD_CHARS, '外形')
  patch.goal = readText(body, 'goal', MAX_FIELD_CHARS, '目标')
  patch.secret = readText(body, 'secret', MAX_FIELD_CHARS, '秘密')
  return patch
}

/** A validated world-entry patch. */
export interface WorldPatch {
  name: string
  kind?: string | undefined
  detail?: string | undefined
}

/**
 * Validate a world-entry edit.
 *
 * @param key - the entry's current name, from the route.
 * @param body - the submitted fields.
 * @returns the patch to apply.
 * @throws {PanelInputError} when a field is the wrong type or too long.
 */
export function readWorldPatch(key: string, body: Record<string, unknown>): WorldPatch {
  const patch: WorldPatch = { name: key }
  patch.kind = readText(body, 'kind', MAX_TITLE_CHARS, '设定类型')
  patch.detail = readText(body, 'detail', MAX_FIELD_CHARS, '设定内容')
  return patch
}

/** A validated chapter patch. */
export interface ChapterPatch {
  number: number
  text: string
  title?: string | undefined
  summary?: string | undefined
  /**
   * The revision the editor was looking at, when it said.
   *
   * The panel and a chat turn can be editing the same chapter at once. The
   * store compares this against what is on disk and refuses a stale write, so
   * one of the two gets a "reload" instead of silently losing their words.
   */
  revision?: number | undefined
}

/**
 * Validate a chapter body.
 *
 * An empty body is refused here rather than saved as a stub: a chapter with no
 * words would count as written in the outline's eye and quietly satisfy the
 * review gate.
 *
 * @param key - the chapter number as it came in the route.
 * @param body - the submitted fields.
 * @returns the body to save.
 * @throws {PanelInputError} for a bad number, an empty body, or an oversized one.
 */
export function readChapterPatch(key: string, body: Record<string, unknown>): ChapterPatch {
  const number = Number(key)
  if (!Number.isInteger(number) || number < 1) throw new PanelInputError('章号必须是正整数。')
  const text = readText(body, 'text', MAX_CHAPTER_CHARS, '正文')
  if (text === undefined) throw new PanelInputError('缺少 text：正文不能为空。')
  if (text === '') throw new PanelInputError('正文不能为空。')
  const revision = body.revision === undefined ? undefined : Number(body.revision)
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) {
    throw new PanelInputError('revision 必须是正整数（页面打开时那一版的版本号）。')
  }
  return {
    number,
    text,
    title: readText(body, 'title', MAX_TITLE_CHARS, '标题'),
    summary: readText(body, 'summary', MAX_FIELD_CHARS, '摘要'),
    revision,
  }
}
