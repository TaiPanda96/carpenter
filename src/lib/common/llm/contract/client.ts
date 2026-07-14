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
 * It lives HERE, beside `timeoutMs`, and not in the adapter — because it is not
 * only the adapter's business. A timeout is a bet about how long generation takes,
 * and generation time scales with `maxTokens`. So when `withLlmRetry` grows the
 * token budget after a truncation, it must grow this with it, or the remedy for
 * the truncation manufactures a timeout instead. Both files need the number, so
 * neither one owns it.
 */
export const DEFAULT_TIMEOUT_MS = 30_000

export interface LlmRequest {
  model: string
  prompt: string
  system?: string
  /** Hard cap on output tokens. Stream above ~16k to avoid HTTP timeouts. */
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
   * Prose out; structure in. Forced tool use under the hood, so the model has no
   * way to answer EXCEPT by filling the caller's schema. It cannot be layered on
   * top of `complete()`: `complete()` keeps only text blocks, and a forced tool
   * call puts its answer in a `tool_use` block's `input`.
   */
  generateObject<T>(req: LlmObjectRequest<T>): Promise<LlmOutcome<LlmObjectValue<T>>>
}
