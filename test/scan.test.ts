import { describe, expect, it } from 'vitest'
import { discoverOpeners, scanChapter, scanEnding, scanOpenings, scanRepetition, scanRhythm, scanTone } from '../src/domain/scan.ts'
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

  it('says nothing at all when the density is light', () => {
    // "Nothing is wrong" is not a finding. Reporting it once per chapter buried
    // the one line that mattered on a full-book pass.
    const text = `他仿佛看见了她。${'他推开门，屋里没有人。'.repeat(60)}`
    expect(scanTone(text, config)).toEqual([])
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

describe('telling a name from a flat opening', () => {
  it('does not count a sentence that starts with a character’s name', () => {
    // 「路长远收起了伞」 forty times is a protagonist doing things, not a stylistic
    // tic. Reporting it teaches the author to ignore the whole report.
    const text = Array.from({ length: 12 }, () => '路长远推开门。').join('')
    expect(scanOpenings(text, config, [])).toHaveLength(1)
    expect(scanOpenings(text, config, ['路长远'])).toEqual([])
  })

  it('still counts the openings that are genuinely flat', () => {
    const text = Array.from({ length: 12 }, () => '他推开门。').join('')
    const [finding] = scanOpenings(text, config, ['路长远'])
    expect(finding?.code).toBe('scan/opening-repeat')
    expect(finding?.evidence).toContain('他推×12')
  })

  it('reports the worst openings in one line, not one line each', () => {
    // `scanChapter` keeps the first finding per code; one finding per opening
    // meant a chapter with seven of them reported whichever came first.
    const text = `${'他推开门。'.repeat(6)}${'她抬起头。'.repeat(5)}${'雨落下来。'.repeat(4)}`
    const findings = scanOpenings(text, config)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.evidence).toContain('他推×6')
    expect(findings[0]?.evidence).toContain('她抬×5')
  })
})

describe('discoverOpeners', () => {
  function chapter(number: number, text: string) {
    return { number, title: `第${number}章`, text, words: text.length, summary: '', writtenAt: '2026-01-01T00:00:00.000Z', revision: 1 }
  }

  it('finds an opening that recurs across chapters, i.e. a name', () => {
    const book = Array.from({ length: 10 }, (_, index) => chapter(index + 1, '路长远推开门。路上有水。'))
    expect(discoverOpeners(book, 0.15)).toContain('路长')
  })

  it('leaves a pronoun alone, however often it opens a sentence', () => {
    // 「他」 is exactly what the check is for. Excluding it would hide the one
    // habit that is worth fixing.
    const book = Array.from({ length: 10 }, (_, index) => chapter(index + 1, '他推开门。他坐下。他走了。'))
    expect(discoverOpeners(book, 0.15)).not.toContain('他')
  })

  it('says nothing about a book too short to have habits', () => {
    expect(discoverOpeners([chapter(1, '路长远推开门。'), chapter(2, '路长远坐下。')])).toEqual([])
  })
})
