import type { ContextWith } from '@/lib/common/create-context'
import type { LlmObjectRequest } from '../contract/object-request'
import type { LlmOutcome } from '../contract/outcome'
import type { LlmObjectValue } from '../contract/response'
import { type RetryOptions, withLlmRetry } from './with-llm-retry'

/**
 * Call the model for a STRUCTURED object. The sibling of `completeWithRetry` —
 * same seam, same options, same honesty about its IO surface, and the same routed
 * outcome for the caller to switch on.
 *
 * The routes that matter for a structured call:
 *
 *   retry / 'model_noncompliant'   the model ignored the forced tool and wrote
 *                                  prose. Transport is fine; a resample complies.
 *                                  Own budget (default 1) — it will not comply on
 *                                  the third try either.
 *   decompose / 'output_truncated' the tool JSON was CUT OFF. `withLlmRetry`
 *                                  doubles the budget — an identical retry would
 *                                  truncate identically — and escalates to the
 *                                  chunk queue once the ceiling is hit.
 *   decompose / 'input_too_large'  the prompt never fit. Normally caught by the
 *                                  adapter's pre-flight BEFORE a request is paid
 *                                  for. No local remedy; chunk the input.
 *   dead_letter / 'invalid_output' the model answered in the WRONG SHAPE. Not
 *                                  retried: an identical resample is a coin flip,
 *                                  not a fix. `outcome.error.issues` names the
 *                                  offending field, for the human.
 *
 * On success, `outcome.value.raw` is the tool block's untouched `input`, kept
 * beside the parsed `object`: when a downstream grounding check says the model
 * lied, that is the only evidence of what it actually said.
 *
 * @example
 * const outcome = await generateObjectWithRetry(ctx, {
 *   model, prompt, maxTokens: 4096,
 *   schema: invoiceExtractionSchema, toolName: 'extract_invoice',
 * })
 * if (outcome.route === 'complete') use(outcome.value.object)
 */
export async function generateObjectWithRetry<T>(
  ctx: ContextWith<'llm' | 'sleep' | 'random'>,
  req: LlmObjectRequest<T>,
  opts: RetryOptions = {},
): Promise<LlmOutcome<LlmObjectValue<T>>> {
  return withLlmRetry(ctx, req, (r) => ctx.llm.generateObject(r), opts)
}
