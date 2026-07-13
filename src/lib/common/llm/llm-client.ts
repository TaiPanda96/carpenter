/**
 * The provider-agnostic LLM seam.
 *
 * `response-schema.ts` is the single source of truth for the RESULT contract
 * (runtime-validated, because a response crosses a trust boundary we don't
 * control). This file owns the REQUEST contract — a plain compile-time type,
 * because the request is constructed by our own deterministic domain code, so
 * there is nothing untrusted to parse.
 *
 * Domain logic depends on this interface via `ctx.llm` and never on a concrete
 * SDK, so we can swap providers and unit-test the domain with a fake.
 */

import type { LlmObjectRequest, LlmObjectResult } from "./llm-object";
import { LlmResult } from "./llm-response";

export interface LlmRequest {
  model: string;
  prompt: string;
  system?: string;
  /** Hard cap on output tokens. Stream above ~16k to avoid HTTP timeouts. */
  maxTokens: number;
  /** Per-request timeout in ms, forwarded to the SDK. */
  timeoutMs?: number;
}

/** The methods every adapter implements. Keep it small. */
export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResult>;
  /**
   * Prose out; structure in. Forced tool use under the hood, so the model has no
   * way to answer EXCEPT by filling the caller's schema. It cannot be layered on
   * top of `complete()`: `complete()` keeps only text blocks, and a forced tool
   * call puts its answer in a `tool_use` block's `input`.
   */
  generateObject<T>(req: LlmObjectRequest<T>): Promise<LlmObjectResult<T>>;
  // TODO: add streaming support, e.g. `stream(req: LlmRequest): AsyncIterable<LlmResultChunk>`.
  // TODO: add Batch support, e.g. `batch(reqs: LlmRequest[]): Promise<LlmResult[]>`.
}
