import { describe, expect, it } from 'bun:test'
import { validateItemInput } from './validate-item-input'

describe('validateItemInput', () => {
  it('trims the title and defaults done to false', () => {
    expect(validateItemInput({ title: '  Buy nails  ' })).toEqual({
      title: 'Buy nails',
      done: false,
    })
  })

  it('rejects a blank title', () => {
    expect(() => validateItemInput({ title: '   ' })).toThrow('Title is required')
  })
})
