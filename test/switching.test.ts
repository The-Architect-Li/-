/**
 * Switching books inside one conversation.
 *
 * The point of a pin is that it survives: a writer says "open 雾港" once and the
 * next twenty tool calls are about that book, whether or not they get a new turn
 * in between. So these tests go through the real harness, not the pin helpers.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/domain/store.ts'
import { createHarness, valueOf, type Harness } from './helpers.ts'

let stateHome: string
let harness: Harness
let otherRoot: string

beforeAll(async () => {
  stateHome = await mkdtemp(join(tmpdir(), 'inkwell-switch-home-'))
  process.env.DSH_HOME = stateHome
  harness = await createHarness()
  // A second book that this session was never in: the case the pin exists for.
  otherRoot = join(await mkdtemp(join(tmpdir(), 'inkwell-other-')), '.novel')
  await new ProjectStore(otherRoot).init('雾港', 120000)
})

afterAll(async () => {
  delete process.env.DSH_HOME
  await harness.cleanup()
  await rm(stateHome, { recursive: true, force: true })
  await rm(join(otherRoot, '..'), { recursive: true, force: true })
})

describe('novel_project books / open / close', () => {
  it('lists the book this session is in without one existing yet', async () => {
    // Before init there is no book at all, and `books` must still answer: it is
    // the tool you reach for when you do not know where you are.
    const value = await valueOf<{ report: string }>(
      await harness.call('novel_project', { action: 'books' }),
    )
    expect(value.report).toContain('还没有书')
  })

  it('starts a book, then lists it as the current one', async () => {
    await valueOf(await harness.call('novel_project', { action: 'init', title: '甲书' }))
    const value = await valueOf<{ report: string }>(
      await harness.call('novel_project', { action: 'books' }),
    )
    expect(value.report).toContain('甲书')
    expect(value.report).toContain('这个会话在看它')
  })

  it('switches to another book by path and keeps it switched', async () => {
    const switched = await valueOf<{ title: string; report: string }>(
      await harness.call('novel_project', { action: 'open', root: otherRoot }),
    )
    expect(switched.title).toBe('雾港')
    expect(switched.report).toContain('已切到《雾港》')

    // A later call with no root must read the pinned book, not the workspace one.
    const snap = await valueOf<{ title: string }>(
      await harness.call('novel_project', { action: 'status' }),
    )
    expect(snap.title).toBe('雾港')
  })

  it('accepts the directory that contains the project', async () => {
    const parent = join(otherRoot, '..')
    const value = await valueOf<{ title: string }>(
      await harness.call('novel_project', { action: 'open', root: parent }),
    )
    expect(value.title).toBe('雾港')
  })

  it('finds a book by a fragment of its title', async () => {
    const value = await valueOf<{ title: string }>(
      await harness.call('novel_project', { action: 'open', book: '雾' }),
    )
    expect(value.title).toBe('雾港')
  })

  it('puts an opened book on the shelf so it is listable afterwards', async () => {
    const value = await valueOf<{ report: string }>(
      await harness.call('novel_project', { action: 'books' }),
    )
    expect(value.report).toContain('雾港')
    expect(value.report).toContain(otherRoot)
    expect(value.report).toContain('甲书')
  })

  it('refuses a directory with no book in it', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'inkwell-empty-'))
    const result = await harness.call('novel_project', { action: 'open', root: empty })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('没找到带 project.json 的目录')
    await rm(empty, { recursive: true, force: true })
  })

  it('refuses a title nobody has', async () => {
    const result = await harness.call('novel_project', { action: 'open', book: '不存在的书' })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('没有书名包含')
  })

  it('asks for one of root or book rather than guessing', async () => {
    const result = await harness.call('novel_project', { action: 'open' })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('open 需要 root 或 book')
  })

  it('closes back to the workspace book', async () => {
    const value = await valueOf<{ title: string; report: string }>(
      await harness.call('novel_project', { action: 'close' }),
    )
    expect(value.title).toBe('甲书')
    expect(value.report).toContain('已取消指定书')
  })

  it('scopes a pin to its own session', async () => {
    await valueOf(
      await harness.call('novel_project', { action: 'open', root: otherRoot }, { sessionId: 's-a' }),
    )
    // The harness re-uses one session id per call, so ask as another session.
    const other = await valueOf<{ title: string }>(
      await harness.call('novel_project', { action: 'status' }, { sessionId: 's-b' }),
    )
    expect(other.title).toBe('甲书')
    const pinned = await valueOf<{ title: string }>(
      await harness.call('novel_project', { action: 'status' }, { sessionId: 's-a' }),
    )
    expect(pinned.title).toBe('雾港')
  })
})
