import type { ContextWith } from "@/lib/common/create-context";
import type { CompleteOptions } from "./complete-with-retry";
import { LlmError } from "./llm-errors";
import type { LlmObjectRequest, LlmObjectResult } from "./llm-object";

/**
 * Call the model for a STRUCTURED object, retrying only transient failures.
 *
 * The sibling of `completeWithRetry` — same seam, same options, same honesty
 * about its IO surface (`'llm'` + `'sleep'`, so tests use a fake model and a
 * fake clock: no network, no real waiting).
 *
 * It differs in exactly one way, and that difference is the point:
 *
 *   `output_truncated` (stop_reason `max_tokens`) means the tool JSON was CUT
 *   OFF, not wrong. An identical retry truncates identically — so the budget is
 *   DOUBLED before retrying. Every other retryable kind (rate limit, 5xx,
 *   network, `tool_use_missing`) is resampled unchanged.
 *
 * Refusals and schema-validation failures are non-retryable and surface as-is:
 * a refusal is a successful call whose content must not be used, and a bad shape
 * is the model answering the wrong question — neither is fixed by waiting.
 *
 * @example
 * const res = await generateObjectWithRetry(ctx, {
 *   model, prompt, maxTokens: 4096,
 *   schema: invoiceExtractionSchema, toolName: 'extract_invoice',
 * })
 * res.object // validated; res.raw // what the model actually said
 *
 * @throws LlmError — non-retryable failure, or the last error after maxRetries.
 */
export async function generateObjectWithRetry<T>(
  ctx: ContextWith<"llm" | "sleep">,
  req: LlmObjectRequest<T>,
  opts: CompleteOptions = {},
): Promise<LlmObjectResult<T>> {
  const maxRetries = opts.maxRetries ?? 2;
  const backoffBaseMs = opts.backoffBaseMs ?? 200;

  let attempt = 0;
  let current = req;
  for (;;) {
    try {
      return await ctx.llm.generateObject(current);
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

      // Truncation is the one failure a bigger budget actually fixes.
      if (e.kind === "output_truncated") {
        current = { ...current, maxTokens: current.maxTokens * 2 };
      }

      attempt++;
      // The provider's own `retry-after` beats our guess; exponential backoff is
      // the fallback for when it says nothing.
      await ctx.sleep(e.retryAfterMs ?? backoffBaseMs * 2 ** (attempt - 1));
    }
  }
}
