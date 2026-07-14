/**
 * The RESULT contract: what the model SAID, and what it COST.
 *
 * NO ZOD HERE, deliberately. These types are built by our own deterministic code
 * (`mapUsage` / `mapStopReason` in the adapter) out of a wire response that has
 * ALREADY been validated at the real trust boundary
 * (`anthropicResponseProjectionSchema`). Handing them a second zod schema would be
 * parsing our own output — the smell CLAUDE.md names — and it would ship the schema
 * machinery for zero runtime benefit, since nothing ever calls `.parse()` on it.
 *
 * Validate untrusted input ONCE, at the boundary. This is not the boundary.
 *
 * The routing decision does NOT live here — it lives in `llm-disposition.ts`,
 * because it is provider-agnostic and it is what consumers actually switch on.
 */

/**
 * What the call cost.
 *
 * Cache tokens are nullable, not zero-defaulted: `null` means the provider did not
 * report the field, `0` means it reported a genuine cache miss. Collapsing those two
 * makes a cost dashboard quietly wrong — a provider that stops REPORTING cache reads
 * would look identical to a cache that stopped WORKING.
 */
export interface LlmUsage {
  inputTokens: number
  outputTokens: number
  /** Tokens served from the prompt cache (~0.1x price). Null = not reported. */
  cacheReadTokens: number | null
  /** Tokens written to the prompt cache (~1.25x price). Null = not reported. */
  cacheWriteTokens: number | null
}

/**
 * The normalized stop reason: "why did generation end?"
 *
 * NOT the same question as `outcome.route`, which is "what do I do with this job?"
 * A 413 and a `max_tokens` stop both route to `decompose`, but they are different
 * stops with opposite remedies — chunk the input vs. raise the budget.
 *
 * `providerReason` keeps the raw string beside every normalized variant, so the
 * normalization stays auditable.
 */
export type LlmCompletionStop =
  | { kind: 'complete'; providerReason: 'end_turn' }
  | { kind: 'stop_sequence'; providerReason: 'stop_sequence' }
  /** Output was CUT at the cap; the input fit fine. REMEDY: raise the budget. */
  | { kind: 'max_tokens'; providerReason: 'max_tokens' }
  /** The INPUT did not fit. A bigger output budget cannot fix this. REMEDY: chunk it. */
  | {
      kind: 'context_window_exceeded'
      providerReason: 'model_context_window_exceeded'
    }
  /**
   * The model is waiting on a tool result. Terminal ONLY for `generateObject`, where
   * the forced tool firing IS the answer. For `complete()` — which sends no tools —
   * this is impossible, and the adapter routes it to `alert` rather than inventing a
   * meaning for it.
   */
  | { kind: 'tool_use'; providerReason: 'tool_use' }
  | { kind: 'refusal'; providerReason: 'refusal' }
  | { kind: 'other'; providerReason: string | null }

/** What `complete()` produces when the model answers in prose. */
export interface LlmCompletion {
  text: string
  stop: LlmCompletionStop
}

/**
 * What `generateObject()` produces.
 *
 * `raw` is the tool_use block's untouched `input`, kept beside the parsed value:
 * when a downstream check says the model lied, this is the only evidence of what it
 * actually said.
 */
export interface LlmObjectValue<T> {
  object: T
  raw: unknown
  stop: LlmCompletionStop
}

/**
 * Sum the cost of two attempts at the same job.
 *
 * WHY this exists: a retried call costs the sum of every attempt, not the cost of the
 * one that happened to succeed. A truncation that burned 4k output tokens and then
 * succeeded on a doubled budget was billed for BOTH — and the whole reason
 * `routeNonTerminalStop` keeps `usage` on a truncation is that a paid-for failure must
 * not look free. Reporting only the last attempt would throw that away one layer up,
 * which is exactly the bug the retained usage was defending against.
 *
 * Null is preserved, not zeroed, on the same principle as `LlmUsage` itself: if
 * NEITHER attempt reported a cache field, the total has not reported it either. Only
 * once some attempt reports a number does the sum become a number.
 */
export function addUsage(a: LlmUsage | null, b: LlmUsage | null): LlmUsage | null {
  if (a === null) return b
  if (b === null) return a
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: addReported(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: addReported(a.cacheWriteTokens, b.cacheWriteTokens),
  }
}

/** `null + null` is still "not reported". `null + 5` is 5 — one attempt reported. */
function addReported(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null
  return (a ?? 0) + (b ?? 0)
}
