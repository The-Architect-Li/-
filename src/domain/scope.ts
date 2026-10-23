/**
 * Which book a call is about.
 *
 * A dsh process serves several workspaces and several sessions at once. The
 * plugin used to resolve `root` once, at apply time, against the process's
 * working directory — so a second book silently shared the first one's canon.
 * This module keeps that decision here instead: pure path math on a session's
 * recorded `cwd`, with no Cordis and no IO, so it can be unit-tested directly.
 *
 * `perWorkspace` is on by default, because one book per workspace is what a
 * relative `.novel` root has to mean for a process that serves many of them.
 * An absolute root still pins one book for every session; setting
 * `perWorkspace: false` restores the v0.2 "one book at the process directory"
 * behaviour for anyone who was relying on it.
 */
import { isAbsolute, resolve } from 'node:path'
import { ProjectStore } from './store.ts'
import type { InkwellConfig } from './types.ts'

/**
 * Read a session's working directory out of a tool execution context.
 *
 * The context is `unknown` on purpose: `dsh-tools` types it as `ToolRunContext`
 * but this plug-in must also survive a call from a fake host in tests. Every
 * step is guarded, and a missing or non-string `cwd` yields `undefined`.
 *
 * @param exec - whatever the host passed as the execution context.
 * @returns the session's absolute cwd, when the host reported one.
 */
export function sessionCwdOf(exec: unknown): string | undefined {
  if (typeof exec !== 'object' || exec === null) return undefined
  const agent = (exec as { agent?: unknown }).agent
  if (typeof agent !== 'object' || agent === null) return undefined
  const session = (agent as { session?: unknown }).session
  if (typeof session !== 'object' || session === null) return undefined
  const header = (session as { header?: unknown }).header
  if (typeof header !== 'object' || header === null) return undefined
  const cwd = (header as { cwd?: unknown }).cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') return undefined
  return cwd
}

/**
 * Resolve a configured `root` against a session's cwd.
 *
 * An absolute root is used as-is: one book, one path, whatever the session. A
 * relative root lands under the session's own workspace.
 *
 * @param root - the configured project directory.
 * @param cwd - the session's working directory, when known.
 * @returns the absolute project directory.
 */
export function resolveRoot(root: string, cwd: string | undefined): string {
  if (isAbsolute(root)) return resolve(root)
  if (cwd === undefined) return resolve(root)
  return resolve(cwd, root)
}

/**
 * Look a session's cwd up by id, for callers that hold no execution context.
 *
 * The panel's HTTP route is one such caller: the browser names a session, not
 * an agent. Every step is guarded so a host without a session service (or a
 * test fake) simply yields `undefined`, which the caller treats as "use the
 * shared book".
 *
 * @param ctx - the host context, consulted for a `sessions` service.
 * @param sessionId - the session the request names.
 * @returns that session's absolute cwd, when known.
 */
export function sessionCwdById(ctx: unknown, sessionId: string): string | undefined {
  if (typeof ctx !== 'object' || ctx === null) return undefined
  const get = (ctx as { get?: unknown }).get
  if (typeof get !== 'function') return undefined
  const sessions = (get as (name: string) => unknown).call(ctx, 'sessions')
  if (typeof sessions !== 'object' || sessions === null) return undefined
  const lookup = (sessions as { get?: unknown }).get
  if (typeof lookup !== 'function') return undefined
  const session = (lookup as (id: string) => unknown).call(sessions, sessionId)
  if (typeof session !== 'object' || session === null) return undefined
  const header = (session as { header?: unknown }).header
  if (typeof header !== 'object' || header === null) return undefined
  const cwd = (header as { cwd?: unknown }).cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') return undefined
  return cwd
}

/**
 * Pick the store one call should use.
 *
 * With `perWorkspace` on (the default), a relative root is resolved against the
 * calling session's own cwd. An absolute root still means one book everywhere,
 * and `perWorkspace: false` restores the v0.2 behaviour of one book at the
 * process directory. Sessions that report no cwd fall back to that shared store
 * instead of guessing — a wrong book is worse than a shared one.
 *
 * @param exec - the tool execution context.
 * @param config - resolved plugin configuration.
 * @param baseStore - the process-wide store built at apply time.
 * @returns the store to use for this call.
 */
export function resolveSessionRoot(
  exec: unknown,
  config: InkwellConfig,
  baseStore: ProjectStore,
): ProjectStore {
  if (!config.perWorkspace) return baseStore
  if (isAbsolute(config.root)) return baseStore
  const cwd = sessionCwdOf(exec)
  if (cwd === undefined) return baseStore
  return new ProjectStore(resolveRoot(config.root, cwd))
}
