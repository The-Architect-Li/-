/** Per-session project scoping: which book a call is about. */
import { isAbsolute, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/domain/store.ts'
import { resolveRoot, resolveSessionRoot, sessionCwdById, sessionCwdOf } from '../src/domain/scope.ts'
import { resolveConfig } from '../src/config.ts'

/** Wrap a cwd the way a real tool execution context would carry it. */
function execWithCwd(cwd: string | undefined): unknown {
  return { agent: { session: { id: 's-1', header: { cwd } } } }
}

describe('sessionCwdOf', () => {
  it('reads the cwd a session recorded', () => {
    expect(sessionCwdOf(execWithCwd('C:/books/one'))).toBe('C:/books/one')
  })

  it('returns undefined when the host reports no cwd', () => {
    expect(sessionCwdOf(execWithCwd(undefined))).toBeUndefined()
  })

  it('returns undefined when there is no agent at all', () => {
    expect(sessionCwdOf({})).toBeUndefined()
    expect(sessionCwdOf(null)).toBeUndefined()
    expect(sessionCwdOf('nonsense')).toBeUndefined()
  })

  it('ignores an empty or blank cwd', () => {
    expect(sessionCwdOf(execWithCwd(''))).toBeUndefined()
    expect(sessionCwdOf(execWithCwd('   '))).toBeUndefined()
  })

  it('ignores a non-string cwd', () => {
    expect(sessionCwdOf({ agent: { session: { header: { cwd: 42 } } } })).toBeUndefined()
  })
})

describe('sessionCwdById', () => {
  /** A host context whose `sessions` service knows one session. */
  function hostWithSessions(): unknown {
    const sessions = new Map([['s-1', { header: { cwd: 'C:/books/one' } }], ['s-2', { header: {} }]])
    return { get: (name: string) => (name === 'sessions' ? { get: (id: string) => sessions.get(id) } : undefined) }
  }

  it('reads the cwd of the session the browser named', () => {
    expect(sessionCwdById(hostWithSessions(), 's-1')).toBe('C:/books/one')
  })

  it('returns undefined for an unknown session', () => {
    expect(sessionCwdById(hostWithSessions(), 's-nope')).toBeUndefined()
  })

  it('returns undefined when the session recorded no cwd', () => {
    expect(sessionCwdById(hostWithSessions(), 's-2')).toBeUndefined()
  })

  it('returns undefined when the host exposes no sessions service', () => {
    expect(sessionCwdById({ get: () => undefined }, 's-1')).toBeUndefined()
    expect(sessionCwdById({}, 's-1')).toBeUndefined()
    expect(sessionCwdById(null, 's-1')).toBeUndefined()
  })
})

describe('resolveRoot', () => {
  it('resolves a relative root under the session cwd', () => {
    const resolved = resolveRoot('.novel', 'C:/books/one')
    expect(isAbsolute(resolved)).toBe(true)
    expect(resolved).toBe(resolve('C:/books/one', '.novel'))
  })

  it('leaves an absolute root alone whatever the session', () => {
    const root = resolve('/fixed/inkwell')
    const a = resolveRoot(root, 'C:/books/one')
    const b = resolveRoot(root, 'C:/books/two')
    expect(a).toBe(b)
    expect(a).toBe(root)
  })

  it('falls back to the process directory when the session has no cwd', () => {
    expect(resolveRoot('.novel', undefined)).toBe(resolve('.novel'))
  })
})

describe('resolveSessionRoot', () => {
  const baseStore = new ProjectStore(resolve('/tmp/shared'))

  it('shares one store while perWorkspace is off', () => {
    const config = resolveConfig({ perWorkspace: false })
    expect(resolveSessionRoot(execWithCwd('C:/books/one'), config, baseStore)).toBe(baseStore)
  })

  it('gives each session its own book when perWorkspace is on', () => {
    const config = resolveConfig({ perWorkspace: true })
    const one = resolveSessionRoot(execWithCwd('C:/books/one'), config, baseStore)
    const two = resolveSessionRoot(execWithCwd('C:/books/two'), config, baseStore)
    expect(one.root).toBe(resolve('C:/books/one', '.novel'))
    expect(two.root).toBe(resolve('C:/books/two', '.novel'))
    expect(one.root).not.toBe(two.root)
  })

  it('keeps the same store for two sessions in the same workspace', () => {
    const config = resolveConfig({ perWorkspace: true })
    const one = resolveSessionRoot(execWithCwd('C:/books/one'), config, baseStore)
    const again = resolveSessionRoot(execWithCwd('C:/books/one'), config, baseStore)
    expect(again.root).toBe(one.root)
  })

  it('shares the base store for a session that reports no cwd', () => {
    const config = resolveConfig({ perWorkspace: true })
    expect(resolveSessionRoot(execWithCwd(undefined), config, baseStore)).toBe(baseStore)
  })

  it('shares the base store for an absolute root even with perWorkspace on', () => {
    const config = resolveConfig({ perWorkspace: true, root: resolve('/fixed/inkwell') })
    expect(resolveSessionRoot(execWithCwd('C:/books/one'), config, baseStore)).toBe(baseStore)
  })
})
