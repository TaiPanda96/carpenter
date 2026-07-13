import z from "zod";

export interface ValidationIssue {
  path: string;
  message: string;
  code?: string;
}

export const llmErrorKindSchema = z.enum([
  "invalid_request",
  "authentication",
  "permission",
  "not_found",
  "conflict",
  "rate_limit",
  "timeout",
  "connection",
  "provider_unavailable",
  "provider_response_invalid",
  "output_validation",
  /** The tool JSON was CUT OFF, not wrong (stop_reason: max_tokens). Retry with a bigger budget. */
  "output_truncated",
  /** The model ignored a FORCED tool and answered some other way. Retry. */
  "tool_use_missing",
  "refusal",
  "aborted",
  "unknown",
]);

export type LlmErrorKind = z.infer<typeof llmErrorKindSchema>;

export interface LlmErrorOptions {
  kind: LlmErrorKind;
  message: string;
  retryable: boolean;

  provider?: "anthropic";
  status?: number;
  requestId?: string;
  providerCode?: string;
  retryAfterMs?: number;
  issues?: ValidationIssue[];

  cause?: unknown;
}

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly retryable: boolean;
  readonly provider?: "anthropic";
  readonly status?: number;
  readonly requestId?: string;
  readonly providerCode?: string;
  readonly retryAfterMs?: number;
  readonly issues?: ValidationIssue[];

  constructor(options: LlmErrorOptions) {
    super(options.message, { cause: options.cause });

    this.name = "LlmError";
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.provider = options.provider;
    this.status = options.status;
    this.requestId = options.requestId;
    this.providerCode = options.providerCode;
    this.retryAfterMs = options.retryAfterMs;
    this.issues = options.issues;
  }
}

/**
 * Map an HTTP status to Retry-ability — the retryable-vs-not taxonomy, stated
 * explicitly so it's defensible and overridable. `undefined` means the request
 * never got a response (connection error) — safe to retry.
 *   408 timeout, 409 conflict, 429 rate limit, 5xx server — retry.
 *   Other 4xx (400/401/403/404) — caller error, retrying won't help.
 */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Flatten zod issues into a transport-safe, loggable shape.
 *
 * Typed structurally rather than as `z.ZodIssue[]` so that BOTH zod versions in
 * play satisfy it: the wire projection is parsed with v3, while the model's
 * generated object is parsed with the v4 schema (`llm-object.ts`, whose issues
 * carry `path: PropertyKey[]`). One issue-flattener, no cast at either call site.
 */
export function toValidationIssues(
  issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
    readonly code?: string;
  }[],
): ValidationIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
    code: issue.code,
  }));
}
