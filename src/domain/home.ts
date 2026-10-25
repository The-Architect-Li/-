/**
 * Where this dsh keeps its own state.
 *
 * Two things in this plugin live outside any book: the shelf of books the panel
 * has seen, and the book each conversation is currently working on. Both are
 * properties of this machine and this dsh install, not of one workspace, so they
 * sit under `$DSH_HOME` the way dsh's own state does. `DSH_HOME` is honoured
 * because dsh itself honours it — a test can point it at a temp directory and
 * never touch the writer's real shelf.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * dsh's state directory.
 *
 * @returns `$DSH_HOME` when set, else `~/.dsh`.
 */
export function dshHome(): string {
  const override = process.env.DSH_HOME?.trim()
  return override !== undefined && override !== '' ? resolve(override) : join(homedir(), '.dsh')
}

/**
 * This plugin's own slice of that state directory.
 *
 * @returns an absolute path; the directory may not exist yet.
 */
export function inkwellStateDir(): string {
  return join(dshHome(), 'inkwell')
}

/**
 * Normalise a project root so two spellings of one book collide.
 *
 * Windows treats `D:\novels\雾港` and `d:\Novels\雾港` as one directory, so a
 * shelf keyed on the raw string would list the same book twice.
 *
 * @param root - any absolute path.
 * @returns the resolved path, lowercased on Windows.
 */
export function bookKey(root: string): string {
  const resolved = resolve(root)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
