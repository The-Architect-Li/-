/** Tri-state field merging: silence, value, explicit clear. */
import { describe, expect, it } from 'vitest'
import { concrete, mentioned, mergeField } from '../src/domain/fields.ts'

describe('mergeField', () => {
  it('takes the strongest layer that mentions the field', () => {
    const project = { model: 'glm-4' }
    const global = { model: 'doubao-pro', maxTokens: 4096 }
    expect(mergeField([project, global], 'model')).toBe('glm-4')
    expect(mergeField([project, global], 'maxTokens')).toBe(4096)
  })

  it('falls through layers that never mention the field', () => {
    expect(mergeField([{}, { maxTokens: 2048 }], 'maxTokens')).toBe(2048)
  })

  it('returns undefined when every layer is silent', () => {
    expect(mergeField([{}, undefined], 'provider')).toBeUndefined()
  })

  it('treats null as an explicit clear that beats a lower layer', () => {
    const project = { maxTokens: null }
    const global = { maxTokens: 4096 }
    expect(mergeField([project, global], 'maxTokens')).toBeUndefined()
  })

  it('lets one field be cleared without touching its neighbours', () => {
    const project = { provider: 'zai', reasoningEffort: null }
    const global = { maxTokens: 4096, reasoningEffort: 'high' }
    expect(mergeField([project, global], 'provider')).toBe('zai')
    expect(mergeField([project, global], 'maxTokens')).toBe(4096)
    expect(mergeField([project, global], 'reasoningEffort')).toBeUndefined()
  })
})

describe('mentioned', () => {
  it('counts a null as mentioned', () => {
    expect(mentioned([{ model: null }], 'model')).toBe(true)
  })

  it('does not count an absent field', () => {
    expect(mentioned([{}, undefined], 'model')).toBe(false)
  })
})

describe('concrete', () => {
  it('drops clears and keeps values', () => {
    expect(concrete({ provider: 'zai', model: null, maxTokens: 512 })).toEqual({
      provider: 'zai',
      maxTokens: 512,
    })
  })
})
