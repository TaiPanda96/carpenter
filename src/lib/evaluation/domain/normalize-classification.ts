import type { ZodIssue } from 'zod'
import { type ClassificationInput, classificationInputSchema } from './classification-input'

/** A record that failed validation, retained with the reason it was dropped. */
export interface SkippedRecord {
  raw: unknown
  reason: ZodIssue[]
}

export interface NormalizedClassification {
  valid: ClassificationInput[]
  skippedRecords: SkippedRecord[]
}

/**
 * Validate raw records against the boundary schema, keeping the good ones and
 * recording *why* each bad one was skipped. Pure, no IO, never throws — the seam
 * between untrusted input and the evaluator. A malformed row is a data-quality
 * issue, so it is skipped-and-recorded rather than fatal.
 */
export function normalizeClassification(records: unknown[]): NormalizedClassification {
  const valid: ClassificationInput[] = []
  const skippedRecords: SkippedRecord[] = []

  for (const raw of records) {
    const parsed = classificationInputSchema.safeParse(raw)
    if (parsed.success) {
      valid.push(parsed.data)
    } else {
      skippedRecords.push({ raw, reason: parsed.error.issues })
    }
  }

  return { valid, skippedRecords }
}
