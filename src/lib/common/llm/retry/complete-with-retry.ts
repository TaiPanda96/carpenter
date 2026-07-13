import type { ContextWith } from "@/lib/common/create-context";
import { LlmRequest } from "../contract/client";
import { LlmOutcome } from "../contract/outcome";
import { LlmCompletion } from "../contract/response";
import { RetryOptions, withLlmRetry } from "./with-llm-retry";

/**
 * Call the model for prose, executing the in-process remedies (backoff, budget
 * growth, resample) and returning the routed outcome for everything else.
 *
 * It RETURNS an `LlmOutcome`; it does not throw. The caller switches on
 * `outcome.route` — and that switch IS the queue:
 *
 * ```ts
 * const outcome = await completeWithRetry(ctx, req)
 * switch (outcome.route) {
 *   case 'complete':    return emit(outcome.value.text)
 *   case 'retry':       return park(job, outcome.retryAfterMs)   // retries exhausted
 *   case 'decompose':   return chunkQueue.push(job, outcome.reason)
 *   case 'dead_letter': return dlq.push(job, outcome.error)
 *   case 'cancelled':   return                                    // caller left
 *   case 'alert':       return page(outcome.error, outcome.signals)
 * }
 * ```
 *
 * There is no `default:` — the union is exhaustive, so adding a route breaks every
 * consumer at compile time rather than silently falling through.
 *
 * At the outermost leaf, where there is genuinely nowhere to park a job, unwrap
 * with `expectComplete(outcome)`. Not from domain code: biome.json rejects that,
 * because unwrapping destroys the routing information and makes the caller
 * uncomposable.
 */
export async function completeWithRetry(
  ctx: ContextWith<"llm" | "sleep" | "random">,
  req: LlmRequest,
  opts: RetryOptions = {},
): Promise<LlmOutcome<LlmCompletion>> {
  return withLlmRetry(ctx, req, (r) => ctx.llm.complete(r), opts);
}
