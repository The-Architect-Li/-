/**
 * Directory browsing for the panel's "new book" flow.
 *
 * The panel lets a writer create a book anywhere on disk, so it needs one
 * thing the browser cannot do: list a directory. This module is that, and
 * only that — one level at a time, directories only, absolute paths only.
 *
 * Why not `ctx.directoryPicker`: that seam is optional (a host may load
 * neither backend), and the browse capability it exposes would still need a
 * route and a UI. A bounded `readdir` is smaller than the coupling, works for
 * a remote browser (no OS dialog on the host display), and stays testable.
 *
 * Absolute-path enforcement mirrors the picker seam for the same reason: a
 * relative value must never resolve against the host's own working directory.
 */
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, parse, resolve } from 'node:path'

/** One directory a writer can enter. */
export interface DirEntry {
  name: string
  path: string
}

/** One level of the filesystem, as the picker draws it. */
export interface DirListing {
  /** The absolute directory that was listed. */
  path: string
  /** Its own name, for the picker's title. */
  name: string
  /** Parent directory, or `null` at a filesystem root. */
  parent: string | null
  /** Child directories, name-sorted. */
  entries: DirEntry[]
  /** Places to jump to when `parent` is null: drive letters, or `/`. */
  roots: string[]
  /** True when the level had more entries than the response carries. */
  truncated: boolean
  /**
   * A book that already lives in this directory, if one does.
   *
   * Filled by the route, not here: finding a book means knowing the
   * configured project directory name, which is configuration, not something
   * a directory walk should guess.
   */
  book?: { title: string; phase: string; root: string } | null
}

/** A refused request, with the operator-facing reason. */
export class PanelInputError extends Error {
  readonly status: number

  /**
   * @param message - why the input was refused.
   * @param status - HTTP status to answer with.
   */
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/** Entries per level before the listing is cut. */
const MAX_ENTRIES = 300

/**
 * Places to jump to at a filesystem root.
 *
 * On Windows that is every drive letter that exists, so a book on `E:` is
 * reachable from a picker that started in the home directory.
 *
 * @returns absolute root paths, drive-sorted.
 */
async function filesystemRoots(): Promise<string[]> {
  if (process.platform !== 'win32') return ['/']
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  const found = await Promise.all(
    letters.map(async (letter) => {
      const path = `${letter}:\\`
      try {
        const info = await stat(path)
        return info.isDirectory() ? path : null
      } catch {
        return null
      }
    }),
  )
  return found.filter((path): path is string => path !== null)
}

/**
 * Resolve the directory a request asks to list.
 *
 * @param requested - the raw `path` query parameter, possibly absent.
 * @returns the absolute directory to list.
 * @throws {PanelInputError} when the value is relative.
 */
export function resolveListedPath(requested: string | undefined): string {
  if (requested === undefined || requested.trim() === '') return resolve(homedir())
  if (!isAbsolute(requested)) {
    throw new PanelInputError('目录必须是绝对路径（例如 E:\\小说）。')
  }
  return resolve(requested)
}

/**
 * List one directory level.
 *
 * @param requested - absolute directory to list; absent lists the home directory.
 * @returns the level, its children, and where to go from here.
 * @throws {PanelInputError} for a relative path, a missing directory, or a file.
 */
export async function listDirectories(requested: string | undefined): Promise<DirListing> {
  const path = resolveListedPath(requested)
  let info
  try {
    info = await stat(path)
  } catch {
    throw new PanelInputError(`目录不存在：${path}`, 404)
  }
  if (!info.isDirectory()) throw new PanelInputError(`这不是一个目录：${path}`)

  let names: string[] = []
  try {
    const entries = await readdir(path, { withFileTypes: true })
    names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    throw new PanelInputError(`目录无法读取（权限不足）：${path}`, 403)
  }

  names.sort((a, b) => a.localeCompare(b, 'zh-CN'))
  const truncated = names.length > MAX_ENTRIES
  const kept = names.slice(0, MAX_ENTRIES)
  const parent = dirname(path)
  const atRoot = parent === path || parse(path).root === path

  return {
    path,
    name: parse(path).base || path,
    parent: atRoot ? null : parent,
    entries: kept.map((name) => ({ name, path: resolve(path, name) })),
    roots: atRoot ? await filesystemRoots() : [],
    truncated,
  }
}

/**
 * Validate a directory a writer chose for a new book.
 *
 * @param dir - the raw value from the panel.
 * @returns the absolute, existing directory.
 * @throws {PanelInputError} when it is relative, missing, or not a directory.
 */
export async function requireDirectory(dir: unknown): Promise<string> {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new PanelInputError('请选择一个目录。')
  }
  if (!isAbsolute(dir)) {
    throw new PanelInputError('目录必须是绝对路径（例如 E:\\小说）。')
  }
  const path = resolve(dir)
  let info
  try {
    info = await stat(path)
  } catch {
    throw new PanelInputError(`目录不存在：${path}`, 404)
  }
  if (!info.isDirectory()) throw new PanelInputError(`这不是一个目录：${path}`)
  return path
}
