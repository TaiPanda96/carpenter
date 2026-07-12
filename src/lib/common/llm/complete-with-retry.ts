import type { ContextWith } from "@/lib/common/create-context";
import { LlmError } from "./llm-errors";
import { LlmRequest } from "./llm-client";
import { LlmResult } from "./llm-response";

/**
 * Call the model, retrying ONLY transient failures, with exponential backoff.
 *
 * Pure decision-making over the normalized seam — unit-tests with a fake
 * `ctx.llm` and a fake `ctx.sleep`, no network and no real waiting. It declares
 * its IO surface honestly: it touches the model (`'llm'`) and the clock
 * (`'sleep'`).
 *
 * Two failure modes handled distinctly:
 *   - `retryable` LlmError (rate limit / 5xx / network) -> back off and retry.
 *   - a `refusal` stop is a SUCCESSFUL call whose content must not be used —
 *     surfaced as a non-retryable error, not returned as if it were an answer.
 */
export interface CompleteOptions {
  /** Max RETRIES after the first attempt. Default 2 (3 attempts total). */
  maxRetries?: number;
  /** Base backoff in ms; delay = base * 2^(attempt-1). Default 200. */
  backoffBaseMs?: number;
}

/**
 * @example
 * const res = await completeWithRetry(ctx, req, { maxRetries: 3, backoffBaseMs: 100 })
 * console.log(res.text)
 * console.log(res.stop.kind)
 * console.log(res.usage.inputTokens, res.usage.outputTokens)
 *
 * @param ctx - The context containing the LLM client and sleep function.
 * @param req - The LLM request containing model, prompt, system, maxTokens, and optional timeoutMs.
 * @param opts - Optional settings for maxRetries and backoffBaseMs.
 * @returns A promise that resolves to the LLM result containing text, stop reason, usage, model, provider, and optional requestId.
 * @throws LlmError if the request fails with a non-retryable error or if the maximum number of retries is exceeded.
 */
export async function completeWithRetry(
  ctx: ContextWith<"llm" | "sleep">,
  req: LlmRequest,
  opts: CompleteOptions = {},
): Promise<LlmResult> {
  const maxRetries = opts.maxRetries ?? 2;
  const backoffBaseMs = opts.backoffBaseMs ?? 200;

  let attempt = 0;
  for (;;) {
    try {
      const res = await ctx.llm.complete(req);

      if (res.stop.kind === "refusal") {
        throw new LlmError({
          kind: "refusal",
          message: "Model refused the request",
          retryable: false,
        });
      }
      return res;
    } catch (err) {
      const e =
        err instanceof LlmError
          ? err
          : new LlmError({
              kind: "unknown",
              message: err instanceof Error ? err.message : String(err),
              retryable: false,
              cause: err,
            });

      if (!e.retryable || attempt >= maxRetries) throw e;

      attempt++;
      await ctx.sleep(backoffBaseMs * 2 ** (attempt - 1));
    }
  }
}
