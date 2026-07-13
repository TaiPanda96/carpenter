import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { LlmError, isRetryableStatus, toValidationIssues } from "../llm-errors";
import type { LlmCompletionStop, LlmResult } from "../llm-response";
import { LlmClient, LlmRequest } from "../llm-client";
import {
  type LlmObjectRequest,
  type LlmObjectResult,
  toJsonSchema,
} from "../llm-object";

const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Raw `@anthropic-ai/sdk` adapter. Bare-metal Messages API: we read
 * `stop_reason` and `usage` ourselves and normalize them onto the seam.
 *
 * Trust boundary: the ONE thing we runtime-validate is the wire response
 * (`anthropicResponseProjectionSchema`) — an external, drift-prone source.
 *
 * We validate a PROJECTION (only the fields we consume), then trust our own
 * deterministic mapping to `LlmResult`. No second parse of our own output.
 */
const anthropicResponseProjectionSchema = z.object({
  id: z.string().min(1).optional(),
  model: z.string().min(1),
  stop_reason: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
  content: z.array(z.object({ type: z.string() }).passthrough()),
});

/**
 * The projection of a `tool_use` block — the only block type `generateObject`
 * consumes. `input` stays `unknown` on purpose: it is model-GENERATED content,
 * and the caller's schema is the thing entitled to say what it is.
 */
const anthropicToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  name: z.string().min(1),
  input: z.unknown(),
});

export function createAnthropicClient(apiKey: string): LlmClient {
  const parsedApiKey = z
    .string()
    .trim()
    .min(1, "Anthropic API key is required")
    .parse(apiKey);

  // Own retries in exactly one layer. Application orchestration
  // (completeWithRetry) owns them, so the SDK's are disabled to avoid
  // retry multiplication (2 SDK retries × N app retries).
  const sdk = new Anthropic({ apiKey: parsedApiKey, maxRetries: 0 });

  return {
    async complete(req: LlmRequest): Promise<LlmResult> {
      try {
        const response = await sdk.messages.create(
          {
            model: req.model,
            max_tokens: req.maxTokens,
            system: req.system,
            messages: [{ role: "user", content: req.prompt }],
          },
          { timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS },
        );

        // Validate the response shape and normalize it to our LlmResult seam. The SDK's own types are not runtime-validated,
        // so we must check the wire response.
        const parsed = anthropicResponseProjectionSchema.safeParse(response);
        if (!parsed.success) {
          throw new LlmError({
            kind: "provider_response_invalid",
            message: "Anthropic returned an invalid response shape",
            retryable: false,
            provider: "anthropic",
            issues: toValidationIssues(parsed.error.issues),
            cause: parsed.error,
          });
        }

        // content is an array of blocks — concat the text ones. Never assume
        // content[0] is text; a thinking or tool_use block can come first.
        const text = response.content
          .filter(
            (block): block is Anthropic.TextBlock => block.type === "text",
          )
          .map((block) => block.text)
          .join("");

        const result: LlmResult = {
          text,
          stop: mapStopReason(parsed.data.stop_reason),
          usage: {
            inputTokens: parsed.data.usage.input_tokens,
            outputTokens: parsed.data.usage.output_tokens,
          },
          model: parsed.data.model,
          provider: "anthropic",
          requestId: parsed.data.id,
        };
        return result;
      } catch (error) {
        if (error instanceof LlmError) throw error;
        throw normalizeAnthropicError(error);
      }
    },

    async generateObject<T>(
      req: LlmObjectRequest<T>,
    ): Promise<LlmObjectResult<T>> {
      try {
        const response = await sdk.messages.create(
          {
            model: req.model,
            max_tokens: req.maxTokens,
            system: req.system,
            messages: [{ role: "user", content: req.prompt }],
            // FORCED tool use: the caller's schema is the only shape the model
            // can answer in. One schema drives both the ask (`input_schema`) and
            // the check (safeParse below) — they cannot drift apart.
            tools: [
              {
                name: req.toolName,
                description: req.toolDescription,
                // `toJsonSchema` returns a plain JSON-Schema object. The SDK's
                // `Tool.InputSchema` demands the literal `type: 'object'`, which
                // a zod OBJECT schema always emits but the generic JSON-Schema
                // return type cannot prove. The cast records exactly that gap.
                input_schema: toJsonSchema(
                  req.schema,
                ) as Anthropic.Tool.InputSchema,
              },
            ],
            tool_choice: { type: "tool", name: req.toolName },
          },
          { timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS },
        );

        const parsed = anthropicResponseProjectionSchema.safeParse(response);
        if (!parsed.success) {
          throw new LlmError({
            kind: "provider_response_invalid",
            message: "Anthropic returned an invalid response shape",
            retryable: false,
            provider: "anthropic",
            issues: toValidationIssues(parsed.error.issues),
            cause: parsed.error,
          });
        }

        const requestId = parsed.data.id;
        const stop = mapStopReason(parsed.data.stop_reason);

        // The model declined. A 200 OK whose content must not be used.
        if (stop.kind === "refusal") {
          throw new LlmError({
            kind: "refusal",
            message: "Model refused the request",
            retryable: false,
            provider: "anthropic",
            requestId,
          });
        }

        // Checked BEFORE looking for the block: the tool JSON is CUT OFF, so a
        // block may be present but half-written. Cut off is not wrong — retrying
        // with a bigger token budget is the fix (generateObjectWithRetry doubles
        // maxTokens), and this is the whole reason the kind is distinct.
        if (stop.kind === "max_tokens") {
          throw new LlmError({
            kind: "output_truncated",
            message: `Tool output was truncated at max_tokens (${req.maxTokens})`,
            retryable: true,
            provider: "anthropic",
            requestId,
          });
        }

        // Never assume content[0] — a thinking or text block can precede the
        // tool_use one, and the model may emit tools we did not force.
        let toolUse:
          | {
              type: "tool_use";
              name: string;
              input?: unknown;
            }
          | undefined;
        for (const block of parsed.data.content) {
          const candidate = anthropicToolUseBlockSchema.safeParse(block);
          if (candidate.success && candidate.data.name === req.toolName) {
            toolUse = candidate.data;
            break;
          }
        }

        // The model ignored a FORCED tool (typically an end_turn of prose).
        // Retryable: a resample usually complies.
        if (!toolUse) {
          throw new LlmError({
            kind: "tool_use_missing",
            message: `Model returned no '${req.toolName}' tool_use block (stop_reason: ${parsed.data.stop_reason})`,
            retryable: true,
            provider: "anthropic",
            requestId,
          });
        }

        // THE trust boundary for model-generated content. Non-retryable: the
        // model answered in the wrong shape, and an identical retry is a coin
        // flip, not a fix — the caller sees the issues and decides.
        const validated = req.schema.safeParse(toolUse.input);
        if (!validated.success) {
          throw new LlmError({
            kind: "output_validation",
            message: `Model output failed '${req.toolName}' schema validation`,
            retryable: false,
            provider: "anthropic",
            requestId,
            issues: toValidationIssues(validated.error.issues),
            cause: validated.error,
          });
        }

        const result: LlmObjectResult<T> = {
          object: validated.data,
          // The untouched block input, kept beside the parsed value: when a
          // downstream check says the model lied, this is the only evidence of
          // what it actually said.
          raw: toolUse.input,
          stop,
          usage: {
            inputTokens: parsed.data.usage.input_tokens,
            outputTokens: parsed.data.usage.output_tokens,
          },
          model: parsed.data.model,
          provider: "anthropic",
          requestId,
        };
        return result;
      } catch (error) {
        if (error instanceof LlmError) throw error;
        throw normalizeAnthropicError(error);
      }
    },
  };
}

/** Anthropic `stop_reason` -> normalized discriminated `CompletionStop`. */
function mapStopReason(reason: string | null): LlmCompletionStop {
  switch (reason) {
    case "end_turn":
      return { kind: "complete", providerReason: reason };
    case "max_tokens":
      return { kind: "max_tokens", providerReason: reason };
    case "refusal":
      return { kind: "refusal", providerReason: reason };
    case "tool_use":
      return { kind: "tool_use", providerReason: reason };
    default:
      return { kind: "other", providerReason: reason };
  }
}

/**
 * Anthropic SDK error -> normalized `LlmError`. We branch on the SDK's typed
 * error subclasses (richer than a bare status check)
 *
 * Critically, attach the retryable
 * verdict + provider metadata for observability.
 */
function normalizeAnthropicError(error: unknown): LlmError {
  // Cannot retry if the user aborted the request (e.g., closed the browser tab).
  if (error instanceof Anthropic.APIUserAbortError) {
    return new LlmError({
      kind: "aborted",
      message: error.message,
      retryable: false,
      provider: "anthropic",
      cause: error,
    });
  }
  // Cannot retry if the request was malformed (e.g., invalid model name).
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmError({
      kind: "timeout",
      message: error.message,
      retryable: true,
      provider: "anthropic",
      cause: error,
    });
  }
  // Cannot retry if the connection failed (e.g., network issues).
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmError({
      kind: "connection",
      message: error.message,
      retryable: true,
      provider: "anthropic",
      cause: error,
    });
  }

  // Map specific Anthropic API errors to normalized LlmError kinds.
  if (error instanceof Anthropic.AuthenticationError) {
    return fromApiError("authentication", error);
  }

  if (error instanceof Anthropic.PermissionDeniedError) {
    return fromApiError("permission", error);
  }

  if (error instanceof Anthropic.NotFoundError) {
    return fromApiError("not_found", error);
  }

  if (error instanceof Anthropic.RateLimitError) {
    return fromApiError("rate_limit", error);
  }

  if (error instanceof Anthropic.InternalServerError) {
    return fromApiError("provider_unavailable", error);
  }

  if (error instanceof Anthropic.BadRequestError) {
    return fromApiError("invalid_request", error);
  }

  if (error instanceof Anthropic.ConflictError) {
    return fromApiError("conflict", error);
  }

  if (error instanceof Anthropic.UnprocessableEntityError) {
    return fromApiError("invalid_request", error);
  }

  if (error instanceof Anthropic.APIError) {
    return fromApiError("unknown", error);
  }

  return new LlmError({
    kind: "unknown",
    message:
      error instanceof Error
        ? error.message
        : "Unknown Anthropic client failure",
    retryable: false,
    provider: "anthropic",
    cause: error,
  });
}

/**
 * Map an Anthropic APIError to a normalized LlmError, preserving the retryable verdict and provider metadata.
 *
 * Use Cases:
 *  - When the Anthropic API returns an error response, this function translates it into a structured LlmError.
 *  - This allows the application to handle different error scenarios (e.g., authentication issues, rate limits) in a consistent manner.
 *  - The function ensures that the retryable status of the error is preserved, enabling the application to decide whether to retry the request or fail fast.
 *
 * `retryAfterMs` is lifted from the provider's own `retry-after` header: when
 * the API tells us how long to wait, guessing with exponential backoff is worse
 * than obeying (spec-001 REQ-16). The retry loops prefer it over their own base.
 */
function fromApiError(
  kind: LlmError["kind"],
  error: InstanceType<typeof Anthropic.APIError>,
): LlmError {
  return new LlmError({
    kind,
    message: error.message,
    retryable: isRetryableStatus(error.status),
    provider: "anthropic",
    status: error.status,
    requestId: error.requestID ?? undefined,
    providerCode: (error.error as { type?: string } | undefined)?.type,
    retryAfterMs: parseRetryAfterMs(error.headers),
    cause: error,
  });
}

/**
 * `retry-after` (SECONDS, per RFC 9110) -> ms.
 *
 * Defensive by design: the SDK types `headers` as a `Headers`, but this is the
 * error path — the least-exercised, most-mocked code in any SDK — so a plain
 * object is accepted too. Anything we cannot read as a non-negative finite
 * number yields `undefined`, and the caller falls back to exponential backoff.
 * A bad header must never become a `NaN` sleep.
 */
function parseRetryAfterMs(headers: unknown): number | undefined {
  if (!headers || typeof headers !== "object") return undefined;

  const raw =
    headers instanceof Headers
      ? headers.get("retry-after")
      : (headers as Record<string, unknown>)["retry-after"];

  if (typeof raw !== "string" && typeof raw !== "number") return undefined;

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;

  return Math.round(seconds * 1000);
}
