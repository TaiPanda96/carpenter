/**
 * The routing taxonomy. A pure type leaf — it imports nothing, on purpose.
 *
 * `LlmError` needs these types, and `LlmOutcome` needs `LlmError`. Keeping the
 * taxonomy in a leaf breaks what would otherwise be an import cycle:
 *
 *   llm-disposition (this file)  ->  llm-errors  ->  llm-outcome
 *
 * This is the ONE taxonomy. There used to be a second — `LlmError.kind` plus an
 * `isRetryableStatus()` helper — that cut the same space differently: `kind`
 * distinguished 401 from 403 but collapsed 500 into 529, while the routes did
 * exactly the opposite. Neither contained the other, so they were guaranteed to
 * drift. Both are deleted. The fine detail they used to carry now lives in
 * `LlmSignals`, which is a receipt rather than a second set of names.
 */

/**
 * What to DO with the job. The right-hand column of the triage diagram, and the
 * only question the adapter exists to answer.
 *
 * `tool_use` is deliberately NOT a route. In an agentic loop a `tool_use` stop
 * means the model is mid-flight and the job must stay open — but this codebase
 * has no tool loop, `complete()` sends no tools, and in `generateObject()` a
 * forced `tool_use` IS the terminal answer. A `continue` route today would be a
 * type with no implementation and no way to fire. It gets added in the same
 * commit as the loop that needs it, at which point the compiler will force every
 * switch over this union to handle it — loudly, which is the point.
 */
export type LlmRoute =
  | 'complete' // emit the result
  | 'retry' // retry queue, backoff(retryAfterMs)
  | 'decompose' // chunk queue — see DecomposeReason, the remedy differs
  | 'dead_letter' // human review
  | 'cancelled' // the caller walked away. Not a failure; nobody to page.
  | 'alert' // we do not know what this is. Page someone.

/**
 * Transient. The payload is fine; the world was busy. Same payload, backoff.
 *
 * Split by reason because they do not deserve the same treatment: `rate_limit`
 * usually carries a `retry-after` we must obey, `overloaded` (529) is provider
 * capacity rather than breakage, and `model_noncompliant` is not a backoff at all.
 */
export type RetryReason =
  | 'rate_limit' // 429
  | 'overloaded' // 529 — capacity, not breakage. The SDK lumps this in with 5xx.
  | 'server_error' // 5xx
  | 'timeout'
  | 'network'
  /**
   * The transport succeeded; the MODEL did not comply — it ignored a forced tool
   * and answered some other way. Nothing is broken and nothing is busy, so the
   * remedy is a plain resample with no backoff.
   *
   * Under `tool_choice: {type: 'tool'}` the model is FORCED, so this should be
   * near-impossible. If it happens twice it will happen a third time — which is
   * why it draws on its own tiny budget rather than the rate-limit pool. See
   * `maxResamples` in `llm-retry.ts`.
   */
  | 'model_noncompliant'

/**
 * The PAYLOAD is the problem. Retrying the same bytes burns money and changes
 * nothing — the input has to shrink.
 *
 * These two are NOT the same failure, and collapsing them into a single
 * `payload_too_large` boolean is precisely the mistake this type exists to
 * prevent:
 *
 *   `input_too_large`   — the prompt did not fit. Normally caught BEFORE the
 *                         request is paid for (the `count_tokens` pre-flight in
 *                         the adapter); otherwise a 413, a 400 whose prose says
 *                         so, or `stop_reason: model_context_window_exceeded`.
 *                         The fix is to CHUNK THE INPUT.
 *
 *   `output_truncated`  — `stop_reason: max_tokens`. The input fit fine;
 *                         generation was cut at the cap. The fix is a BIGGER
 *                         BUDGET first, and only once the ceiling is hit does the
 *                         task actually get split.
 *
 * Chunking a document that fit fine will still truncate. Raising the output
 * budget on a prompt that never fit will still fail. Same queue, opposite remedy.
 */
export type DecomposeReason = 'input_too_large' | 'output_truncated'

/** Needs a human. No amount of waiting or reshaping fixes these. */
export type DeadLetterReason =
  | 'refusal' // a 200 OK whose content must not be used
  | 'invalid_output' // the model answered in the wrong shape
  | 'invalid_request' // we built a bad request — our bug
  | 'auth' // 401/403. Dead-letters so the job survives; alert on the reason.
  | 'not_found' // bad model id — our bug

/** Every reason, across the routes that carry one. */
export type LlmReason = RetryReason | DecomposeReason | DeadLetterReason

/**
 * The raw provider signal, retained ALONGSIDE the normalization.
 *
 * Normalization is lossy by design; this is the receipt. When a route looks
 * wrong in production, these fields are the only things that can tell you
 * whether the provider changed or we mis-mapped it.
 *
 * They also carry the detail the collapsed taxonomy no longer names:
 * `httpStatus` distinguishes 401 from 403, and `providerCode` distinguishes
 * `overloaded_error` from `api_error`. That is deliberate — a receipt is a
 * better home for that than a second enum nobody keeps in sync.
 */
export interface LlmSignals {
  provider: 'anthropic'
  /** Untouched `stop_reason` off the wire. Null when the call never landed. */
  rawStopReason: string | null
  httpStatus: number | null
  /** The provider's own error code, e.g. `rate_limit_error`, `overloaded_error`. */
  providerCode: string | null
  requestId: string | null
  model: string | null
}
