import {
  LlmSignals,
  RetryReason,
  DecomposeReason,
  DeadLetterReason,
} from "./disposition";
import { LlmError } from "./errors";
import { LlmUsage } from "./response";

/**
 * The normalized outcome of one model call. This IS the triage table:
 *
 *   complete    -> emit the result
 *   retry       -> retry queue, backoff(retryAfterMs)
 *   decompose   -> chunk queue (see DecomposeReason — the remedy differs)
 *   dead_letter -> human review
 *   cancelled   -> the caller walked away. Not a failure; nobody to page.
 *   alert       -> we do not know what this is. Page someone.
 *
 * Deliberately a discriminated union, not a bag of nullable fields. A shape like
 * `{ ok: boolean; stopReason: X | null; errorKind: Y | null }` makes
 * `{ ok: true, errorKind: 'POLICY' }` representable, so every consumer has to
 * defensively re-check what the type already should have guaranteed. Here `value`
 * exists iff the call produced one, `error` iff it failed, and `retryAfterMs` iff
 * there is something to wait for. Illegal states do not typecheck, and a
 * `switch (outcome.route)` is exhaustive with no `default:` to hide in.
 *
 * `usage` is nullable on the failure routes on purpose. A 429 never produced a
 * usage record, and reporting zeros there would make a rejected call look free.
 * A truncation DID produce one — and you want it, because a truncated call is a
 * paid-for failure.
 *
 * These values are built by our own deterministic code, so — per the Trust
 * Boundaries rule — there is nothing untrusted to parse and no zod schema here.
 * The untrusted thing is the wire response, and THAT is validated in the adapter.
 */
export type LlmOutcome<T> =
  | {
      route: "complete";
      value: T;
      usage: LlmUsage;
      signals: LlmSignals;
    }
  | {
      route: "retry";
      reason: RetryReason;
      /** From the provider's `retry-after` header. Null = use your own backoff. */
      retryAfterMs: number | null;
      error: LlmError;
      usage: LlmUsage | null;
      signals: LlmSignals;
    }
  | {
      route: "decompose";
      reason: DecomposeReason;
      error: LlmError;
      usage: LlmUsage | null;
      signals: LlmSignals;
    }
  | {
      route: "dead_letter";
      reason: DeadLetterReason;
      error: LlmError;
      usage: LlmUsage | null;
      signals: LlmSignals;
    }
  | {
      route: "cancelled";
      error: LlmError;
      usage: null;
      signals: LlmSignals;
    }
  | {
      route: "alert";
      error: LlmError;
      usage: LlmUsage | null;
      signals: LlmSignals;
    };
