/**
 * Two books in one process.
 *
 * The v0.2 store resolved `root` once, at apply time, so a second workspace
 * silently read the first book's canon. These tests live in the harness — they
 * call the real tools through the real gate — because the bug was in the
 * wiring, not in any single function.
 *
 * A relative root is the case that matters: it is the default (`.novel`), and
 * it is the one that has to land under whichever workspace is asking. An
 * absolute root deliberately pins a single book, so the harness's default temp
 * root cannot exercise this path.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from './helpers.ts'

const PREMISE = '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。'.repeat(4)

/** Two scratch directories standing in for two workspaces. */
async function twoWorkspaces(): Promise<{ one: string; two: string; cleanup: () => Promise<void> }> {
  const one = await mkdtemp(join(tmpdir(), 'inkwell-ws-a-'))
  const two = await mkdtemp(join(tmpdir(), 'inkwell-ws-b-'))
  return {
    one,
    two,
    cleanup: async () => {
      await rm(one, { recursive: true, force: true })
      await rm(two, { recursive: true, force: true })
    },
  }
}

/** Read one book's stored project record. */
async function projectAt(directory: string): Promise<{ title: string; premise: string }> {
  const raw = await readFile(join(directory, 'project.json'), 'utf8')
  return JSON.parse(raw) as { title: string; premise: string }
}

describe('per-workspace projects', () => {
  const cleanups: Array<() => Promise<void>> = []
  let harness: Harness | undefined

  afterEach(async () => {
    if (harness) await harness.cleanup()
    harness = undefined
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  it('keeps two workspaces apart', async () => {
    const spaces = await twoWorkspaces()
    cleanups.push(spaces.cleanup)
    harness = await createHarness({ root: '.novel' })

    expect((await harness.call('novel_project', { action: 'init', title: '甲书' }, { cwd: spaces.one })).ok).toBe(true)
    expect((await harness.call('novel_project', { action: 'init', title: '乙书' }, { cwd: spaces.two })).ok).toBe(true)

    const inOne = await harness.call('novel_project', { action: 'status' }, { cwd: spaces.one })
    const inTwo = await harness.call('novel_project', { action: 'status' }, { cwd: spaces.two })
    expect((inOne as { value: { title: string } }).value.title).toBe('甲书')
    expect((inTwo as { value: { title: string } }).value.title).toBe('乙书')

    expect((await projectAt(join(spaces.one, '.novel'))).title).toBe('甲书')
    expect((await projectAt(join(spaces.two, '.novel'))).title).toBe('乙书')
  })

  it('writes each book under its own workspace directory', async () => {
    const spaces = await twoWorkspaces()
    cleanups.push(spaces.cleanup)
    harness = await createHarness({ root: '.novel' })

    await harness.call('novel_project', { action: 'init', title: '甲书' }, { cwd: spaces.one })
    await harness.call('novel_project', { action: 'premise', premise: PREMISE }, { cwd: spaces.one })
    expect((await projectAt(join(spaces.one, '.novel'))).premise).toBe(PREMISE)

    await harness.call('novel_project', { action: 'init', title: '乙书' }, { cwd: spaces.two })
    // The second book must not inherit the first one's premise.
    expect((await projectAt(join(spaces.two, '.novel'))).premise).toBe('')
  })

  it('creates the project directory only in the calling workspace', async () => {
    const spaces = await twoWorkspaces()
    cleanups.push(spaces.cleanup)
    harness = await createHarness({ root: '.novel' })

    await harness.call('novel_project', { action: 'init', title: '甲书' }, { cwd: spaces.one })
    expect(await readdir(spaces.one)).toContain('.novel')
    expect(await readdir(spaces.two)).not.toContain('.novel')
  })

  it('pins a single book for every session when root is absolute', async () => {
    const spaces = await twoWorkspaces()
    cleanups.push(spaces.cleanup)
    // The harness temp root is absolute: that is the "one book, one path" case.
    harness = await createHarness()

    await harness.call('novel_project', { action: 'init', title: '共享书' }, { cwd: spaces.one })
    const fromOther = await harness.call('novel_project', { action: 'status' }, { cwd: spaces.two })
    expect(fromOther.ok).toBe(true)
    expect((fromOther as { value: { title: string } }).value.title).toBe('共享书')
    expect(await projectAt(harness.root)).toMatchObject({ title: '共享书' })
  })

  it('restores the v0.2 shared book when perWorkspace is off', async () => {
    const spaces = await twoWorkspaces()
    cleanups.push(spaces.cleanup)
    harness = await createHarness({ perWorkspace: false })

    // Two sessions, two workspaces, one book: the v0.2 behaviour, on purpose.
    // (The "resolves against the process directory" half is a pure-function
    // assertion in test/scope.test.ts; doing it here would write outside the
    // harness's temp root.)
    await harness.call('novel_project', { action: 'init', title: '共享书' }, { cwd: spaces.one })
    const fromOther = await harness.call('novel_project', { action: 'status' }, { cwd: spaces.two })
    expect(fromOther.ok).toBe(true)
    expect((fromOther as { value: { title: string } }).value.title).toBe('共享书')

    expect((await projectAt(harness.root)).title).toBe('共享书')
    expect(await readdir(spaces.one)).not.toContain('.novel')
    expect(await readdir(spaces.two)).not.toContain('.novel')
  })

  it('gates a call against the book the calling session owns', async () => {
    const spaces = await twoWorkspaces()
    cleanups.push(spaces.cleanup)
    harness = await createHarness({ root: '.novel' })

    // A project exists in workspace one only.
    await harness.call('novel_project', { action: 'init', title: '甲书' }, { cwd: spaces.one })

    const denied = await harness.call('novel_project', { action: 'status' }, { cwd: spaces.two })
    expect(denied.ok).toBe(false)
    const error = (denied as { error: string }).error
    expect(error).toContain('还没有 Inkwell 项目')
    // The refusal names the directory it looked in, so the user can see why.
    expect(error).toContain(join(spaces.two, '.novel'))
  })
})
