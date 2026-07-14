import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod/v4'
import {
  DEFAULT_TIMEOUT_MS,
  type LlmClient,
  type LlmRequest,
  type LlmThinking,
} from '../contract/client'
import type { DecomposeReason, LlmSignals } from '../contract/disposition'
import { LlmError, toValidationIssues } from '../contract/errors'
import { type LlmObjectRequest, toJsonSchema } from '../contract/object-request'
import type { LlmOutcome } from '../contract/outcome'
import type {
  LlmCompletion,
  LlmCompletionStop,
  LlmObjectValue,
  LlmUsage,
} from '../contract/response'
import { contextWindow, maxOutputTokens, needsTokenPreflight } from './model-limits'

/**
 * Raw `@anthropic-ai/sdk` adapter.
 *
 * This is the ONLY place in the system that sees both the raw provider signals
 * (`stop_reason`, HTTP status, SDK error class, `retry-after`) and the domain
 * that has to act on them. Everything it knows, it translates into exactly one
 * value — `LlmOutcome` — whose `route` IS the triage decision. Nothing downstream
 * re-derives "is this retryable"; if it did, the two would drift.
 *
 * It does not THROW on operational failure. A 429, a refusal, a truncation and a
 * 529 are planned-for states, so they are values. Exceptions are reserved for
 * things nobody planned for (a missing API key).
 *
 * EVERY REQUEST IS STREAMED, and that fact does not escape this file — `complete()`
 * and `generateObject()` still return one resolved value, because `finalMessage()`
 * hands back the same `Message` shape `create()` did. Nothing above this line knows
 * or cares.
 *
 * The reason is not latency; it is that a non-streaming `create()` must hold one HTTP
 * response open for the whole generation, so it starts timing out somewhere around
 * 16k output tokens. That single fact used to leak all the way up: it forced a low
 * `max_tokens`, which made truncation COMMON, which is why `withLlmRetry` grew a
 * budget-doubling loop that paid for the same generation two and three times over.
 * Streaming removes the constraint, so `max_tokens` can be what it actually is — a
 * cap, not a reservation (see `model-limits.ts`) — and a truncation goes back to
 * meaning what it should: this answer does not fit in the model's output ceiling.
 *
 * Trust boundary: the ONE thing we runtime-validate is the wire response
 * (`anthropicResponseProjectionSchema`) — an external, drift-prone source. We
 * validate a PROJECTION (only the fields we consume), then trust our own
 * deterministic mapping. No second parse of our own output.
 */
const anthropicResponseProjectionSchema = z.object({
  id: z.string().min(1).optional(),
  model: z.string().min(1),
  stop_reason: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    // Optional AND nullable: the provider omits these when caching is unused, and
    // `null` from the wire must not silently become `0` — see `LlmUsage`.
    cache_read_input_tokens: z.number().int().nonnegative().nullish(),
    cache_creation_input_tokens: z.number().int().nonnegative().nullish(),
  }),
  content: z.array(z.object({ type: z.string() }).passthrough()),
})

type AnthropicResponse = z.infer<typeof anthropicResponseProjectionSchema>

/**
 * The projection of a `tool_use` block — the only block type `generateObject`
 * consumes. `input` stays `unknown` on purpose: it is model-GENERATED content,
 * and the caller's schema is the thing entitled to say what it is.
 */
const anthropicToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  name: z.string().min(1),
  input: z.unknown(),
})

/**
 * Thinking is set EXPLICITLY on every request, and that is the load-bearing word.
 *
 * OMITTING the field does not mean the same thing on every model we support: on
 * `claude-opus-4-8` / `4-7` it means no thinking, and on `claude-sonnet-5` it means
 * ADAPTIVE thinking. Since thinking tokens are drawn from the same `max_tokens` budget
 * as the answer, an omitted field would make the identical request cost — and truncate
 * — differently on different models, for a reason nobody wrote down.
 *
 * WHICH value is the caller's call, not ours: it is a genuine quality/cost trade and it
 * lands differently on prose than on a forced-tool extraction. It defaults to
 * `adaptive`, because thinking is the biggest quality lever available and the reason to
 * fear it (a tight `max_tokens` that reasoning could eat) is gone. See `LlmThinking`.
 */
export function thinkingConfig(mode: LlmThinking | undefined): Anthropic.ThinkingConfigParam {
  return mode === 'disabled' ? { type: 'disabled' } : { type: 'adaptive' }
}

/**
 * The caller's cap, clamped to what the model can actually emit.
 *
 * A caller is expected to set `maxTokens` GENEROUSLY (it is a cap, not a reservation —
 * see `model-limits.ts`), and the natural consequence is a number that sometimes
 * exceeds the model's own ceiling. Clamping turns that into a request that runs;
 * forwarding it verbatim turns it into a 400 that dead-letters a healthy job.
 */
function outputBudget(req: { model: string; maxTokens: number }): number {
  const ceiling = maxOutputTokens(req.model)
  return ceiling === undefined ? req.maxTokens : Math.min(req.maxTokens, ceiling)
}

export function createAnthropicClient(apiKey: string): LlmClient {
  // Throws. A missing key is a deployment error, not a routable outcome — there
  // is no queue that fixes it.
  const parsedApiKey = z.string().trim().min(1, 'Anthropic API key is required').parse(apiKey)

  // Own retries in exactly one layer. Application orchestration (withLlmRetry)
  // owns them, so the SDK's are disabled to avoid retry multiplication
  // (2 SDK retries x N app retries).
  const sdk = new Anthropic({ apiKey: parsedApiKey, maxRetries: 0 })

  /**
   * The one place a request actually leaves the process.
   *
   * `.stream(...).finalMessage()` resolves to the same `Message` that `.create()`
   * returned, so the streaming is a transport detail and nothing above sees it. The
   * SDK surfaces the same typed errors on the same classes, so `routeThrownError`
   * needs no change either.
   */
  async function send(
    params: Anthropic.MessageStreamParams,
    timeoutMs: number | undefined,
  ): Promise<unknown> {
    return sdk.messages.stream(params, { timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS }).finalMessage()
  }

  async function countTokens(req: LlmRequest | LlmObjectRequest<unknown>): Promise<number> {
    const counted = await sdk.messages.countTokens({
      model: req.model,
      system: req.system,
      messages: [{ role: 'user', content: req.prompt }],
    })
    return counted.input_tokens
  }

  /**
   * The pre-flight guard: learn "this will not fit" WITHOUT paying for inference.
   *
   * Anthropic reports an over-long prompt as a plain 400 whose only distinguishing
   * mark is its prose. Reacting to that means (a) paying for a request to discover
   * something we could have computed, and (b) betting the chunk queue on a vendor
   * not rewording an error string. So we measure first.
   *
   * The `count_tokens` call is a real round trip, so it is gated behind a free
   * local estimate — most traffic never pays for it. See `model-limits.ts`.
   *
   * Returns `undefined` when the prompt fits, or when the model is unknown (we
   * cannot compare against a window we do not have, and guessing one is worse
   * than skipping the check).
   */
  async function preflightInputSize(
    req: LlmRequest | LlmObjectRequest<unknown>,
  ): Promise<LlmOutcome<never> | undefined> {
    const window = contextWindow(req.model)
    if (window === undefined) return undefined

    const text = `${req.system ?? ''}${req.prompt}`
    if (!needsTokenPreflight(req.model, text)) return undefined

    const tokens = await countTokens(req)
    if (tokens <= window) return undefined

    const signals: LlmSignals = {
      provider: 'anthropic',
      rawStopReason: null,
      httpStatus: null, // no inference request was ever made
      providerCode: null,
      requestId: null,
      model: req.model,
    }

    // A free failure. The job reaches the chunk queue without a paid request and
    // without anyone parsing a vendor's prose.
    return {
      route: 'decompose',
      reason: 'input_too_large',
      error: new LlmError({
        route: 'decompose',
        reason: 'input_too_large',
        message: `Prompt is ${tokens} tokens; ${req.model} accepts ${window}`,
        signals,
      }),
      usage: null,
      signals,
    }
  }

  return {
    countTokens,

    async complete(req: LlmRequest): Promise<LlmOutcome<LlmCompletion>> {
      const oversized = await preflightInputSize(req)
      if (oversized) return oversized

      const budget = outputBudget(req)

      let response: unknown
      try {
        response = await send(
          {
            model: req.model,
            max_tokens: budget,
            thinking: thinkingConfig(req.thinking),
            system: req.system,
            messages: [{ role: 'user', content: req.prompt }],
          },
          req.timeoutMs,
        )
      } catch (error) {
        return routeThrownError(error)
      }

      const parsed = anthropicResponseProjectionSchema.safeParse(response)
      if (!parsed.success) return routeInvalidResponse(parsed.error)

      const stop = mapStopReason(parsed.data.stop_reason)
      const usage = mapUsage(parsed.data)
      const signals = signalsFromResponse(parsed.data)

      const failure = routeNonTerminalStop(stop, usage, signals, budget)
      if (failure) return failure

      // content is an array of blocks — concat the text ones. Never assume
      // content[0] is text; a thinking block can come first.
      const text = parsed.data.content
        .filter(
          (block): block is { type: 'text'; text: string } =>
            block.type === 'text' && typeof block.text === 'string',
        )
        .map((block) => block.text)
        .join('')

      return { route: 'complete', value: { text, stop }, usage, signals }
    },

    async generateObject<T>(req: LlmObjectRequest<T>): Promise<LlmOutcome<LlmObjectValue<T>>> {
      const oversized = await preflightInputSize(req)
      if (oversized) return oversized

      const budget = outputBudget(req)

      let response: unknown
      try {
        response = await send(
          {
            model: req.model,
            max_tokens: budget,
            thinking: thinkingConfig(req.thinking),
            system: req.system,
            messages: [{ role: 'user', content: req.prompt }],
            // OFFERED, not forced. One schema still drives both the ask
            // (`input_schema`) and the check (safeParse below), so they cannot drift.
            // See `tool_choice` below for why the model is not compelled to use it.
            tools: [
              {
                name: req.toolName,
                description: req.toolDescription,
                // `toJsonSchema` returns a plain JSON-Schema object. The SDK's
                // `Tool.InputSchema` demands the literal `type: 'object'`, which a
                // zod OBJECT schema always emits but the generic JSON-Schema return
                // type cannot prove. The cast records exactly that gap.
                input_schema: toJsonSchema(req.schema) as Anthropic.Tool.InputSchema,
              },
            ],
            // `auto`, NOT `{type: 'tool'}`. This is the least obvious line in the file.
            //
            // Forcing a tool makes the model emit the tool call IMMEDIATELY — and that
            // turns out to suppress reasoning entirely. Measured, same prompt, an
            // invoice total needing two arithmetic steps and a threshold check:
            //
            //   tool_choice          thinking   blocks                   out    answer
            //   ─────────────────────────────────────────────────────────────────────
            //   {type: 'tool'}       adaptive   tool_use                  63    211.86 ✗
            //   {type: 'tool'}       disabled   tool_use                  63    208.25 ✗
            //   {type: 'any'}        adaptive   tool_use                  69    210.55 ✗
            //   'auto'               adaptive   thinking,text,tool_use   369    209.07 ✓
            //
            // Note the token counts: under a forced tool, adaptive and disabled cost
            // the SAME 63 tokens. No thinking block is emitted at all — the `thinking`
            // parameter is inert. The model pattern-matches straight into the schema.
            //
            // And the failure is the worst kind this seam can produce: a well-formed
            // object that passes Zod, trips no route, and is confidently wrong. Every
            // piece of the triage machinery is blind to it. A forced tool guarantees
            // the SHAPE of an answer and buys nothing for the reasoning that fills it —
            // which is precisely the work a schema makes look mechanical.
            //
            // The cost of `auto` is that the model MAY answer in prose instead. That is
            // exactly `retry/model_noncompliant`, which already exists below with its
            // own resample budget — the route was written for this and was unreachable
            // while the tool was forced.
            tool_choice: { type: 'auto' },
          },
          req.timeoutMs,
        )
      } catch (error) {
        return routeThrownError(error)
      }

      const parsed = anthropicResponseProjectionSchema.safeParse(response)
      if (!parsed.success) return routeInvalidResponse(parsed.error)

      const stop = mapStopReason(parsed.data.stop_reason)
      const usage = mapUsage(parsed.data)
      const signals = signalsFromResponse(parsed.data)

      // Here — and ONLY here — a `tool_use` stop is a terminal success: the offered
      // tool fired, and its `input` IS the answer. There is no tool to run and no loop
      // to continue. `complete()` treats the same raw signal as impossible (it sends no
      // tools). Same wire value, opposite meaning, because the request differed — which
      // is exactly why this mapping belongs in the adapter.
      if (stop.kind !== 'tool_use') {
        const failure = routeNonTerminalStop(stop, usage, signals, budget)
        // Checked BEFORE looking for the block: on `max_tokens` the tool JSON is CUT
        // OFF, so a block may be present but half-written. Parsing it would fail
        // schema validation and we would dead-letter a job whose real problem is a
        // budget.
        if (failure) return failure
      }

      // Never assume content[0]. Under `tool_choice: auto` the model reasons first, so
      // a `thinking` block and usually a `text` block PRECEDE the `tool_use` one — that
      // ordering is the whole point of the change and this scan is what tolerates it.
      let toolUse: { name: string; input?: unknown } | undefined
      for (const block of parsed.data.content) {
        const candidate = anthropicToolUseBlockSchema.safeParse(block)
        if (candidate.success && candidate.data.name === req.toolName) {
          toolUse = candidate.data
          break
        }
      }

      // The model answered in prose instead of calling the tool. This is the price of
      // `auto`, and it is the price we chose to pay: the route was already here, unused,
      // because a forced tool made it unreachable.
      //
      // The transport is healthy and nothing is busy — a plain resample usually complies
      // — so this is `retry/model_noncompliant`, not a server error, and it draws on its
      // own tiny budget rather than the rate-limit pool. If it fires often for a given
      // prompt, the fix is a better `toolDescription`, not a bigger budget.
      if (!toolUse) {
        const error = new LlmError({
          route: 'retry',
          reason: 'model_noncompliant',
          message: `Model returned no '${req.toolName}' tool_use block (stop_reason: ${parsed.data.stop_reason})`,
          signals,
        })
        return {
          route: 'retry',
          reason: 'model_noncompliant',
          retryAfterMs: null,
          error,
          usage,
          signals,
        }
      }

      // THE trust boundary for model-generated content. Dead-letter, not retry: the
      // model answered in the wrong SHAPE, and an identical resample is a coin flip,
      // not a fix. A human reads `issues` and the prompt.
      const validated = req.schema.safeParse(toolUse.input)
      if (!validated.success) {
        const error = new LlmError({
          route: 'dead_letter',
          reason: 'invalid_output',
          message: `Model output failed '${req.toolName}' schema validation`,
          signals,
          issues: toValidationIssues(validated.error.issues),
          cause: validated.error,
        })
        return {
          route: 'dead_letter',
          reason: 'invalid_output',
          error,
          usage,
          signals,
        }
      }

      return {
        route: 'complete',
        value: { object: validated.data, raw: toolUse.input, stop },
        usage,
        signals,
      }
    },
  }
}

/**
 * The stop reasons that mean the job is NOT done. Returns `undefined` when the
 * stop is a healthy terminal one and the caller should keep going.
 *
 * Shared by both methods so the table is written once.
 */
export function routeNonTerminalStop(
  stop: LlmCompletionStop,
  usage: LlmUsage,
  signals: LlmSignals,
  maxTokens: number,
): LlmOutcome<never> | undefined {
  switch (stop.kind) {
    // The model declined. A 200 OK whose content must not be used — so it must
    // never reach a consumer as if it were an answer.
    case 'refusal':
      return deadLetterStop('refusal', 'Model refused the request', usage, signals)

    // OUTPUT side: the input fit; generation was cut at the cap.
    //
    // There is no local remedy and deliberately so. A cut-off answer cannot be
    // RESUMED — assistant-turn prefill is a 400 on every model in this table, and
    // half-written tool JSON cannot be continued in any case — so the only "retry"
    // available is a full resample that throws the paid-for generation away. We used
    // to do exactly that, twice, doubling `max_tokens` each time; it existed only
    // because a non-streaming request forced a low cap in the first place.
    //
    // Now that the adapter streams, callers set a budget generously and this stop
    // means what it says: the answer does not fit in the model's output ceiling. No
    // budget fixes that. Split the task.
    case 'max_tokens':
      return decomposeStop(
        'output_truncated',
        `Output was truncated at max_tokens (${maxTokens})`,
        usage,
        signals,
      )

    // INPUT side: the prompt never fit. The pre-flight guard should have caught this
    // for free — if we are here, the estimate under-counted or the model is missing
    // from CONTEXT_WINDOW. A bigger output budget cannot fix it. Chunk the input.
    case 'context_window_exceeded':
      return decomposeStop(
        'input_too_large',
        "Prompt exceeded the model's context window",
        usage,
        signals,
      )

    // `complete()` sends no tools, so this cannot happen there; `generateObject()`
    // handles its own `tool_use` before ever calling this. Reaching here means the
    // provider returned a tool_use stop for a request with no tools — do not
    // invent a meaning for it.
    case 'tool_use':
      return alertStop('Got a tool_use stop, but no tools were sent', usage, signals)

    // A stop_reason we have never seen. Do not guess: the mapping is out of date and
    // a human needs to look at `signals.rawStopReason`.
    case 'other':
      return alertStop(`Unrecognized stop_reason: ${String(stop.providerReason)}`, usage, signals)

    case 'complete':
    case 'stop_sequence':
      return undefined
  }
}

function decomposeStop(
  reason: DecomposeReason,
  message: string,
  usage: LlmUsage,
  signals: LlmSignals,
): LlmOutcome<never> {
  return {
    route: 'decompose',
    reason,
    error: new LlmError({ route: 'decompose', reason, message, signals }),
    usage,
    signals,
  }
}

function deadLetterStop(
  reason: 'refusal',
  message: string,
  usage: LlmUsage,
  signals: LlmSignals,
): LlmOutcome<never> {
  return {
    route: 'dead_letter',
    reason,
    error: new LlmError({ route: 'dead_letter', reason, message, signals }),
    usage,
    signals,
  }
}

function alertStop(message: string, usage: LlmUsage, signals: LlmSignals): LlmOutcome<never> {
  return {
    route: 'alert',
    error: new LlmError({ route: 'alert', message, signals }),
    usage,
    signals,
  }
}

/** Anthropic `stop_reason` -> normalized discriminated stop. */
function mapStopReason(reason: string | null): LlmCompletionStop {
  switch (reason) {
    case 'end_turn':
      return { kind: 'complete', providerReason: reason }
    case 'stop_sequence':
      return { kind: 'stop_sequence', providerReason: reason }
    case 'max_tokens':
      return { kind: 'max_tokens', providerReason: reason }
    case 'model_context_window_exceeded':
      return { kind: 'context_window_exceeded', providerReason: reason }
    case 'refusal':
      return { kind: 'refusal', providerReason: reason }
    case 'tool_use':
      return { kind: 'tool_use', providerReason: reason }
    default:
      return { kind: 'other', providerReason: reason }
  }
}

/**
 * `null`/absent cache fields stay `null` rather than collapsing to `0`: a provider
 * that stopped REPORTING cache reads must not look like a cache that stopped
 * WORKING.
 */
function mapUsage(response: AnthropicResponse): LlmUsage {
  return {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? null,
    cacheWriteTokens: response.usage.cache_creation_input_tokens ?? null,
  }
}

function signalsFromResponse(response: AnthropicResponse): LlmSignals {
  return {
    provider: 'anthropic',
    rawStopReason: response.stop_reason,
    httpStatus: 200,
    providerCode: null,
    requestId: response.id ?? null,
    model: response.model,
  }
}

/**
 * The call never landed, or landed in a shape we cannot read.
 *
 * `providerCode` comes off `error.type`, NOT `error.error.type`. The SDK stores the
 * whole envelope on `.error` (`{type: 'error', error: {type: 'rate_limit_error'}}`)
 * and unwraps the real code onto `.type`. Reading the envelope yields the literal
 * string `'error'` for every failure — a `providerCode` that is always the same
 * value is worse than none, because it looks like it works.
 */
function signalsFromError(error: InstanceType<typeof Anthropic.APIError> | null): LlmSignals {
  return {
    provider: 'anthropic',
    rawStopReason: null,
    httpStatus: error?.status ?? null,
    providerCode: error?.type ?? null,
    requestId: error?.requestID ?? null,
    model: null,
  }
}

/**
 * The provider answered in a shape our projection does not recognize.
 *
 * `alert`, not `dead_letter`: nothing is wrong with the JOB — our mapping is out of
 * date, or the provider shipped a breaking change. Retrying will not help and a
 * human reviewing the payload will find nothing. Page someone.
 */
function routeInvalidResponse(zodError: z.ZodError): LlmOutcome<never> {
  const signals = signalsFromError(null)
  return {
    route: 'alert',
    error: new LlmError({
      route: 'alert',
      message: 'Anthropic returned an invalid response shape',
      signals,
      issues: toValidationIssues(zodError.issues),
      cause: zodError,
    }),
    usage: null,
    signals,
  }
}

/**
 * Anthropic SDK error -> routed outcome.
 *
 * Branches on the SDK's typed error subclasses (richer than a bare status check),
 * then on status where the class is too coarse — notably 529 `overloaded_error`,
 * which the SDK lumps into `InternalServerError` with every other 5xx but which
 * means "the provider is at capacity", not "the provider is broken", and wants a
 * longer, jittered backoff.
 */
export function routeThrownError(error: unknown): LlmOutcome<never> {
  // The caller walked away (aborted request / closed tab). Not a failure — there
  // is nothing to retry, nothing to review, and nobody to page.
  if (error instanceof Anthropic.APIUserAbortError) {
    const signals = signalsFromError(null)
    return {
      route: 'cancelled',
      error: new LlmError({
        route: 'cancelled',
        message: error.message,
        signals,
        cause: error,
      }),
      usage: null,
      signals,
    }
  }

  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return transportRetry('timeout', error)
  }

  // Must come AFTER the timeout check — timeout extends connection error.
  if (error instanceof Anthropic.APIConnectionError) {
    return transportRetry('network', error)
  }

  if (error instanceof Anthropic.APIError) {
    return routeApiError(error)
  }

  const signals = signalsFromError(null)
  return {
    route: 'alert',
    error: new LlmError({
      route: 'alert',
      message: error instanceof Error ? error.message : 'Unknown Anthropic client failure',
      signals,
      cause: error,
    }),
    usage: null,
    signals,
  }
}

function routeApiError(error: InstanceType<typeof Anthropic.APIError>): LlmOutcome<never> {
  const signals = signalsFromError(error)
  const retryAfterMs = parseRetryAfterMs(error.headers)

  // 413: the request body itself was rejected as too large. The SDK has no
  // dedicated class for it, so it arrives as a bare APIError — check status.
  if (error.status === 413) {
    return decomposeApi('input_too_large', error, signals)
  }

  // 429. The `retry-after` header is the whole point: guessing with exponential
  // backoff when the API has TOLD us how long to wait is strictly worse — too short
  // burns a retry, too long wastes the window.
  if (error instanceof Anthropic.RateLimitError) {
    return retryApi('rate_limit', error, signals, retryAfterMs)
  }

  if (error instanceof Anthropic.InternalServerError) {
    // 529 `overloaded_error` is capacity, not breakage. Distinct reason so the queue
    // can back off harder without treating it as an incident.
    const reason = error.status === 529 ? 'overloaded' : 'server_error'
    return retryApi(reason, error, signals, retryAfterMs)
  }

  // 401 / 403. Not retryable, and not something a DLQ reviewer fixes by editing the
  // payload — it is an operational break. It dead-letters so the JOB survives, and
  // `reason: 'auth'` is what an alerting rule keys on.
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  ) {
    return deadLetterApi('auth', error, signals)
  }

  // 404 — almost always a bad model id. Our bug; retrying is pointless.
  if (error instanceof Anthropic.NotFoundError) {
    return deadLetterApi('not_found', error, signals)
  }

  // 400. The pre-flight guard is what SHOULD catch an over-long prompt, for free and
  // before any request is paid for. This regex is only a BACKSTOP for what slips
  // through it — a model missing from CONTEXT_WINDOW, or an estimate that
  // under-counted. It is fragile by construction (it parses a vendor's prose), which
  // is precisely why it is not the primary path any more: when it drifts, the job
  // dead-letters (safe) rather than the chunk queue silently going to zero.
  if (error instanceof Anthropic.BadRequestError) {
    return looksLikeOversizedPrompt(error.message)
      ? decomposeApi('input_too_large', error, signals)
      : deadLetterApi('invalid_request', error, signals)
  }

  // 422 — we built a request the API cannot process. Our bug.
  if (error instanceof Anthropic.UnprocessableEntityError) {
    return deadLetterApi('invalid_request', error, signals)
  }

  // 409 — vanishingly rare on the Messages API. Transient by convention.
  if (error instanceof Anthropic.ConflictError) {
    return retryApi('server_error', error, signals, retryAfterMs)
  }

  // An HTTP status we have no mapping for. Do not guess whether it is safe to
  // retry — say so, and let a human look at `signals`.
  return {
    route: 'alert',
    error: new LlmError({
      route: 'alert',
      message: error.message,
      signals,
      cause: error,
    }),
    usage: null,
    signals,
  }
}

/**
 * Anthropic reports an over-long prompt as a generic 400; the text is the only tell.
 * Backstop only — see the call site.
 */
const OVERSIZED_PROMPT_PATTERN =
  /prompt is too long|too many tokens|exceeds? the maximum|context window|input length/i

function looksLikeOversizedPrompt(message: string): boolean {
  return OVERSIZED_PROMPT_PATTERN.test(message)
}

function transportRetry(reason: 'timeout' | 'network', error: Error): LlmOutcome<never> {
  const signals = signalsFromError(null)
  return {
    route: 'retry',
    reason,
    retryAfterMs: null,
    error: new LlmError({
      route: 'retry',
      reason,
      message: error.message,
      signals,
      cause: error,
    }),
    usage: null,
    signals,
  }
}

function retryApi(
  reason: 'rate_limit' | 'overloaded' | 'server_error',
  error: InstanceType<typeof Anthropic.APIError>,
  signals: LlmSignals,
  retryAfterMs: number | null,
): LlmOutcome<never> {
  return {
    route: 'retry',
    reason,
    retryAfterMs,
    error: new LlmError({
      route: 'retry',
      reason,
      message: error.message,
      retryAfterMs: retryAfterMs ?? undefined,
      signals,
      cause: error,
    }),
    usage: null,
    signals,
  }
}

function decomposeApi(
  reason: DecomposeReason,
  error: InstanceType<typeof Anthropic.APIError>,
  signals: LlmSignals,
): LlmOutcome<never> {
  return {
    route: 'decompose',
    reason,
    error: new LlmError({
      route: 'decompose',
      reason,
      message: error.message,
      signals,
      cause: error,
    }),
    usage: null,
    signals,
  }
}

function deadLetterApi(
  reason: 'auth' | 'not_found' | 'invalid_request',
  error: InstanceType<typeof Anthropic.APIError>,
  signals: LlmSignals,
): LlmOutcome<never> {
  return {
    route: 'dead_letter',
    reason,
    error: new LlmError({
      route: 'dead_letter',
      reason,
      message: error.message,
      signals,
      cause: error,
    }),
    usage: null,
    signals,
  }
}

/**
 * `retry-after` -> ms. RFC 9110 permits BOTH forms and providers use both:
 *   - delta-seconds: `retry-after: 30`
 *   - HTTP-date:     `retry-after: Wed, 21 Oct 2015 07:28:00 GMT`
 *
 * The old implementation only handled seconds, so a date-form header parsed to NaN
 * and was silently dropped — we would have fallen back to a guess while the provider
 * was telling us the answer.
 *
 * Defensive by design: the SDK types `headers` as `Headers`, but this is the error
 * path — the least-exercised, most-mocked code in any SDK — so a plain object is
 * accepted too. Anything unreadable yields `null` and the caller falls back to
 * exponential backoff. A bad header must never become a `NaN` sleep.
 */
export function parseRetryAfterMs(headers: unknown): number | null {
  if (!headers || typeof headers !== 'object') return null

  const raw =
    headers instanceof Headers
      ? headers.get('retry-after')
      : (headers as Record<string, unknown>)['retry-after']

  if (typeof raw === 'number') return finiteMs(raw * 1000)
  if (typeof raw !== 'string') return null

  const trimmed = raw.trim()
  if (trimmed === '') return null

  // delta-seconds. Guard with a regex: `Number('')` is 0 and `Number(' 12 ')` is 12,
  // so a bare `Number()` would happily accept junk.
  if (/^\d+(\.\d+)?$/.test(trimmed)) return finiteMs(Number(trimmed) * 1000)

  // HTTP-date. A past date means "retry now", which floors to 0.
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return null
  return finiteMs(at - Date.now())
}

function finiteMs(ms: number): number | null {
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.round(ms))
}
