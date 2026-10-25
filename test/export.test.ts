/**
 * Exporting a book as files.
 *
 * The formatting is pure, so these tests compare strings: what the file says is
 * the whole contract. One real write is exercised too, because "did it land in
 * the right directory" is not something a string comparison can answer.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bookText, canonMarkdown, safeFileName, volumeFiles } from '../src/domain/export.ts'
import { ProjectStore } from '../src/domain/store.ts'
import type { ChapterDraft, Snapshot } from '../src/domain/types.ts'
import { createHarness, valueOf, type Harness } from './helpers.ts'

const NOW = '2026-10-24T00:00:00.000Z'

function chapter(number: number, title: string, text: string): ChapterDraft {
  return {
    number,
    title,
    words: text.replace(/\s/g, '').length,
    summary: text.slice(0, 20),
    writtenAt: NOW,
    text,
  }
}

function snapshot(): Snapshot {
  return {
    project: {
      formatVersion: 1,
      title: '雾港',
      phase: 'drafting',
      premise: '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。',
      targetWords: 120000,
      createdAt: NOW,
      updatedAt: NOW,
    },
    characters: [
      { name: '沈砚', role: 'protagonist', voice: '短句，少形容词', appearance: '左手有旧疤', goal: '找到妹妹', secret: '他也替人顶罪', updatedAt: NOW },
    ],
    world: [{ name: '雾港', kind: '地点', detail: '终年不散的雾，码头三班倒。', updatedAt: NOW }],
    places: [],
    storyPoints: [],
    timeline: { formatVersion: 1, anchors: [], spans: [] },
    volumes: [{ number: 1, title: '雾里的货单', summary: '三号舱的货单对不上。', approved: true }],
    plans: [
      { number: 1, volume: 1, title: '裂缝', pov: '沈砚', characters: ['沈砚'], beats: ['发现裂缝', '妹妹开口'], hooks: ['货单上多了一个名字'], approved: true },
      { number: 2, volume: 1, title: '过秤', pov: '沈砚', characters: ['沈砚'], beats: ['过秤', '对质'], hooks: [], approved: true },
    ],
    ledger: [
      { id: 'f-0001', subject: '沈砚', predicate: '身份', value: '船工', chapter: 1, quote: '他就是那个替人过秤的船工。', supersedes: null, createdAt: NOW },
      { id: 'f-0002', subject: '沈砚', predicate: '身份', value: '船主', chapter: 2, quote: '船契在他名下。', supersedes: 'f-0001', createdAt: NOW },
    ],
    chapters: [chapter(1, '裂缝', '沈砚发现船底藏着尸体。\n\n他回头看阿鸢。'), chapter(2, '过秤', '雾更重了。')],
  }
}

/** The snapshot's chapters, which the fixture wrote with their prose. */
function written(): ChapterDraft[] {
  return snapshot().chapters as ChapterDraft[]
}

describe('safeFileName', () => {
  it('replaces the characters Windows refuses', () => {
    expect(safeFileName('第一卷: 雾/里的货单')).toBe('第一卷- 雾-里的货单')
  })

  it('never returns an empty name', () => {
    expect(safeFileName('...')).toBe('未命名')
    expect(safeFileName('   ')).toBe('未命名')
  })

  it('caps a very long title', () => {
    expect(safeFileName('雾'.repeat(200)).length).toBe(80)
  })
})

describe('bookText', () => {
  it('writes the title, the premise, then chapter headings in order', () => {
    const text = bookText(snapshot(), written())
    expect(text).toContain('《雾港》')
    expect(text).toContain('一个替人销赃的船工')
    expect(text.indexOf('第1章 裂缝')).toBeLessThan(text.indexOf('第2章 过秤'))
    expect(text).toContain('沈砚发现船底藏着尸体。')
  })

  it('keeps paragraphs apart and does not stack blank lines', () => {
    const text = bookText(snapshot(), written())
    expect(text).toContain('他回头看阿鸢。')
    expect(text).not.toMatch(/\n{3,}/)
  })
})

describe('volumeFiles', () => {
  it('makes one file per volume that has written chapters', () => {
    const files = volumeFiles(snapshot(), written())
    expect(files).toHaveLength(1)
    expect(files[0]?.name).toBe('第1卷 雾里的货单.md')
    expect(files[0]?.body).toContain('# 第1卷 雾里的货单')
    expect(files[0]?.body).toContain('## 第1章 裂缝')
    expect(files[0]?.body).toContain('三号舱的货单对不上。')
  })

  it('puts chapters with no volume in 未分卷 rather than losing them', () => {
    const book = snapshot()
    book.plans = book.plans.filter((plan) => plan.number !== 2)
    const files = volumeFiles(book, book.chapters as ChapterDraft[])
    const loose = files.find((file) => file.name === '未分卷.md')
    expect(loose).toBeDefined()
    expect(loose?.body).toContain('第2章 过秤')
  })
})

describe('canonMarkdown', () => {
  it('carries the cast with their voices and secrets', () => {
    const text = canonMarkdown(snapshot())
    expect(text).toContain('# 《雾港》设定集')
    expect(text).toContain('### 沈砚（主角）')
    expect(text).toContain('- 说话方式：短句，少形容词')
    expect(text).toContain('- 秘密：他也替人顶罪')
  })

  it('carries the world, the outline and the ledger', () => {
    const text = canonMarkdown(snapshot())
    expect(text).toContain('### 雾港（地点）')
    expect(text).toContain('- 第1卷 雾里的货单')
    expect(text).toContain('- 节拍：发现裂缝')
    expect(text).toContain('| id | 主体 | 属性 | 值 | 第几章 | 原文 |')
  })

  it('lists only facts that still stand', () => {
    const text = canonMarkdown(snapshot())
    expect(text).toContain('| f-0002 |')
    expect(text).not.toContain('| f-0001 |')
  })
})

describe('novel_export', () => {
  let harness: Harness
  let outDir: string

  beforeAll(async () => {
    harness = await createHarness()
    outDir = await mkdtemp(join(tmpdir(), 'inkwell-export-'))
    // Written straight to disk rather than walked through the phases: the phase
    // gates have their own tests, and this one is about file formatting.
    const store = new ProjectStore(harness.root)
    await store.init('雾港', 120000)
    await store.writeProject({ ...(await store.readProject()), premise: snapshot().project.premise })
    for (const card of snapshot().characters) await store.upsertCharacter(card)
    for (const entry of snapshot().world) await store.upsertWorld(entry)
    const book = snapshot()
    const [firstVolume] = book.volumes
    if (firstVolume !== undefined) await store.upsertVolume(firstVolume)
    for (const plan of book.plans) await store.upsertPlan(plan)
    for (const draft of written()) await store.writeChapter(draft)
  })

  afterAll(async () => {
    await harness.cleanup()
    await rm(outDir, { recursive: true, force: true })
  })

  it('writes the plain text book and names the file after the book', async () => {
    const value = await valueOf<{ files: string[]; report: string }>(
      await harness.call('novel_export', { action: 'text', out: outDir }),
    )
    expect(value.files).toHaveLength(1)
    expect(value.files[0]?.endsWith('雾港.txt')).toBe(true)
    const body = await readFile(value.files[0] ?? '', 'utf8')
    expect(body).toContain('第1章 裂缝')
    expect(body).toContain('沈砚发现船底藏着尸体。')
    expect(value.report).toContain('已导出 1 个文件')
  })

  it('writes the canon sheet', async () => {
    const value = await valueOf<{ files: string[] }>(
      await harness.call('novel_export', { action: 'canon', out: outDir }),
    )
    expect(value.files[0]?.endsWith('雾港·设定集.md')).toBe(true)
    const body = await readFile(value.files[0] ?? '', 'utf8')
    expect(body).toContain('### 沈砚（主角）')
  })

  it('writes one file per volume', async () => {
    const value = await valueOf<{ files: string[] }>(
      await harness.call('novel_export', { action: 'markdown', out: outDir }),
    )
    expect(value.files.some((file) => file.endsWith('第1卷 雾里的货单.md'))).toBe(true)
  })

  it('says so when there is no prose to export', async () => {
    const empty = await createHarness()
    try {
      await valueOf(await empty.call('novel_project', { action: 'init', title: '空书' }))
      const value = await valueOf<{ files: string[]; report: string }>(
        await empty.call('novel_export', { action: 'text', out: outDir }),
      )
      expect(value.files).toEqual([])
      expect(value.report).toContain('还没有可导出的正文')
    } finally {
      await empty.cleanup()
    }
  })
})
