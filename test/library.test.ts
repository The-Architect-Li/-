/**
 * The shelf: remembering which directories are books.
 *
 * Tested against a real temporary file rather than a mock: the shelf's whole job
 * is to survive a restart, and a mock would not prove that.
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/domain/store.ts'
import { describeBook, MAX_SHELF, readShelf, rememberBook, writeShelf } from '../src/panel/library.ts'

let space: string

beforeEach(async () => {
  space = await mkdtemp(join(tmpdir(), 'inkwell-shelf-'))
})

afterEach(async () => {
  await rm(space, { recursive: true, force: true })
})

describe('readShelf', () => {
  it('reports an empty shelf when the file does not exist', async () => {
    expect(await readShelf(join(space, 'missing.json'))).toEqual([])
  })

  it('reports an empty shelf when the file is not JSON', async () => {
    const file = join(space, 'broken.json')
    await writeFile(file, 'not json at all', 'utf8')
    expect(await readShelf(file)).toEqual([])
  })

  it('drops entries that are not shaped like a book', async () => {
    const file = join(space, 'books.json')
    await writeFile(
      file,
      JSON.stringify({ version: 1, books: [{ root: 42 }, 'nonsense', null, { root: '  ' }, { root: space }] }),
      'utf8',
    )
    const entries = await readShelf(file)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.root).toBe(space)
  })

  it('keeps the first of two spellings of the same book', async () => {
    const file = join(space, 'books.json')
    await writeFile(
      file,
      JSON.stringify({ books: [{ root: space, at: 'first' }, { root: space, at: 'second' }] }),
      'utf8',
    )
    const entries = await readShelf(file)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.at).toBe('first')
  })

  it('accepts a bare array, which is what a hand-edited file tends to be', async () => {
    const file = join(space, 'books.json')
    await writeFile(file, JSON.stringify([{ root: space }]), 'utf8')
    expect(await readShelf(file)).toHaveLength(1)
  })
})

describe('writeShelf', () => {
  it('creates the directory and caps the list', async () => {
    const file = join(space, 'nested', 'deeper', 'books.json')
    const entries = Array.from({ length: MAX_SHELF + 5 }, (_, index) => ({
      root: join(space, `book-${index}`),
      at: '2026-01-01T00:00:00.000Z',
    }))
    await writeShelf(file, entries)
    const written = JSON.parse(await readFile(file, 'utf8')) as { books: unknown[] }
    expect(written.books).toHaveLength(MAX_SHELF)
  })

  it('writes UTF-8 without a byte-order mark', async () => {
    const file = join(space, 'books.json')
    await writeShelf(file, [{ root: space, at: 'now' }])
    const bytes = await readFile(file)
    // A BOM here is the exact failure that stopped a profile from booting once.
    expect(bytes[0]).toBe(0x7b)
  })
})

describe('rememberBook', () => {
  it('puts the newest book first', async () => {
    const file = join(space, 'books.json')
    await rememberBook(file, join(space, 'one'))
    // Each call is a new process in production; the guard is per root per run,
    // so use distinct roots to exercise ordering rather than caching.
    await rememberBook(file, join(space, 'two'))
    const entries = await readShelf(file)
    expect(entries.map((entry) => entry.root)).toEqual([join(space, 'two'), join(space, 'one')])
  })

  it('moves a book back to the top instead of adding it twice', async () => {
    const file = join(space, 'books.json')
    await rememberBook(file, join(space, 'one'))
    await rememberBook(file, join(space, 'two'))
    await rememberBook(file, join(space, 'one'))
    const entries = await readShelf(file)
    expect(entries.map((entry) => entry.root)).toEqual([join(space, 'one'), join(space, 'two')])
  })

  it('does not rewrite the file when the book is already on top', async () => {
    const file = join(space, 'books.json')
    await rememberBook(file, join(space, 'one'))
    const before = await readFile(file, 'utf8')
    await new Promise((done) => setTimeout(done, 5))
    await rememberBook(file, join(space, 'one'))
    // The snapshot route calls this on a poll; an unchanged top means no write.
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('survives an unwritable location', async () => {
    const file = join(space, 'file-not-dir')
    await writeFile(file, '', 'utf8')
    // A state directory that is a file must cost the shelf, not the panel.
    await expect(rememberBook(join(file, 'books.json'), space)).resolves.toBeUndefined()
  })
})

describe('describeBook', () => {
  it('reports what the library row shows', async () => {
    const root = join(space, '.novel')
    const store = new ProjectStore(root)
    await store.init('雾港', 120_000)
    await store.writeChapter({
      number: 1,
      title: '裂缝',
      text: '沈砚把铜哨按进掌心。',
      words: 2140,
      summary: '',
      writtenAt: '2026-01-02T00:00:00.000Z',
    })
    const book = await describeBook(store)
    expect(book).toMatchObject({ root, title: '雾港', phase: 'premise', chapters: 1, words: 2140 })
    expect(typeof book?.updatedAt).toBe('string')
  })

  it('returns nothing for a directory that is not a book', async () => {
    const empty = join(space, 'plain')
    await mkdir(empty)
    expect(await describeBook(new ProjectStore(empty))).toBeUndefined()
  })
})
