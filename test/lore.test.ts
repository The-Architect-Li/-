/**
 * Reading the canon out of prose.
 *
 * The rules under test are the ones that keep this from producing a confident
 * wrong baseline: no quote, no card; `voice` never invented; an authored field
 * never replaced by a read one.
 */
import { describe, expect, it } from 'vitest'
import {
  buildLorePrompt,
  characterFromLore,
  emptyLore,
  mergeLore,
  parseLoreOutput,
  placeFromLore,
  roleForNewCard,
  topUpFromLore,
  worldFromLore,
  type LoreCharacter,
  type LoreResult,
} from '../src/domain/lore.ts'
import { ROLES } from '../src/roles.ts'
import type { CharacterCard } from '../src/domain/types.ts'

function entry(over: Partial<LoreCharacter> = {}): LoreCharacter {
  return {
    name: '沈砚',
    aliases: [],
    appearance: '左手少一根指节',
    goal: '找到妹妹',
    secret: '他烧过一艘船',
    personality: '',
    chapters: 0,
    quote: '他左手少了半截指节，握桨时看不出。',
    ...over,
  }
}

function card(over: Partial<CharacterCard> = {}): CharacterCard {
  return {
    name: '沈砚',
    role: 'supporting',
    voice: '短句',
    appearance: '',
    goal: '',
    secret: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

describe('buildLorePrompt', () => {
  it('names the span and carries the prose', () => {
    const prompt = buildLorePrompt(
      { span: '第1–3章', text: '=== 第1章 入港 ===\n雾从海面漫上来。' },
      ROLES.lorekeeper.persona,
      ROLES.lorekeeper.outputContract,
    )
    expect(prompt).toContain('第1–3章')
    expect(prompt).toContain('雾从海面漫上来')
    expect(prompt).toContain(ROLES.lorekeeper.outputContract)
  })
})

describe('parseLoreOutput', () => {
  it('reads a plain object', () => {
    const lore = parseLoreOutput(
      JSON.stringify({
        characters: [{ name: '沈砚', aliases: ['阿砚'], appearance: '瘦', goal: '找妹妹', secret: '', personality: '', quote: '他瘦得只剩一把骨头。' }],
        places: [{ name: '雾港', kind: '城市', detail: '终年起雾', quote: '雾港一年有大半年看不见对岸。' }],
        world: [{ name: '漕帮', kind: '势力', detail: '管着半个港口的货', quote: '漕帮的人从不走夜路。' }],
        premise: '一个替人销赃的船工，在货舱里发现了失踪三年的妹妹。',
      }),
    )
    expect(lore.characters).toHaveLength(1)
    expect(lore.characters[0]?.aliases).toEqual(['阿砚'])
    expect(lore.places[0]?.name).toBe('雾港')
    expect(lore.world[0]?.kind).toBe('势力')
    expect(lore.premise).toContain('船工')
  })

  it('drops an entry that quotes nothing', () => {
    // The quote is the only thing separating "read from the text" from "sounds
    // plausible", and this pass builds the baseline every review measures.
    const lore = parseLoreOutput(
      JSON.stringify({
        characters: [
          { name: '沈砚', quote: '他瘦得只剩一把骨头。' },
          { name: '路人甲', appearance: '中年', quote: '' },
        ],
        places: [{ name: '某地', kind: '地点', detail: '有雾' }],
        world: [{ name: '某规则', kind: '规则', detail: '不许夜行', quote: '' }],
        premise: '',
      }),
    )
    expect(lore.characters.map((item) => item.name)).toEqual(['沈砚'])
    expect(lore.places).toEqual([])
    expect(lore.world).toEqual([])
  })

  it('survives fences and chatter', () => {
    const lore = parseLoreOutput('好的：\n```json\n{"characters":[{"name":"阿鸢","quote":"她把航图拍在桌上。"}],"places":[],"world":[],"premise":"x"}\n```')
    expect(lore.characters.map((item) => item.name)).toEqual(['阿鸢'])
  })

  it('gives up quietly on prose', () => {
    expect(parseLoreOutput('这一章讲的是沈砚发现尸体。')).toEqual(emptyLore())
  })

  it('accepts an array where an object was expected, as nothing', () => {
    expect(parseLoreOutput('[{"name":"沈砚"}]')).toEqual(emptyLore())
  })
})

describe('mergeLore', () => {
  it('keeps the longer description and sums the chapter weight', () => {
    const first: LoreResult = {
      characters: [entry({ chapters: 3, goal: '找到妹妹' })],
      places: [],
      world: [],
      premise: '一个船工找妹妹。',
    }
    const second: LoreResult = {
      characters: [entry({ chapters: 7, goal: '找到妹妹，并弄清楚她为什么在货舱里' })],
      places: [],
      world: [],
      premise: '另一句不该覆盖第一句。',
    }
    const merged = mergeLore([first, second])
    expect(merged.characters[0]?.chapters).toBe(10)
    expect(merged.characters[0]?.goal).toContain('为什么在货舱里')
    // The first premise wins: the opening is where a book says what it is.
    expect(merged.premise).toBe('一个船工找妹妹。')
  })

  it('unions aliases across readings', () => {
    const merged = mergeLore([
      { characters: [entry({ aliases: ['阿砚'] })], places: [], world: [], premise: '' },
      { characters: [entry({ aliases: ['砚哥', '阿砚'] })], places: [], world: [], premise: '' },
    ])
    expect(merged.characters[0]?.aliases).toEqual(['阿砚', '砚哥'])
  })

  it('sorts the cast by how much of the book they are in', () => {
    const merged = mergeLore([
      {
        characters: [entry({ name: '路人', chapters: 1 }), entry({ name: '裘月寒', chapters: 80 })],
        places: [],
        world: [],
        premise: '',
      },
    ])
    expect(merged.characters.map((item) => item.name)).toEqual(['裘月寒', '路人'])
  })
})

describe('characterFromLore', () => {
  it('never invents a voice', () => {
    // `voice` is what the character-consistency reviewer compares against. A
    // guessed one turns every later growth into a reported defect.
    const created = characterFromLore(entry())
    expect(created.voice).toBe('')
    expect(created.appearance).toBe('左手少一根指节')
  })

  it('does not promote anyone on the strength of a reading', () => {
    // `role` is what the phase gate counts; promoting on a guess would open the
    // outline gate for a book that is not ready.
    expect(roleForNewCard()).toBe('supporting')
    expect(characterFromLore(entry()).role).toBe('supporting')
  })

  it('keeps the line it was read from, so the author can check it', () => {
    const created = characterFromLore(entry())
    expect(created.notes).toContain('握桨时看不出')
  })
})

describe('topUpFromLore', () => {
  it('fills only the blanks', () => {
    const next = topUpFromLore(card({ goal: '拿回航图' }), entry())
    expect(next.goal).toBe('拿回航图')
    expect(next.appearance).toBe('左手少一根指节')
    expect(next.secret).toBe('他烧过一艘船')
  })

  it('never touches the voice the author wrote', () => {
    const next = topUpFromLore(card(), entry())
    expect(next.voice).toBe('短句')
  })

  it('adds aliases only when the card has none', () => {
    const bare = topUpFromLore(card(), entry({ aliases: ['阿砚'] }))
    expect(bare.aliases).toEqual(['阿砚'])
    const withAliases = topUpFromLore(card({ aliases: ['砚哥'] }), entry({ aliases: ['阿砚'] }))
    expect(withAliases.aliases).toEqual(['砚哥'])
  })
})

describe('placing a reading on the book', () => {
  it('gives a place its first chapter and a first state', () => {
    const place = placeFromLore({ name: '雾港', kind: '城市', detail: '终年起雾', chapters: 2, quote: '雾港看不见对岸。' }, 3)
    expect(place.firstChapter).toBe(3)
    expect(place.states).toHaveLength(1)
    expect(place.states[0]?.chapter).toBe(3)
  })

  it('leaves the state list empty rather than inventing a description', () => {
    const place = placeFromLore({ name: '雾港', kind: '城市', detail: '', chapters: 1, quote: '雾港。' }, 3)
    expect(place.states).toEqual([])
  })

  it('turns a world reading into an entry', () => {
    const entryOut = worldFromLore({ name: '漕帮', kind: '势力', detail: '管着半个港口的货', quote: '漕帮不走夜路。' })
    expect(entryOut.kind).toBe('势力')
    expect(entryOut.name).toBe('漕帮')
  })
})
