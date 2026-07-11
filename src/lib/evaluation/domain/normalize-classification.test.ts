import { describe, expect, it } from 'bun:test'
import { normalizeClassification } from './normalize-classification'

describe('normalizeClassification', () => {
  it('keeps well-formed rows and skips malformed ones with a reason', () => {
    const good = { id: 't01', text: 'hi', gold: 'billing', predicted: 'billing' }
    const records = [
      good,
      { id: 't02', text: 'missing predicted', gold: 'technical' }, // no predicted
      null, // not an object at all
      'not-json-at-all',
    ]

    const { valid, skippedRecords } = normalizeClassification(records)

    expect(valid).toEqual([good])
    expect(skippedRecords).toHaveLength(3)
    // The reason is the raw Zod issues, and the offending row is retained.
    expect(skippedRecords[0].raw).toEqual(records[1])
    expect(skippedRecords[0].reason.length).toBeGreaterThan(0)
    expect(skippedRecords[1].raw).toBeNull()
  })

  it('never throws on garbage input', () => {
    const { valid, skippedRecords } = normalizeClassification([undefined, 42, [], {}])
    expect(valid).toHaveLength(0)
    expect(skippedRecords).toHaveLength(4)
  })
})
