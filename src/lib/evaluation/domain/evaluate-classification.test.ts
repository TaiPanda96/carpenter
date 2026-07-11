import { describe, expect, it } from 'bun:test'
import { LabelUniverseError, evaluateClassification } from './evaluate-classification'

// The 18-row fixture (docs/specs/classification.jsonl), inlined so the numeric
// oracle is asserted deterministically without file IO.
const FIXTURE = [
  { id: 't01', text: 'x', gold: 'billing', predicted: 'billing' },
  { id: 't02', text: 'x', gold: 'billing', predicted: 'billing' },
  { id: 't03', text: 'x', gold: 'billing', predicted: 'billing' },
  { id: 't04', text: 'x', gold: 'billing', predicted: 'technical' },
  { id: 't05', text: 'x', gold: 'billing', predicted: 'account' },
  { id: 't06', text: 'x', gold: 'billing', predicted: 'billing' },
  { id: 't07', text: 'x', gold: 'technical', predicted: 'technical' },
  { id: 't08', text: 'x', gold: 'technical', predicted: 'technical' },
  { id: 't09', text: 'x', gold: 'technical', predicted: 'technical' },
  { id: 't10', text: 'x', gold: 'technical', predicted: 'technical' },
  { id: 't11', text: 'x', gold: 'technical', predicted: 'billing' },
  { id: 't12', text: 'x', gold: 'account', predicted: 'account' },
  { id: 't13', text: 'x', gold: 'account', predicted: 'account' },
  { id: 't14', text: 'x', gold: 'account', predicted: 'account' },
  { id: 't15', text: 'x', gold: 'account', predicted: 'billing' },
  { id: 't16', text: 'x', gold: 'feedback', predicted: 'technical' },
  { id: 't17', text: 'x', gold: 'feedback', predicted: 'account' },
  { id: 't18', text: 'x', gold: 'feedback', predicted: 'billing' },
]

describe('evaluateClassification', () => {
  it('reproduces the CASE oracle on the fixture', () => {
    const r = evaluateClassification(FIXTURE)

    expect(r.evaluated).toBe(18)
    expect(r.labels).toEqual(['account', 'billing', 'feedback', 'technical'])
    expect(r.overallAccuracy).toBeCloseTo(0.611, 3)
    expect(r.macroF1Score).toBeCloseTo(0.5, 2)
    expect(r.imbalanceTax).toBeCloseTo(0.11, 2)
    // Imbalance tax is the signed gap; here accuracy overstates quality.
    expect(r.imbalanceTax).toBeGreaterThan(0)
  })

  it('marks a never-predicted class with null precision, not 0', () => {
    const r = evaluateClassification(FIXTURE)
    const feedback = r.perClass.feedback

    expect(feedback.support).toBe(3)
    expect(feedback.predicted).toBe(0)
    expect(feedback.tp).toBe(0)
    expect(feedback.precision).toBeNull() // 0/0 — undefined, not 0
    expect(feedback.recall).toBe(0)
    expect(feedback.f1).toBeNull()
  })

  it('groups misclassifications by gold class, retaining full records', () => {
    const r = evaluateClassification(FIXTURE)

    expect(r.groupByIncorrectLabels.feedback.map((x) => x.id)).toEqual(['t16', 't17', 't18'])
    expect(r.groupByIncorrectLabels.billing.map((x) => x.id)).toEqual(['t04', 't05'])
    expect(r.groupByIncorrectLabels.technical).toHaveLength(1)
    // A class with no errors is present as an empty array, never missing.
    expect(r.groupByIncorrectLabels.account).toHaveLength(1)
  })

  it('surfaces skipped malformed rows without failing the run', () => {
    const r = evaluateClassification([...FIXTURE, { id: 'bad', gold: 'billing' }])
    expect(r.evaluated).toBe(18)
    expect(r.skippedRecords).toHaveLength(1)
  })

  it('fails fast when a config is set and data has an out-of-universe label', () => {
    const config = { labels: ['billing', 'technical', 'account', 'feedback'] }
    const rogue = [{ id: 'x', text: 'x', gold: 'billing', predicted: 'refunds' }]

    expect(() => evaluateClassification(rogue, config)).toThrow(LabelUniverseError)
  })

  it('includes configured-but-unseen labels as untested classes', () => {
    const config = { labels: ['billing', 'technical', 'account', 'feedback', 'legal'] }
    const r = evaluateClassification(FIXTURE, config)

    expect(r.labels).toContain('legal')
    expect(r.perClass.legal).toEqual({
      support: 0,
      predicted: 0,
      tp: 0,
      precision: null,
      recall: null,
      f1: null,
    })
  })

  it('handles empty input without dividing by zero', () => {
    const r = evaluateClassification([])
    expect(r.evaluated).toBe(0)
    expect(r.overallAccuracy).toBe(0)
    expect(r.macroF1Score).toBe(0)
    expect(r.labels).toEqual([])
  })
})
