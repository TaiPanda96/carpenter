---
id: spec-001
type: backend
scope: broad
status: ready
---

## Goal
Build a pure, class-aware classification evaluator that turns validated
`{id, text, gold, predicted}` records into a typed `ClassifierEvaluationResult`
scorecard a downstream consumer can act on.

## Requirements

- REQ-1: Define `ClassificationInput` as a Zod schema + inferred type in
  `src/lib/evaluation/domain/classification-input.ts`, shape
  `{ id: string, text: string, gold: string, predicted: string }`. One primary
  export (the schema); export the inferred type alongside.
- REQ-2: Implement `normalizeClassification(records: unknown[])` in
  `src/lib/evaluation/domain/normalize-classification.ts` — pure, no IO. It
  `safeParse`s each record against the REQ-1 schema, **skips** malformed rows,
  and returns `{ valid: ClassificationInput[]; skippedRecords: SkippedRecord[] }`
  where `SkippedRecord = { raw: unknown; reason: ZodIssue[] }` (the `safeParse`
  issues, which also capture a literal `null`/`undefined` row). No throw.
- REQ-3: Resolve the label universe in
  `evaluateClassification`: accept an optional `labels?: string[]` config.
  - When **absent**, derive it as the sorted, de-duplicated union of every
    observed `gold` and `predicted` value.
  - When **supplied**, fail fast: if any observed `gold` or `predicted` value is
    not in the config set, throw a typed `LabelUniverseError` (a typed error
    class, never a thrown string). Rationale: a malformed row is a data-quality
    issue (skip, REQ-2); a label outside an explicit config is a harness
    misconfiguration and must surface, not be swallowed.
- REQ-4: Compute per-class stats as `Record<ClassificationLabel, ClassEvalResult>`
  where `ClassEvalResult = { support, predicted, tp, precision: number|null,
  recall: number|null, f1: number|null }`. `precision` is `null` when
  `predicted === 0` (0/0 undefined); `recall` is `null` when `support === 0`;
  `f1` is `null` when either input is `null`.
- REQ-5: Compute aggregates: `overallAccuracy` (micro — correct / evaluated),
  `macroF1Score` (unweighted mean of per-class F1, where a `null` per-class F1
  counts as `0`), and `imbalanceTax` (signed `overallAccuracy − macroF1Score`).
  - Oracle: against `docs/specs/classification.jsonl` this MUST yield
    `overallAccuracy ≈ 0.611`, `macroF1Score ≈ 0.50` (this pins `null → 0` for
    `feedback`), and `imbalanceTax ≈ +0.11`.
- REQ-6: Group every misclassified record (`gold !== predicted`) **by its `gold`
  label** into `groupByIncorrectLabels: Record<ClassificationLabel,
  ClassificationInput[]>`. Each entry retains the full record (so its `predicted`
  value is preserved, making the by-`predicted` view reconstructable). Every
  universe label is a key; a class with no errors maps to `[]`.
- REQ-7: Assemble and return `ClassifierEvaluationResult` from
  `evaluateClassification(records, config?)` in
  `src/lib/evaluation/domain/evaluate-classification.ts` — pure, no `ctx`, no IO,
  deterministic. Composes REQ-2 → REQ-3 → REQ-4 → REQ-5 → REQ-6. The result
  carries `evaluated: number` (valid rows scored) and `skippedRecords`
  (from REQ-2) so the SKIP is observable. See the Output Contract below for the
  canonical shape.
- REQ-8: Provide a CLI boundary at `src/bin/evaluate.ts` that reads a `.jsonl`
  file, JSONL-parses each line, calls `evaluateClassification`, and prints the
  scorecard. This is the ONLY IO in the slice (mirrors `src/bin/script.ts`'s
  Commander/read/print shape).

## Output Contract

```typescript
type ClassificationLabel = string

interface ClassEvalResult {
  support: number             // # gold instances of this label
  predicted: number           // # times the model emitted this label
  tp: number
  precision: number | null    // null when predicted === 0 (0/0 undefined)
  recall: number | null       // null when support === 0
  f1: number | null           // null when precision or recall is null
}

interface SkippedRecord {
  raw: unknown                // the row that failed validation
  reason: ZodIssue[]          // safeParse issues (covers null/undefined rows)
}

interface ClassifierEvaluationResult {
  labels: ClassificationLabel[]                          // resolved universe, sorted
  perClass: Record<ClassificationLabel, ClassEvalResult> // (draft: perClassRecallResults — see WARNING-7)
  overallAccuracy: number                                // micro: correct / evaluated
  macroF1Score: number                                   // mean per-class F1, null → 0
  imbalanceTax: number                                   // signed: overallAccuracy − macroF1Score
  groupByIncorrectLabels: Record<ClassificationLabel, ClassificationInput[]> // keyed by gold
  evaluated: number                                      // valid rows scored
  skippedRecords: SkippedRecord[]                        // dropped malformed rows + reason
}
```

## Context Discovery
- `src/lib/items/domain/validate-item-input.ts` — reference for the Zod-schema +
  inferred-type + pure-validate pattern; mirror it for `ClassificationInput`
  (REQ-1). Note it uses `.parse` (throws); REQ-2 uses `.safeParse` (skips).
- `src/lib/items/domain/create-item.ts` — reference domain shape. IMPORTANT
  deviation: `createItem` takes `ContextWith<'prisma'>`; the evaluator touches
  no IO and takes **no ctx** (see WARNING-6). Do not add a ctx param.
- `src/lib/items/domain/create-item.test.ts` — `bun:test` structure to mirror
  for the evaluator/normalize tests. No `createMockContext` needed — the units
  are pure.
- `src/lib/common/io/context/create-context.ts` — read only to confirm the
  evaluator requires no `Context` slice (no external dependency to register).
- `src/bin/script.ts` — existing Commander CLI that already reads
  `classification.jsonl`, validates rows with Zod, and computes
  precision/recall/F1/confusion. REQ-8 mirrors its IO/parse/print; its inlined
  metric logic is what REQ-4/5 lift into the pure domain.
- `docs/specs/CASE_INVESTIGATIONS.md` — the numeric oracle (accuracy 61.1%,
  macro-F1 0.50, `feedback` precision `null`/never-predicted). Use as the test
  fixture's expected values.
- `docs/specs/classification.jsonl` — the 18-row fixture input for the script
  and the integration assertion in DoD.

## File Mapping
| File | Action |
|------|--------|
| `src/lib/evaluation/domain/classification-input.ts` | Create — `ClassificationInput` Zod schema + type (REQ-1) |
| `src/lib/evaluation/domain/normalize-classification.ts` | Create — pure safeParse + skip (REQ-2) |
| `src/lib/evaluation/domain/normalize-classification.test.ts` | Create — happy path + malformed-skip |
| `src/lib/evaluation/domain/evaluate-classification.ts` | Create — pure evaluator + result types + `LabelUniverseError` (REQ-3–7) |
| `src/lib/evaluation/domain/evaluate-classification.test.ts` | Create — oracle + never-predicted-class + out-of-universe fail-fast cases |
| `src/bin/evaluate.ts` | Create — CLI boundary (REQ-8) |

## Constraints
- Every external input validated with Zod at the boundary **before use**;
  `.safeParse` per SPEC_CONVENTIONS, `zodIssues` captured in returned metadata
  (REQ-2), not thrown.
- Typed errors, never throw strings. Malformed rows are skipped-and-recorded in
  `skippedRecords`, not thrown (REQ-2). The ONE throw is `LabelUniverseError`
  when an explicit `labels` config is supplied and an observed label falls
  outside it (REQ-3) — a typed error class.
- Domain logic is pure / deterministic, unit-tested with `bun:test`. Prefer
  functions over classes. The evaluator takes **no `ctx`** — it has no IO.
- All file/`.jsonl` reading lives in the `src/bin` boundary (REQ-8), never in
  `/domain`.
- Files kebab-case; one primary export per file; JSDoc (what + why) on exports.
- No new dependencies (`commander` + `zod` already present).
- Numeric conventions (REQ-4/5): `precision` null on 0 predictions, `recall`
  null on 0 support, `f1` null when either null, macro-F1 treats null F1 as 0.

## Definition of Done
- [ ] `bun run typecheck` passes.
- [ ] `bun run lint` passes on new files.
- [ ] `bun test` green, covering: (a) happy-path evaluate, (b) malformed rows
      captured in `skippedRecords` with `reason`, (c) never-predicted class →
      `precision: null`, `recall: 0`, and its F1 counted as 0 in macro-F1,
      (d) out-of-universe label with an explicit config throws `LabelUniverseError`.
- [ ] The CLI (REQ-8) run against `docs/specs/classification.jsonl` reproduces
      `overallAccuracy ≈ 0.611`, `macroF1Score ≈ 0.50`, `imbalanceTax ≈ +0.11`.

## Notes

> **BLOCKER-1 — `groupByIncorrectLabels` cannot hold its data.** Draft types it
> `Record<ClassificationLabel, ClassificationInput>` (singular). `feedback` has 3
> misclassified records; one `ClassificationInput` per class drops two of them.
> Also undefined: group by `gold` (answers "where does class X fail") or by
> `predicted` (answers "what pollutes bucket X")? Resolve the element type
> (recommend `ClassificationInput[]`) and the grouping key before build. REQ-6 is
> blocked on this.
**RESOLUTION** -> Good catch, updated to [].


> **BLOCKER-2 — `groupByClassificationLabelCount` is self-contradictory.** Field
> name says "Count", type is `number[]`, comment says "input record array". Its
> gold-vs-predicted basis and its purpose are all unspecified, and it may be
> redundant with `support`/`predicted` in `ClassEvalResult`. Either cut it (per
> CLAUDE.md "no abstraction until a second concrete use case") or specify
> exactly what it holds and why. REQ-7 is blocked on this.
**RESOLUTION** -> Good catch, removed.

> **BLOCKER-3 — SKIP is not observable in the output.** REQ-2 skips malformed
> rows, which shifts every recall/precision/accuracy denominator, but
> `ClassifierEvaluationResult` has no `evaluated`/`skipped` field. A consumer
> cannot tell a scorecard was computed on a subset. Add `evaluated: number` and
> `skipped: number` to the result, or explicitly confirm skip counts are
> log-only.
**RESOLUTION** -> Good catch, let's add a `skippedRecords` property with a `skipReason` -> `null/undefined` for this case.

> **BLOCKER-4 — out-of-universe labels undefined.** REQ-3 defines the no-config
> union fallback, but when a `labels` config IS supplied and a `gold`/`predicted`
> value falls outside it, behavior (drop / error / own-bucket) is unspecified.
- **RESOLUTION** -> Fail fast, this is a fundamental error in the evaluation harness. The config upstream should be consistent with the system. We don't want to swallow or silently handle this downstream.

> **BLOCKER-5 — script target collides.** `src/bin/script.ts` already contains
> the CASE synthesis. The draft DoD says run the evaluator under
> `src/bin/scripts`. File Mapping proposes a new `src/bin/evaluate-classification.ts`
> to avoid clobbering, but overwrite-vs-new-file is the author's call.
- **RESOLUTION** -> `src/bin/evaluate.ts`

> **WARNING-6 — intentional deviation from the reference pattern.** The `items`
> slice injects `ContextWith<'prisma'>`; this evaluator is genuinely pure (no
> IO), so it takes no ctx. This is correct, not an omission — do not "fix" it by
> adding a ctx param.

> **WARNING-7 — field renames for honesty (non-blocking).** Two draft names now
> mislead and this spec renames them in the Output Contract: `averageAccuracy`
> → `overallAccuracy` (it's micro, not an average), and `perClassRecallResults`
> → `perClass` (it holds precision + recall + f1, not just recall). Confirm or
> veto the final names.

> **WARNING-8 — input seam.** Draft's `evaluator(input: jsonl)` conflates the
> pure evaluator with jsonl parsing. This spec splits them: the evaluator takes
> already-parsed `unknown[]`/records; the `src/bin` script owns file read + JSONL
> line-splitting.
