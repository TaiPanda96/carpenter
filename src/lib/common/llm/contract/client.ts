/**
 * The provider-agnostic LLM seam.
 *
 * `outcome.ts` owns the ROUTING contract, `response.ts` owns the RESULT
 * contract (runtime-validated, because a response crosses a trust boundary we do
 * not control). This file owns the REQUEST contract — a plain compile-time type,
 * because the request is constructed by our own deterministic domain code, so
 * there is nothing untrusted to parse.
 *
 * Note what these methods do NOT do: throw on an operational failure. A 429, a
 * refusal, a truncation and a 529 are all things we planned for, so they are
 * VALUES — `LlmOutcome` — not exceptions. Exceptions are reserved for things
 * nobody planned for (a missing API key at construction).
 *
 * That is not a violation of "throw from domain, catch at the boundary": the
 * adapter IS the boundary. Catching the provider's failures and handing the
 * domain something it can route on is precisely its job. Code that wants to throw
 * calls `expectComplete()` — but only at the outermost leaf, and biome.json
 * enforces that.
 *
 * Domain logic depends on this interface via `ctx.llm` and never on a concrete
 * SDK, so we can swap providers and unit-test the domain with a fake.
 */

import type { LlmObjectRequest } from './object-request'
import type { LlmOutcome } from './outcome'
import type { LlmCompletion, LlmObjectValue } from './response'

/**
 * The per-request timeout when the caller names none.
 *
 * ON A STREAM THIS IS A STALL DETECTOR, NOT A DEADLINE — and that is a measured claim,
 * not a reading of the docs. An 8-second timeout was verified to survive an 89-second,
 * 5,628-token generation: the SDK's clock is reset by traffic, so what it actually
 * bounds is the gap between chunks, not the total.
 *
 * That is why 30s is right, and why the reflex to raise it "because generations can be
 * long" is wrong. A healthy long generation never approaches it. What trips it is a
 * connection that has gone quiet — which is exactly what we want to give up on.
 *
 * The corollary matters more: the timeout does NOT bound a runaway model. Something
 * that has begun repeating itself streams happily, on our money, and this number will
 * never fire. **`maxTokens` is the only runaway guard there is.** Do not lower the
 * timeout hoping to bound cost — it cannot, and all you will do is kill healthy work.
 *
 * Set `timeoutMs` per request when a caller has a real latency budget: an interactive
 * path, or a queue lease it has to renew.
 */
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * How much the model is allowed to REASON before it answers. Defaults to `adaptive`.
 *
 * It is a request field rather than an adapter constant because the two methods on
 * this seam genuinely want different things, and neither answer is right for both.
 *
 * `adaptive` — the model decides how much to think, per request. The default, because
 *   thinking is the single largest quality lever available and the reason we used to
 *   fear it is gone: thinking tokens are drawn from `maxTokens`, so with a tight cap
 *   they could eat the budget and truncate the answer. Caps are generous now.
 *
 * `disabled` — no reasoning. Worth choosing when a task is genuinely MECHANICAL: the
 *   answer is a transcription of something already stated, not a conclusion drawn from
 *   it. Cheaper (thinking tokens bill at the output rate) and lower-latency (thinking
 *   happens before the first content block, which on a streamed request is dead air).
 *
 * The trap it is NOT worth choosing for: a forced tool pins the SHAPE of the answer,
 * not the reasoning that produces it. Reconciling line items, resolving an entity
 * against candidates, scoring a fuzzy match into tiers — a schema makes all of that
 * look easy, and it is exactly where turning thinking off costs the most.
 *
 * Set explicitly on every request either way. OMITTING the field at the provider does
 * not mean the same thing on every model — no thinking on Opus 4.8/4.7, adaptive on
 * Sonnet 5 — so the adapter never omits it.
 */
export type LlmThinking = 'adaptive' | 'disabled'

export interface LlmRequest {
  model: string
  prompt: string
  system?: string
  /** Reasoning depth. Defaults to `adaptive` — see `LlmThinking`. */
  thinking?: LlmThinking
  /**
   * Hard cap on output tokens. Set it GENEROUSLY.
   *
   * It is a CAP, not a reservation: you are billed for what the model emits, so a cap
   * of 64k on an answer that runs to 800 tokens costs exactly what a cap of 1k would
   * have. A tight cap therefore saves nothing, and when it bites you pay for a whole
   * generation you have to throw away — a truncated answer cannot be resumed, only
   * resampled. Treat this as a blast-radius guard against a looping model, not as a
   * budget you expect to spend.
   *
   * The adapter clamps it to the model's real output ceiling, so overshooting is safe.
   * Hitting it means the answer genuinely does not fit — see `output_truncated`, which
   * routes to the chunk queue rather than being retried.
   */
  maxTokens: number
  /** Per-request timeout in ms, forwarded to the SDK. Defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number
}

/** The methods every adapter implements. Keep it small. */
export interface LlmClient {
  /**
   * Count the INPUT tokens of a request, without running inference.
   *
   * It sits on the seam rather than buried in the adapter because it is the only
   * way to learn "this will not fit" WITHOUT paying for a request to find out.
   * The adapter uses it for its pre-flight guard; a caller can use it directly to
   * decide how to chunk.
   *
   * Cheap, but not free — it is a real round trip. The adapter only spends it
   * when a free local estimate says we are near the limit (`model-limits.ts`).
   */
  countTokens(req: LlmRequest | LlmObjectRequest<unknown>): Promise<number>

  complete(req: LlmRequest): Promise<LlmOutcome<LlmCompletion>>

  /**
   * Prose out; structure in. The caller's schema is OFFERED to the model as a tool
   * (`tool_choice: 'auto'`), and its `tool_use` input is the answer.
   *
   * Offered, not FORCED, and the difference is not stylistic: forcing the tool makes
   * the model emit the call immediately, which suppresses its reasoning entirely and
   * yields well-formed objects that pass validation and are confidently wrong. The
   * measurements are in the adapter, at the `tool_choice` line.
   *
   * The price of `auto` is that the model may answer in prose instead — that is
   * `retry/model_noncompliant`, and it has a resample budget.
   *
   * It cannot be layered on top of `complete()`: `complete()` keeps only text blocks,
   * and the answer here lives in a `tool_use` block's `input`.
   */
  generateObject<T>(req: LlmObjectRequest<T>): Promise<LlmOutcome<LlmObjectValue<T>>>
}
