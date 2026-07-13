import { LlmRoute, LlmReason, LlmSignals } from "./disposition";

export interface ValidationIssue {
  path: string;
  message: string;
  code?: string;
}

export interface LlmErrorOptions {
  /** WHAT TO DO. The triage decision, computed once, in the adapter. */
  route: LlmRoute;
  /** WHY, at the granularity anyone acts on. Absent on routes that carry none. */
  reason?: LlmReason;
  message: string;
  /** The provider's own `retry-after`, in ms. Only meaningful on `route: 'retry'`. */
  retryAfterMs?: number;
  /** The raw receipt. Always present, even when the call never landed. */
  signals: LlmSignals;
  /** Which field the model got wrong, for the human in the DLQ. */
  issues?: ValidationIssue[];
  /** The underlying throwable, if any. Standard `Error.cause`. */
  cause?: unknown;
}

/**
 * A failed model call.
 *
 * It carries the ROUTE, not a private error taxonomy. There is no `kind` and no
 * `retryable` boolean — both existed once, and both were a second, independent
 * copy of a decision the adapter had already made. They drifted from it (a 529
 * and a truncated output both reported `retryable: true` while needing opposite
 * remedies), and that drift is the bug this design exists to make impossible.
 *
 * `retryable` in particular is now just `route === 'retry'`. Storing it was
 * storing a derivable fact, which is exactly how two sources of truth are born.
 *
 * The field is `reason`, not `cause`, because `Error` already owns `cause` —
 * that one holds the underlying throwable, and shadowing it would be a trap.
 */
export class LlmError extends Error {
  readonly route: LlmRoute;
  readonly reason?: LlmReason;
  readonly retryAfterMs?: number;
  readonly signals: LlmSignals;
  readonly issues?: ValidationIssue[];

  constructor(options: LlmErrorOptions) {
    super(options.message, { cause: options.cause });

    this.name = "LlmError";
    this.route = options.route;
    this.reason = options.reason;
    this.retryAfterMs = options.retryAfterMs;
    this.signals = options.signals;
    this.issues = options.issues;
  }
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
