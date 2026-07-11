import type { ClassificationInput } from './classification-input'
import { type SkippedRecord, normalizeClassification } from './normalize-classification'

export type ClassificationLabel = string

/** Per-class scorecard. `null` marks an undefined metric — never coerced to 0. */
export interface ClassEvalResult {
  support: number // # gold instances of this label
  predicted: number // # times the model emitted this label
  tp: number // true positives (gold === predicted === label)
  precision: number | null // null when predicted === 0 (0/0 undefined)
  recall: number | null // null when support === 0
  f1: number | null // null when precision or recall is null
}

export interface ClassifierEvaluationResult {
  labels: ClassificationLabel[] // resolved universe, sorted
  perClass: Record<ClassificationLabel, ClassEvalResult>
  overallAccuracy: number // micro: correct / evaluated (0 when evaluated === 0)
  macroF1Score: number // unweighted mean of per-class F1, null F1 → 0
  imbalanceTax: number // signed: overallAccuracy − macroF1Score
  groupByIncorrectLabels: Record<ClassificationLabel, ClassificationInput[]> // keyed by gold
  evaluated: number // valid rows scored
  skippedRecords: SkippedRecord[] // dropped malformed rows + reason
}

export interface EvaluateConfig {
  /** The allowed label universe. When set, an out-of-universe label is fatal. */
  labels?: string[]
}

/**
 * Thrown when an explicit label universe is configured and the data contains a
 * label outside it. A configured universe is a contract about the system; a
 * violation is a harness misconfiguration, not a per-row data issue, so it
 * fails fast rather than being silently dropped.
 */
export class LabelUniverseError extends Error {
  constructor(public readonly offending: string[]) {
    super(`Observed labels outside the configured universe: ${offending.join(', ')}`)
    this.name = 'LabelUniverseError'
  }
}

/** F1 = harmonic mean of precision & recall; null if either is undefined. */
function f1Score(precision: number | null, recall: number | null): number | null {
  if (precision === null || recall === null) return null
  if (precision + recall === 0) return 0
  return (2 * precision * recall) / (precision + recall)
}

/**
 * Resolve the label universe. With a config, every observed label must be in it
 * (else `LabelUniverseError`) and the config *is* the universe — so a configured
 * label with zero data still surfaces as untested. Without one, the universe is
 * the sorted, de-duplicated union of every observed gold and predicted value.
 */
function resolveLabels(
  rows: ClassificationInput[],
  config?: EvaluateConfig,
): ClassificationLabel[] {
  const observed = new Set<string>()
  for (const r of rows) {
    observed.add(r.gold)
    observed.add(r.predicted)
  }

  if (config?.labels) {
    const allowed = new Set(config.labels)
    const offending = [...observed].filter((l) => !allowed.has(l))
    if (offending.length > 0) throw new LabelUniverseError(offending.sort())
    return [...allowed].sort()
  }

  return [...observed].sort()
}

/**
 * Evaluate classifier predictions into a class-aware, decision-grade scorecard.
 * Pure, deterministic, no ctx and no IO — file reading belongs to the boundary.
 *
 * Composes: normalize (skip malformed) → resolve universe → per-class
 * precision/recall/F1 → micro accuracy + macro-F1 + imbalance tax → group errors
 * by gold class. Accuracy alone lies under class imbalance; macro-F1 (which
 * counts a never-predicted class as 0) is the honest read, and the signed gap
 * between them is the imbalance tax.
 */
export function evaluateClassification(
  records: unknown[],
  config?: EvaluateConfig,
): ClassifierEvaluationResult {
  const { valid, skippedRecords } = normalizeClassification(records)
  const labels = resolveLabels(valid, config)

  const perClass: Record<ClassificationLabel, ClassEvalResult> = {}
  const groupByIncorrectLabels: Record<ClassificationLabel, ClassificationInput[]> = {}
  for (const label of labels) {
    groupByIncorrectLabels[label] = []
  }

  for (const label of labels) {
    let support = 0
    let predicted = 0
    let tp = 0
    for (const r of valid) {
      if (r.gold === label) support++
      if (r.predicted === label) predicted++
      if (r.gold === label && r.predicted === label) tp++
    }
    const precision = predicted === 0 ? null : tp / predicted
    const recall = support === 0 ? null : tp / support
    perClass[label] = { support, predicted, tp, precision, recall, f1: f1Score(precision, recall) }
  }

  for (const r of valid) {
    if (r.gold !== r.predicted) groupByIncorrectLabels[r.gold].push(r)
  }

  const evaluated = valid.length
  const correct = valid.reduce((n, r) => n + (r.gold === r.predicted ? 1 : 0), 0)
  const overallAccuracy = evaluated === 0 ? 0 : correct / evaluated
  const macroF1Score =
    labels.length === 0 ? 0 : labels.reduce((s, l) => s + (perClass[l].f1 ?? 0), 0) / labels.length
  const imbalanceTax = overallAccuracy - macroF1Score

  return {
    labels,
    perClass,
    overallAccuracy,
    macroF1Score,
    imbalanceTax,
    groupByIncorrectLabels,
    evaluated,
    skippedRecords,
  }
}
