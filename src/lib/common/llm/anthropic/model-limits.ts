/**
 * Per-model context windows, and the free estimator that gates the paid
 * `count_tokens` pre-flight.
 *
 * WHY A HARDCODED TABLE: the Models API (`models.retrieve(id).max_input_tokens`)
 * is the authoritative source, but reading it at runtime puts a network call on
 * the boot path of a seam whose entire selling point is that it is testable
 * without IO — and you would need a hardcoded fallback for when that call fails
 * anyway, so you would end up maintaining the table regardless.
 *
 * Instead the table IS the source of truth at runtime, and `model-limits.test.ts`
 * calls the live Models API and fails CI if it has drifted. You get the accuracy
 * of the API without paying for it on every boot. When a new model ships, CI
 * tells you before production does.
 */

/** Context window (max INPUT tokens) per model. Verified against the Models API in CI. */
export const CONTEXT_WINDOW: Record<string, number> = {
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
}

/**
 * Chars per token, for the FREE pre-flight estimate.
 *
 * The familiar `chars/4` rule of thumb comes from OpenAI's tokenizer and
 * UNDER-counts Claude — by roughly 15-20% on prose, and considerably worse on
 * code and non-English text. An under-counting guard is a guard that silently
 * stops guarding: it waves through a prompt that will not fit, and we pay for
 * the request to find out.
 *
 * So the divisor is deliberately biased LOW (chars/3), which over-estimates the
 * token count. Over-estimating costs at most one extra `count_tokens` call on a
 * borderline prompt. Under-estimating costs a failed inference request. The
 * asymmetry is the whole reason for the number.
 */
const CHARS_PER_TOKEN = 3

/**
 * Fraction of the window at which we stop guessing and pay for a real count.
 * Below this, the estimate is nowhere near the limit and the API call is waste.
 */
const PREFLIGHT_THRESHOLD = 0.9

/**
 * `undefined` for a model we have no entry for.
 *
 * The caller must NOT default to some number: guessing a window is worse than
 * having none. A 200k default against a 1M-window model would reject perfectly
 * valid prompts as "too large" and chunk them for nothing.
 */
export function contextWindow(model: string): number | undefined {
  return CONTEXT_WINDOW[model]
}

/** Free, deterministic, no network. Biased to over-count — see `CHARS_PER_TOKEN`. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Is this prompt close enough to the limit that a real `count_tokens` call is
 * worth the round trip?
 *
 * False for the small requests that are most traffic — they cost zero extra
 * calls. Unknown model: false, because we cannot make a meaningful comparison
 * and a pre-flight against a made-up window tells us nothing.
 */
export function needsTokenPreflight(model: string, text: string): boolean {
  const window = contextWindow(model)
  if (window === undefined) return false
  return estimateTokens(text) > window * PREFLIGHT_THRESHOLD
}
