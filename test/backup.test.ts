/**
 * The backup module: a zip this code writes, a book it can go back to.
 *
 * The interesting cases are the ones where a backup is *not* a copy: restoring
 * over a book that has grown since, and the path that is not a backup at all.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  backupDirFor,
  collectBook,
  describeBackup,
  isBackupName,
  listBackups,
  packageBook,
  readZip,
  restoreBook,
  stampOf,
  writeZip,
} from '../src/domain/backup.ts'
import { ProjectStore } from '../src/domain/store.ts'
import { createHarness, valueOf, type Harness } from './helpers.ts'

const harnesses: Harness[] = []

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup()
})

/**
 * A harness with one book in it, and the book kept for later.
 *
 * @param title - the book's title.
 * @returns the harness and its store.
 */
async function ready(title = '雾港'): Promise<{ harness: Harness; store: ProjectStore }> {
  const harness = await createHarness()
  harnesses.push(harness)
  const store = new ProjectStore(harness.root)
  await store.init(title, 800_000)
  return { harness, store }
}

/**
 * Put one chapter on disk, so a backup has something to carry.
 *
 * @param store - where to write.
 * @param number - the chapter number.
 * @param text - the prose.
 */
async function write(store: ProjectStore, number: number, text: string): Promise<void> {
  await store.writeChapter({
    number,
    title: `第${number}章`,
    words: text.length,
    summary: text.slice(0, 20),
    writtenAt: '2026-10-01T00:00:00.000Z',
    text,
  })
}

describe('the zip this module writes', () => {
  it('round-trips text, including names that are not ASCII', () => {
    const files = [
      { path: 'project.json', text: '{"title":"雾港"}' },
      { path: 'chapters/001.md', text: '雨落了一夜。\n\n码头的木板吸饱了水。' },
      { path: 'canon/characters.json', text: '[{"name":"沈砚"}]' },
    ]
    expect(readZip(writeZip(files, new Date('2026-10-27T19:31:05')))).toEqual(files)
  })

  it('keeps an empty file empty instead of dropping it', () => {
    const files = [{ path: 'ledger/facts.json', text: '[]' }]
    expect(readZip(writeZip(files, new Date())).map((file) => file.text)).toEqual(['[]'])
  })

  it('refuses bytes that are not a zip', () => {
    expect(() => readZip(Buffer.from('not a zip at all'))).toThrow(/不是一个 zip 文件/)
  })
})

describe('naming', () => {
  it('stamps a sortable, filesystem-safe name', () => {
    expect(stampOf(new Date(2026, 9, 27, 19, 31, 5))).toBe('2026-10-27T19-31-05')
  })

  it('accepts a plain file name and rejects a path', () => {
    expect(isBackupName('2026-10-27T19-31-05.zip')).toBe(true)
    expect(isBackupName('pre-restore-2026-10-27T19-31-05.zip')).toBe(true)
    expect(isBackupName('../escape.zip')).toBe(false)
    expect(isBackupName('C:\\temp\\x.zip')).toBe(false)
  })
})

describe('collectBook', () => {
  it('reads the book, sorted, and leaves the exports directory out', async () => {
    const { store, harness } = await ready()
    await write(store, 1, '第一稿。')
    await mkdir(join(harness.root, 'exports'), { recursive: true })
    await writeFile(join(harness.root, 'exports', '雾港.txt'), '导出的正文', 'utf8')

    const paths = (await collectBook(harness.root)).map((file) => file.path)
    expect(paths).toContain('chapters/001.md')
    expect(paths.some((path) => path.startsWith('exports/'))).toBe(false)
    expect([...paths].sort()).toEqual(paths)
  })
})

describe('packageBook', () => {
  it('writes one copy outside the book and reports it', async () => {
    const { store, harness } = await ready()
    await write(store, 1, '第一稿。')

    const made = await packageBook(harness.root, { when: new Date(2026, 9, 27, 19, 31, 5) })
    expect(made.entry.name).toBe('2026-10-27T19-31-05.zip')
    expect(made.entry.files).toBeGreaterThan(0)
    expect(made.entry.path.startsWith(backupDirFor(harness.root))).toBe(true)
    // The copy must not live inside the book, or the next copy would carry it.
    expect(made.entry.path.startsWith(harness.root)).toBe(false)
    expect(describeBackup(made.entry)).toContain('个文件')
  })

  it('lists newest first and keeps only the newest twenty', async () => {
    const { store, harness } = await ready()
    await write(store, 1, '第一稿。')

    // 21 copies a minute apart, so the names sort the way time does.
    for (let index = 0; index < 21; index += 1) {
      await packageBook(harness.root, { when: new Date(2026, 9, 27, 18, index, 0) })
    }
    const kept = await listBackups(harness.root)
    expect(kept).toHaveLength(20)
    expect(kept[0]!.name).toBe('2026-10-27T18-20-00.zip')

    const again = await packageBook(harness.root, { when: new Date(2026, 9, 27, 21, 0, 0) })
    expect(again.pruned).toEqual(['2026-10-27T18-01-00.zip'])
  })
})

describe('restoreBook', () => {
  it('puts the old text back, keeps the newer chapter, and says so', async () => {
    const { store, harness } = await ready()
    await write(store, 1, '第一稿。')
    const made = await packageBook(harness.root, { when: new Date(2026, 9, 27, 19, 0, 0) })

    // The author keeps writing: chapter one is rewritten, chapter two is new.
    await write(store, 1, '第二稿，改了。')
    await write(store, 2, '新写的一章。')

    const result = await restoreBook(harness.root, made.entry.name)
    expect((await readFile(join(harness.root, 'chapters', '001.md'), 'utf8')).includes('第一稿')).toBe(true)
    expect(result.written).toContain('chapters/001.md')
    // The chapter the copy never knew about is not deleted — a restore that
    // silently removes prose is worse than the mistake it undoes.
    expect(result.extra).toContain('chapters/002.md')
    expect((await readFile(join(harness.root, 'chapters', '002.md'), 'utf8')).includes('新写的一章')).toBe(true)
  })

  it('keeps the current state before overwriting it', async () => {
    const { store, harness } = await ready()
    await write(store, 1, '第一稿。')
    const made = await packageBook(harness.root, { when: new Date(2026, 9, 27, 19, 0, 0) })
    await write(store, 1, '第二稿，改了。')

    const result = await restoreBook(harness.root, made.entry.name, { when: new Date(2026, 9, 27, 20, 0, 0) })
    expect(result.safety?.name).toBe('pre-restore-2026-10-27T20-00-00.zip')
    const safety = readZip(await readFile(result.safety!.path))
    expect(safety.find((file) => file.path === 'chapters/001.md')!.text).toContain('第二稿')
  })

  it('says nothing about files that were already identical', async () => {
    const { store, harness } = await ready()
    await write(store, 1, '没改过的正文。')
    const made = await packageBook(harness.root, { when: new Date(2026, 9, 27, 19, 0, 0) })

    const result = await restoreBook(harness.root, made.entry.name)
    expect(result.written).toEqual([])
    expect(result.unchanged).toContain('chapters/001.md')
  })

  it('refuses a name that is not a copy of this book', async () => {
    const { store, harness } = await ready()
    await write(store, 1, '第一稿。')
    await expect(restoreBook(harness.root, '../elsewhere.zip')).rejects.toThrow(/不是一份备份的文件名/)
    await expect(restoreBook(harness.root, '2020-01-01T00-00-00.zip')).rejects.toThrow(/没有这份备份/)
  })
})

describe('novel_backup', () => {
  it('makes a copy and lists it', async () => {
    const { harness } = await ready()
    const made = valueOf<{ report: string; backup: string }>(
      await harness.call('novel_backup', { action: 'make' }),
    )
    expect(made.backup).toMatch(/\.zip$/)
    expect(made.report).toContain('备份好了')

    const listed = valueOf<{ report: string; backups: string[] }>(
      await harness.call('novel_backup', { action: 'list' }),
    )
    expect(listed.backups).toContain(made.backup)
    expect(listed.report).toContain('份备份')
  })

  it('restores by name and reports the safety copy', async () => {
    const { harness, store } = await ready()
    await write(store, 1, '第一稿。')
    const made = valueOf<{ backup: string }>(await harness.call('novel_backup', { action: 'make' }))
    await write(store, 1, '第二稿，改了。')

    const restored = valueOf<{ report: string; written: string[] }>(
      await harness.call('novel_backup', { action: 'restore', name: made.backup }),
    )
    expect(restored.written).toContain('chapters/001.md')
    expect(restored.report).toContain('已经回到')
    expect(restored.report).toContain('pre-restore-')
    expect((await readFile(join(harness.root, 'chapters', '001.md'), 'utf8')).includes('第一稿')).toBe(true)
  })

  it('asks which copy when restore has no name, and names the newest', async () => {
    const { harness } = await ready()
    await harness.call('novel_backup', { action: 'make' })
    const refused = await harness.call('novel_backup', { action: 'restore' })
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('restore without a name should have been refused')
    expect(refused.error).toContain('最新的那份是')
  })
})
