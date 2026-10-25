/**
 * A review question that comes with its own answer.
 *
 * A reviewer can see that a man is not acting like his card says he is, but only
 * the author knows whether that is growth or a mistake. v0.28 makes the reviewer
 * hand back the turn already spelled out, so saying "yes, he changed" is one tool
 * call instead of transcribing four arguments out of a paragraph.
 */
import { describe, expect, it } from 'vitest'
import { parseReviewerOutput, ROLES } from '../src/roles.ts'

/** A finding that proposes a turn, with all four arguments filled. */
const WITH_SHIFT = JSON.stringify([
  {
    severity: 'warn',
    code: 'character/shift',
    message: '沈砚第一次替人圆谎，这不是他的性格。',
    evidence: '「阿蘅的事，我不知道。」',
    shift: {
      name: '沈砚',
      chapter: 2,
      from: '认死理，不肯把话说圆',
      to: '开始替人圆谎',
      cause: '他撞见阿蘅半夜从账房出来，手里有父亲的账本',
    },
  },
])

/** The same question, half filled: it must stay a question. */
const HALF_SHIFT = JSON.stringify([
  {
    severity: 'warn',
    code: 'character/shift',
    message: '沈砚像是变了。',
    evidence: '「我不知道。」',
    shift: { name: '沈砚', chapter: 2, from: '认死理' },
  },
])

/** A turn attached to a finding that is not asking the question. */
const WRONG_CODE = JSON.stringify([
  {
    severity: 'warn',
    code: 'character/drift',
    message: '对不上。',
    evidence: '「我不知道。」',
    shift: { name: '沈砚', chapter: 2, from: 'a', to: 'b', cause: 'c' },
  },
])

describe('parsing a reviewer answer that carries a turn', () => {
  it('keeps a complete turn, numbers and all', () => {
    const parsed = parseReviewerOutput(WITH_SHIFT)
    expect(parsed.parsed).toBe(true)
    expect(parsed.items[0]?.shift).toEqual({
      name: '沈砚',
      chapter: 2,
      from: '认死理，不肯把话说圆',
      to: '开始替人圆谎',
      cause: '他撞见阿蘅半夜从账房出来，手里有父亲的账本',
    })
  })

  it('drops a half-filled turn but keeps the finding as a plain question', () => {
    const parsed = parseReviewerOutput(HALF_SHIFT)
    expect(parsed.items).toHaveLength(1)
    expect(parsed.items[0]?.code).toBe('character/shift')
    expect(parsed.items[0]?.shift).toBeUndefined()
  })

  it('ignores a turn hung on a finding that is not character/shift', () => {
    const parsed = parseReviewerOutput(WRONG_CODE)
    expect(parsed.items[0]?.code).toBe('character/drift')
    expect(parsed.items[0]?.shift).toBeUndefined()
  })

  it('refuses a turn with no chapter number', () => {
    const parsed = parseReviewerOutput(
      JSON.stringify([
        {
          severity: 'warn',
          code: 'character/shift',
          message: 'x',
          evidence: 'y',
          shift: { name: '沈砚', from: 'a', to: 'b', cause: 'c' },
        },
      ]),
    )
    expect(parsed.items[0]?.shift).toBeUndefined()
  })
})

describe('what the reviewer is told to answer with', () => {
  it('documents the shift object in the contract', () => {
    expect(ROLES.character.outputContract).toContain('character/shift')
    expect(ROLES.character.outputContract).toContain('shift')
    expect(ROLES.character.outputContract).toContain('character/drift')
  })

  it('asks for the author\'s words, not the reviewer\'s verdict', () => {
    expect(ROLES.character.outputContract).toContain('作者自己的话')
  })
})
