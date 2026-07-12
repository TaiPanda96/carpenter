import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { LlmError, isRetryableStatus, toValidationIssues } from "../llm-errors";
import type { LlmCompletionStop, LlmResult } from "../llm-response";
import { LlmClient, LlmRequest } from "../llm-client";

/**
 * Raw `@anthropic-ai/sdk` adapter. Bare-metal Messages API: we read
 * `stop_reason` and `usage` ourselves and normalize them onto the seam.
 *
 * Trust boundary: the ONE thing we runtime-validate is the wire response
 * (`anthropicResponseProjectionSchema`) — an external, drift-prone source. We
 * validate a PROJECTION (only the fields we consume), then trust our own
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
          { timeout: req.timeoutMs },
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

  const retryAbleError = {
    retryable: false,
    error: error as InstanceType<typeof Anthropic.APIError>,
  };

  if (error instanceof Anthropic.AuthenticationError) {
    return fromApiError("authentication", retryAbleError);
  }

  if (error instanceof Anthropic.PermissionDeniedError) {
    return fromApiError("permission", retryAbleError);
  }

  if (error instanceof Anthropic.NotFoundError) {
    return fromApiError("not_found", retryAbleError);
  }

  if (error instanceof Anthropic.RateLimitError) {
    return fromApiError("rate_limit", retryAbleError);
  }

  if (error instanceof Anthropic.InternalServerError) {
    return fromApiError("provider_unavailable", retryAbleError);
  }

  if (error instanceof Anthropic.BadRequestError) {
    return fromApiError("invalid_request", retryAbleError);
  }

  if (error instanceof Anthropic.ConflictError) {
    return fromApiError("conflict", retryAbleError);
  }

  if (error instanceof Anthropic.UnprocessableEntityError) {
    return fromApiError("invalid_request", retryAbleError);
  }

  if (error instanceof Anthropic.APIError) {
    return fromApiError("unknown", {
      retryable: isRetryableStatus(error.status),
      error,
    });
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
 */
function fromApiError(
  kind: LlmError["kind"],
  {
    retryable,
    error,
  }: { retryable: boolean; error: InstanceType<typeof Anthropic.APIError> },
): LlmError {
  return new LlmError({
    kind,
    message: error.message,
    retryable,
    provider: "anthropic",
    status: error.status,
    requestId: error.requestID ?? undefined,
    providerCode: (error.error as { type?: string } | undefined)?.type,
    cause: error,
  });
}
