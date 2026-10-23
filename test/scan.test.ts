import { describe, expect, it } from 'vitest'
import { scanChapter, scanEnding, scanOpenings, scanRepetition, scanRhythm, scanTone } from '../src/domain/scan.ts'
import { resolveConfig } from '../src/config.ts'
import type { ChapterDraft } from '../src/domain/types.ts'

const config = resolveConfig()

function draft(number: number, text: string): ChapterDraft {
  return {
    number,
    title: `第${number}章`,
    text,
    summary: '',
    words: text.length,
    writtenAt: '2026-01-01T00:00:00.000Z',
  }
}

const bridgeScene = '他推开门，屋里没有人。桌上的茶还热着，杯沿有一道裂纹。他站了一会儿，听见楼上有响动。'

describe('scanRepetition', () => {
  it('flags a chapter that reuses an earlier paragraph', () => {
    const findings = scanRepetition(
      draft(2, `${bridgeScene}${bridgeScene}`),
      [draft(1, bridgeScene)],
      config,
    )
    expect(findings[0]?.code).toBe('scan/repetition')
    expect(findings[0]?.message).toContain('第1章')
  })

  it('says nothing when the chapters are unrelated', () => {
    const findings = scanRepetition(
      draft(2, '海面很平，风停了，桅杆上的绳子一动不动。'),
      [draft(1, bridgeScene)],
      config,
    )
    expect(findings).toHaveLength(0)
  })
})

describe('scanOpenings', () => {
  it('flags sentences that share a two-character opening', () => {
    const findings = scanOpenings('他没说话。他没回头。他没动。风从窗缝里进来。', config)
    expect(findings[0]?.code).toBe('scan/opening-repeat')
  })

  it('stays quiet on varied openings', () => {
    expect(scanOpenings('风很大。他走了。屋里空了。脚步声远了。', config)).toHaveLength(0)
  })
})

describe('scanRhythm', () => {
  it('flags suspiciously uniform sentence lengths', () => {
    const text = '他走进屋子里面。她坐在桌子旁边。风吹开了那扇门。雨落在窗台之上。'.repeat(2)
    expect(scanRhythm(text, config)[0]?.code).toBe('scan/rhythm-flat')
  })

  it('needs enough sentences to judge', () => {
    expect(scanRhythm('他走了。', config)).toHaveLength(0)
  })
})

describe('scanTone', () => {
  it('flags stock phrasing above the density threshold', () => {
    const text = '他仿佛看见了什么。她也仿佛明白了。空气仿佛凝固了。这是很短的一句。'.repeat(3)
    expect(scanTone(text, config)[0]?.code).toBe('scan/tone-heavy')
  })

  it('reports a clean density as info, not a warning', () => {
    const text = '他推开门，屋里没有人。桌上的茶还热着，杯沿有一道裂纹。'
    expect(scanTone(text, config)).toHaveLength(0)
  })

  it('reports a light density without failing', () => {
    const text = `他仿佛看见了她。${'他推开门，屋里没有人。'.repeat(60)}`
    const findings = scanTone(text, config)
    expect(findings[0]?.severity).toBe('info')
  })
})

describe('scanEnding', () => {
  it('flags a flat statement ending', () => {
    expect(scanEnding('他走了很远的路。他终于到了。')[0]?.code).toBe('scan/ending-flat')
  })

  it('accepts a question ending', () => {
    expect(scanEnding('他走了很远的路。他真的到了吗？')).toHaveLength(0)
  })
})

describe('scanChapter', () => {
  it('deduplicates by code and sorts by severity', () => {
    const findings = scanChapter(draft(2, `${bridgeScene}${bridgeScene}`), [draft(1, bridgeScene)], config)
    const codes = findings.map((item) => item.code)
    expect(new Set(codes).size).toBe(codes.length)
  })
})
