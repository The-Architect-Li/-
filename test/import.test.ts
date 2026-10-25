/**
 * Importing a manuscript that already exists.
 *
 * Two kinds of test, matching the two halves of the feature. The parser tests
 * use strings and assert on what was understood — a section mapped to the wrong
 * card field is invisible in an integration test and obvious here. Two real
 * imports are exercised end to end, because "did it land in chapters/00N.md and
 * in the index" is not a question a string comparison can answer.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chapterNumberOf,
  chapterTitleOf,
  planCast,
  planChapters,
  planImport,
  planOutline,
  type SourceFile,
} from '../src/domain/import-scan.ts'
import type { ChapterPlan, CharacterCard, VolumeOutline } from '../src/domain/types.ts'
import { createHarness, valueOf, type Harness } from './helpers.ts'

const NOW = new Date('2026-10-25T00:00:00.000Z')

/** A file the importer would have read, built without touching the disk. */
function source(path: string, text: string): SourceFile {
  return { path, name: path.split('/').pop() ?? path, text }
}

describe('章节文件名', () => {
  it('reads the number, including full-width digits', () => {
    expect(chapterNumberOf('第10章-开门-v1.md')).toBe(10)
    expect(chapterNumberOf('第十二章.md')).toBeUndefined()
    expect(chapterNumberOf('第１２章 缺口.md')).toBe(12)
    expect(chapterNumberOf('人物设定.md')).toBeUndefined()
  })

  it('keeps the title and drops the version suffix', () => {
    expect(chapterTitleOf('第10章-开门-v1.md', 10)).toBe('开门')
    expect(chapterTitleOf('第7章 自己走的那步棋.md', 7)).toBe('自己走的那步棋')
    expect(chapterTitleOf('第85章.md', 85)).toBe('第85章')
  })
})

describe('planChapters', () => {
  it('orders by number, not by file name', () => {
    const { chapters } = planChapters([
      source('正文/第10章-开门.md', '第十章的正文，够长一些才能赢。'),
      source('正文/第2章-金童玉女.md', '第二章的正文。'),
    ])
    expect(chapters.map((chapter) => chapter.number)).toEqual([2, 10])
    expect(chapters[1]!.title).toBe('开门')
  })

  it('keeps the longer file when two claim one chapter', () => {
    const { chapters } = planChapters([
      source('正文/第5章-旧-v1.md', '短。'),
      source('正文/第5章-新-v2.md', '这一份明显更长，是正在改的那一版。'),
    ])
    expect(chapters).toHaveLength(1)
    expect(chapters[0]!.text).toBe('这一份明显更长，是正在改的那一版。')
  })

  it('drops a redundant heading and reports files with no number', () => {
    const { chapters, ignored } = planChapters([
      source('正文/第1章-裂缝.md', '# 第1章 裂缝\n\n凌晨一点零七分。'),
      source('正文/设定草稿.md', '随手记的东西。'),
    ])
    expect(chapters[0]!.text).toBe('凌晨一点零七分。')
    expect(chapters[0]!.summary).toBe('凌晨一点零七分。')
    expect(ignored).toEqual(['设定草稿.md'])
  })
})

describe('planCast', () => {
  it('routes sections onto the card, and keeps the rest as notes', () => {
    const card = planCast(
      [
        source(
          '人物/王上.md',
          [
            '# 王上',
            '',
            '## 外在底色',
            '- 外形：一米七五出头，微胖',
            '- 出身：工地→写字楼小职员',
            '',
            '## 隐性欲望',
            '- 内核：对当年被嘲笑的报复',
            '',
            '## 关系网',
            '- 薛梦静：第一段收编的女人',
          ].join('\n'),
        ),
      ],
      ['王上'],
      NOW,
    )[0]!.card

    expect(card.name).toBe('王上')
    expect(card.role).toBe('protagonist')
    expect(card.appearance).toContain('一米七五出头')
    expect(card.goal).toContain('报复')
    expect(card.notes).toContain('薛梦静')
    expect(card.voice).toBe('')
    expect(card.updatedAt).toBe(NOW.toISOString())
  })

  it('takes a voice bullet and marks everyone else supporting', () => {
    const [lead, other] = planCast(
      [
        source('人物/甲.md', '## 说话方式\n- 短句，句尾常带「吧」。'),
        source('人物/乙.md', '# 乙\n\n## 外在底色\n- 外形：很高'),
      ],
      ['甲'],
      NOW,
    )
    expect(lead!.card.voice).toContain('短句')
    expect(lead!.card.role).toBe('protagonist')
    expect(other!.card.role).toBe('supporting')
  })
})

describe('planOutline', () => {
  const outline = [
    '# 《待定》全书大纲',
    '',
    '> 一句话立意：一个穷小子把两对母女收进自己的屋檐下。',
    '> 主角：王上（24→32 岁）',
    '',
    '## 卷一·翻身（第1–11章，约2.5万字）',
    '',
    '**核心**：从麻木到觉醒。',
    '',
    '- 第1章 裂缝：深夜加班时翻到初中校花。',
    '- 第2章 金童玉女：开始在心里反复演练。',
    '',
    '## 卷二·出门（第12–20章）',
    '',
    '- 第12章 捐赠：第一次捐钱。',
  ].join('\n')

  it('lifts the premise, the lead, the volumes, and one plan per line', () => {
    const plan = planOutline(outline)
    expect(plan.premise).toBe('一个穷小子把两对母女收进自己的屋檐下。')
    expect(plan.protagonistNames).toEqual(['王上'])
    expect(plan.volumes.map((volume) => volume.number)).toEqual([1, 2])
    expect(plan.volumes[0]!.summary).toBe('从麻木到觉醒。')
    expect(plan.chapters.map((chapter) => chapter.number)).toEqual([1, 2, 12])
    expect(plan.chapters[2]!.volume).toBe(2)
    expect(plan.chapters[1]!.line).toBe('开始在心里反复演练。')
  })

  it('reads a lead whose bracket holds a comma', () => {
    // The real manuscript writes the age and the arc inside the bracket:
    // `> 主角：王上（24→32岁，由写字楼底层小职员爬到「上势」老板）`. Splitting on
    // the comma before stripping the bracket cuts the name in half.
    const plan = planOutline('> 主角：王上（24→32岁，由小职员爬到老板）、郑雅洁（32→40岁）')
    expect(plan.protagonistNames).toEqual(['王上', '郑雅洁'])
  })

  it('survives a folder with no outline', () => {
    const plan = planImport({ chapters: [source('正文/第1章.md', '正文。')], cast: [] }, NOW)
    expect(plan.volumes).toEqual([])
    expect(plan.plans).toEqual([])
    expect(plan.premise).toBe('')
  })
})

describe('novel_import', () => {
  let harness: Harness
  let manuscript: string

  beforeEach(async () => {
    harness = await createHarness()
    manuscript = await mkdtemp(join(tmpdir(), 'manuscript-'))
    await mkdir(join(manuscript, '正文'), { recursive: true })
    await mkdir(join(manuscript, '人物'), { recursive: true })
    await mkdir(join(manuscript, '大纲'), { recursive: true })
    await writeFile(join(manuscript, '正文', '第1章-裂缝.md'), '# 第1章 裂缝\n\n凌晨一点零七分。\n', 'utf8')
    await writeFile(join(manuscript, '正文', '第2章-金童玉女.md'), '她当年那句话还在耳边。\n', 'utf8')
    await writeFile(
      join(manuscript, '人物', '王上.md'),
      '# 王上\n\n## 外在底色\n- 外形：微胖\n\n## 关系网\n- 薛梦静：第一段\n',
      'utf8',
    )
    await writeFile(
      join(manuscript, '大纲', '全书大纲.md'),
      '> 一句话立意：一个穷小子往上爬。\n> 主角：王上\n\n## 卷一·翻身（第1–2章）\n\n**核心**：翻身。\n\n- 第1章 裂缝：深夜加班。\n- 第2章 金童玉女：反复演练。\n',
      'utf8',
    )
    const init = await harness.call('novel_project', { action: 'init', title: '待定' })
    expect(init.ok).toBe(true)
  })

  afterEach(async () => {
    await harness.cleanup()
    await rm(manuscript, { recursive: true, force: true })
  })

  it('scans without writing anything', async () => {
    const value = valueOf<{ report: string; chapters: number; words: number }>(
      await harness.call('novel_import', { action: 'scan', dir: manuscript }),
    )
    expect(value.chapters).toBe(2)
    expect(value.words).toBeGreaterThan(0)
    expect(value.report).toContain('还没写任何文件')
    expect(value.report).toContain('一句话立意：一个穷小子往上爬。')
    // Nothing was written: the index is still whatever `init` left.
    const index = await readFile(join(harness.root, 'chapters', 'index.json'), 'utf8')
    expect(JSON.parse(index)).toEqual([])
  })

  it('says which cards still need a voice, because the gate will hold on it', async () => {
    const value = valueOf<{ report: string }>(
      await harness.call('novel_import', { action: 'scan', dir: manuscript }),
    )
    expect(value.report).toContain('说话方式还空着：王上')
    expect(value.report).toContain('闸门会拦')
  })

  it('writes chapters, cast, volumes, and plans on apply', async () => {
    const value = valueOf<{ chapters: number; cast: number; volumes: number; plans: number; skipped: number }>(
      await harness.call('novel_import', { action: 'apply', dir: manuscript }),
    )
    expect(value).toMatchObject({ chapters: 2, cast: 1, volumes: 1, plans: 2, skipped: 0 })

    const body = await readFile(join(harness.root, 'chapters', '001.md'), 'utf8')
    expect(body).toContain('凌晨一点零七分。')
    expect(body.startsWith('# 第1章')).toBe(false)

    const project = JSON.parse(await readFile(join(harness.root, 'project.json'), 'utf8'))
    expect(project.premise).toBe('一个穷小子往上爬。')

    const cast = JSON.parse(
      await readFile(join(harness.root, 'canon', 'characters.json'), 'utf8'),
    ) as CharacterCard[]
    expect(cast[0]!.name).toBe('王上')
    expect(cast[0]!.role).toBe('protagonist')
    expect(cast[0]!.notes).toContain('薛梦静')

    const volumes = JSON.parse(
      await readFile(join(harness.root, 'outline', 'volumes.json'), 'utf8'),
    ) as VolumeOutline[]
    expect(volumes[0]!.title).toBe('卷一·翻身')

    const plans = JSON.parse(
      await readFile(join(harness.root, 'outline', 'chapters.json'), 'utf8'),
    ) as ChapterPlan[]
    expect(plans.map((plan) => plan.beats[0])).toEqual(['深夜加班。', '反复演练。'])
    expect(plans.every((plan) => plan.approved)).toBe(true)
  })

  it('refuses to overwrite a chapter unless asked', async () => {
    await harness.call('novel_import', { action: 'apply', dir: manuscript })
    await writeFile(join(manuscript, '正文', '第1章-裂缝.md'), '改过的第一章。\n', 'utf8')

    const again = valueOf<{ chapters: number; skipped: number }>(
      await harness.call('novel_import', { action: 'apply', dir: manuscript }),
    )
    expect(again).toMatchObject({ chapters: 0, skipped: 2 })

    const forced = valueOf<{ chapters: number; skipped: number }>(
      await harness.call('novel_import', { action: 'apply', dir: manuscript, overwrite: true }),
    )
    expect(forced).toMatchObject({ chapters: 2, skipped: 0 })
    const body = await readFile(join(harness.root, 'chapters', '001.md'), 'utf8')
    expect(body).toContain('改过的第一章。')
  })

  it('names the reason a folder cannot be imported', async () => {
    const result = await harness.call('novel_import', { action: 'apply', dir: 'relative/path' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('绝对路径')
  })
})
