import type { ContextWith } from "@/lib/common/create-context";
import { DEFAULT_TIMEOUT_MS } from "../contract/client";
import { LlmOutcome } from "../contract/outcome";
import { LlmUsage, addUsage } from "../contract/response";

/**
 * The retry loop, over the routed seam.
 *
 * It does NOT decide what is retryable — the adapter already did, and encoded it
 * in `outcome.route`. This loop only executes the remedies it is competent to
 * perform in-process, and returns everything else to the caller untouched.
 *
 * THE TABLE. Every route, its remedy, and which budget pays for it:
 *
 *   ROUTE / reason               REMEDY                        BUDGET (default)
 *   ─────────────────────────────────────────────────────────────────────────────
 *   complete                     emit the value                —
 *   retry / rate_limit   (429)   sleep(delay), same payload    transient     (4)
 *   retry / overloaded   (529)   sleep(delay), same payload    transient     (4)
 *   retry / server_error (5xx)   sleep(delay), same payload    transient     (4)
 *   retry / timeout              RESEND — may double-bill      unconfirmed   (1)
 *   retry / network              RESEND — may double-bill      unconfirmed   (1)
 *   retry / model_noncompliant   resample, NO sleep            resample      (1)
 *   decompose/output_truncated   grow budget, NO sleep         doubling      (2)
 *   decompose/input_too_large    -> caller: chunk the INPUT    none
 *   dead_letter                  -> caller: human review       none
 *   cancelled                    -> caller: nobody to page     none
 *   alert                        -> caller: page someone       none
 *
 * FOUR BUDGETS, NOT ONE. A backoff, a budget-doubling, a resample and a resend of a
 * request that may already have run are not the same kind of retry. Sharing a
 * counter between them lets a job run out of attempts having done none of them
 * properly — two 429s would eat the allowance a truncation needed. So:
 *
 *   transient    — the world was busy. Costs TIME. Four is cheap.
 *   unconfirmed  — we never heard back. Costs MONEY, maybe twice. See below.
 *   doubling     — the answer was cut. Costs EXPONENTIAL money: two doublings is
 *                  already 4x the output budget. Two, then escalate to the chunker.
 *   resample     — the model ignored a FORCED tool. Under `tool_choice: {type:
 *                  'tool'}` that should be near-impossible; if it happens twice it
 *                  will happen a third time. One, then give up fast.
 *
 * DOUBLE-BILL. The Messages API has no idempotency key, so the provider cannot
 * dedupe a resend for us. That makes "did the last request actually RUN?" a question
 * we have to answer ourselves, from the failure alone:
 *
 *                          did the request run?
 *                                   │
 *          ┌────────────────────────┴────────────────────────┐
 *   the server ANSWERED                              we never heard back
 *   (429 / 529 / 5xx)                                (timeout / dead connection)
 *          │                                                 │
 *   it refused us. nothing was                    it may have generated a full
 *   generated, nothing was billed.                answer and BILLED us for it.
 *          │                                      we just stopped listening.
 *          │                                                 │
 *   safe to resend.  budget: 4                    resending pays TWICE. budget: 1
 *
 * We cannot prevent the double charge, so we do the only two things left: BOUND it
 * (`maxUnconfirmedRetries`), and never HIDE it — every attempt's `usage` is summed
 * into the returned outcome, so a job that paid twice reports paying twice.
 *
 * `decompose/input_too_large` gets NO local remedy at all — the prompt never fit, so
 * a bigger output budget cannot help and a resend fails identically. It is returned
 * immediately so the chunk queue can split the INPUT.
 *
 * Everything else (`complete`, `dead_letter`, `cancelled`, `alert`) is the caller's
 * to route. This function is not allowed to have an opinion about them, which is why
 * it returns an outcome rather than throwing: an exhausted `retry` and a
 * `dead_letter` are different jobs for the queue, and an exception would flatten them
 * into one.
 *
 * Pure decision-making over the normalized seam — unit-tests with a fake `ctx.sleep`
 * and a fake `ctx.random`: no network, no real waiting, no real entropy. It declares
 * its IO surface honestly: it touches the clock (`'sleep'`) and entropy (`'random'`).
 */
export interface RetryOptions {
  /** Backoff attempts for a transient failure. Cheap — costs time. Default 4. */
  maxTransientRetries?: number;
  /**
   * Resends of a request that MAY ALREADY HAVE RUN (timeout / dropped connection).
   * Each one risks paying and generating twice — see DOUBLE-BILL. Default 1.
   */
  maxUnconfirmedRetries?: number;
  /** Budget doublings after a truncation. Exponential in money. Default 2. */
  maxBudgetDoublings?: number;
  /** Resamples after the model ignores a forced tool. It will not comply. Default 1. */
  maxResamples?: number;
  /** Base backoff in ms; the exponential is `base * 2^(attempt-1)`. Default 200. */
  backoffBaseMs?: number;
  /**
   * The longest we are willing to BLOCK in-process. Default 30s.
   *
   * Two distinct jobs. It caps the exponential — otherwise attempt 10 sleeps for
   * seventeen minutes. And it is the line past which a `retry-after` is no longer
   * ours to honour: see `PARK` in the loop.
   */
  maxBackoffMs?: number;
  /**
   * Spread added on top of a `retry-after` we are obeying. Default 1s.
   *
   * The provider hands every rate-limited client the SAME number, so obeying it
   * exactly re-synchronizes the fleet it was supposed to spread out.
   */
  jitterMs?: number;
  /**
   * Ceiling for the budget doubling. Default 16k — above that the SDK wants
   * streaming anyway. The budget is CLAMPED to it, not gated by it: see the
   * truncation branch.
   */
  maxTokensCeiling?: number;
  /**
   * Ceiling for the timeout that grows with the budget. Default 2 minutes.
   *
   * A non-streaming request that needs longer than this has a streaming problem,
   * not a timeout-tuning problem.
   */
  maxTimeoutMs?: number;
}

export async function withLlmRetry<
  Req extends { maxTokens: number; timeoutMs?: number },
  T,
>(
  // Only `'sleep'` and `'random'`, NOT `'llm'`. The model is reached through the
  // `call` closure, so this function never touches `ctx.llm` — and `ContextWith`
  // exists precisely so that a signature cannot lie about the IO it performs.
  // Declaring `'llm'` here would be claiming an IO surface it does not have.
  ctx: ContextWith<"sleep" | "random">,
  req: Req,
  call: (req: Req) => Promise<LlmOutcome<T>>,
  opts: RetryOptions = {},
): Promise<LlmOutcome<T>> {
  const maxTransientRetries = opts.maxTransientRetries ?? 4;
  const maxUnconfirmedRetries = opts.maxUnconfirmedRetries ?? 1;
  const maxBudgetDoublings = opts.maxBudgetDoublings ?? 2;
  const maxResamples = opts.maxResamples ?? 1;
  const backoffBaseMs = opts.backoffBaseMs ?? 200;
  const maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  const jitterMs = opts.jitterMs ?? 1_000;
  const maxTokensCeiling = opts.maxTokensCeiling ?? 16_000;
  const maxTimeoutMs = opts.maxTimeoutMs ?? 120_000;

  let transient = 0;
  let unconfirmed = 0;
  let doublings = 0;
  let resamples = 0;
  let current = req; // never mutate the caller's request

  // The running bill. Every attempt's usage lands here, so what we finally return
  // is what the JOB cost, not what its last attempt cost.
  let spent: LlmUsage | null = null;

  for (;;) {
    const outcome = await call(current);
    spent = addUsage(spent, outcome.usage);

    if (outcome.route === "retry") {
      // A forced tool that did not fire is not a backoff. Nothing is busy and
      // nothing is broken — resample immediately, and give up fast.
      if (outcome.reason === "model_noncompliant") {
        if (resamples >= maxResamples) return billed(outcome, spent);
        resamples++;
        continue; // no sleep: there is nothing to wait for
      }

      // Did the request RUN? A 429/529/5xx says no — the server answered, refusing.
      // A timeout or a dead connection says we do not know, and a resend may pay for
      // the same generation twice. Separate budget, and a much smaller one.
      const mayHaveRun =
        outcome.reason === "timeout" || outcome.reason === "network";

      if (
        mayHaveRun
          ? unconfirmed >= maxUnconfirmedRetries
          : transient >= maxTransientRetries
      ) {
        return billed(outcome, spent);
      }

      // PARK. The provider told us to wait longer than we are willing to BLOCK for.
      // Sleeping it in-process would hold a request (and a Node process) hostage for
      // as long as the header says — and the header is not ours to bound. So hand the
      // job back INTACT: `outcome.retryAfterMs` still says when to come back, and a
      // queue can park it for that long without occupying anything.
      if (
        outcome.retryAfterMs !== null &&
        outcome.retryAfterMs > maxBackoffMs
      ) {
        return billed(outcome, spent);
      }

      const attempt = mayHaveRun ? ++unconfirmed : ++transient;

      await ctx.sleep(
        backoffMs(outcome.retryAfterMs, attempt, ctx.random, {
          backoffBaseMs,
          maxBackoffMs,
          jitterMs,
        }),
      );
      continue;
    }

    if (
      outcome.route === "decompose" &&
      outcome.reason === "output_truncated"
    ) {
      // THE GATE. Two questions, and nothing else escalates:
      //
      //     already AT the ceiling?  ──yes──► escalate to the chunk queue
      //     out of doublings?        ──yes──► escalate to the chunk queue
      //              │ no
      //              ▼
      //     maxTokens = min(maxTokens * 2, ceiling)   <- CLAMP, not a gate
      //     timeoutMs = scaled by the same factor     <- grows WITH it
      //              │
      //              └──► resend. no sleep (nothing is busy).
      //
      // It gates on where we ALREADY ARE, not on where doubling WOULD take us, and
      // that difference is the whole point. A request at 10k under a 16k ceiling
      // doubles to 20k — over. But the honest reading of "over the ceiling" is "clamp
      // to the ceiling and try", not "give up with 6k of authorized headroom unspent":
      //
      //     10k ─► 16k ─► escalate     (clamp: the headroom gets used)
      //     10k ─► escalate            (gate on the doubled value: 6k stranded)
      //
      // Gating on the doubled value strands every budget that is not an exact power of
      // two below the ceiling, and quietly ships jobs to the chunk queue that a bigger
      // budget would have finished.
      if (
        doublings >= maxBudgetDoublings ||
        current.maxTokens >= maxTokensCeiling
      ) {
        return billed(outcome, spent);
      }

      const grown = Math.min(current.maxTokens * 2, maxTokensCeiling);
      doublings++;
      current = {
        ...current,
        maxTokens: grown,
        // The timeout has to grow WITH the budget. A timeout is a bet on how long
        // generation takes, and we just asked for twice as much of it — leaving the
        // old one in place means the remedy for the truncation manufactures a
        // timeout, which then routes as `retry` and hides the real cause (the budget).
        timeoutMs: grownTimeoutMs(current, grown, maxTimeoutMs),
      };
      // No backoff: nothing is busy and nothing is broken. We asked for an answer
      // that did not fit. Sleeping here would only add latency.
      continue;
    }

    return billed(outcome, spent);
  }
}

/**
 * How long to wait before the next attempt.
 *
 *   retry-after PRESENT ──► retryAfterMs + random() * jitterMs
 *                           │              └── spread, ON TOP (never subtracted:
 *                           │                  waiting less than we were told just
 *                           │                  burns a call)
 *                           └── every rate-limited client was handed the SAME
 *                               number, so obeying it exactly re-synchronizes the
 *                               fleet it was meant to spread out.
 *
 *   retry-after ABSENT ───► exp = min(base * 2^(n-1), maxBackoffMs)
 *                           delay = exp/2 + random() * exp/2
 *                                   └guaranteed┘  └── jitter ──┘
 *                           "equal jitter": we still genuinely back off. (Full
 *                           jitter permits a ~0ms delay, which is not a backoff.)
 *
 * Jitter is not decoration. A fleet that gets rate-limited together backs off
 * together and stampedes together — the retry storm re-creates the condition that
 * caused it. Spreading the retries out is the POINT of the delay, so the entropy
 * comes from `ctx.random` and a test can predict it.
 */
function backoffMs(
  retryAfterMs: number | null,
  attempt: number,
  random: () => number,
  opts: { backoffBaseMs: number; maxBackoffMs: number; jitterMs: number },
): number {
  // The provider TOLD us how long to wait, so waiting less is just a wasted call.
  // Jitter therefore goes strictly ON TOP — never subtracted from what it asked for.
  if (retryAfterMs !== null) {
    return retryAfterMs + Math.round(random() * opts.jitterMs);
  }

  const exponential = Math.min(
    opts.backoffBaseMs * 2 ** (attempt - 1),
    opts.maxBackoffMs,
  );

  // Equal jitter: half the window is guaranteed, so we genuinely back off; the other
  // half is random, so two clients that failed on the same tick do not retry on the
  // same tick. (Full jitter would allow a ~0ms retry, which is not a backoff at all.)
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

/** Scale the timeout by the same factor the budget grew, then clamp. */
function grownTimeoutMs(
  current: { maxTokens: number; timeoutMs?: number },
  grown: number,
  maxTimeoutMs: number,
): number {
  const base = current.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const scaled = Math.ceil((base * grown) / current.maxTokens);
  return Math.min(scaled, maxTimeoutMs);
}

/**
 * Stamp the JOB's total cost onto the outcome of its final attempt.
 *
 * `cancelled` is the one route left alone: its `usage` is typed `null` — the caller
 * walked away, and the union says so. That is a deliberate modelling choice upstream,
 * not something to quietly widen from here.
 */
function billed<T>(
  outcome: LlmOutcome<T>,
  spent: LlmUsage | null,
): LlmOutcome<T> {
  if (outcome.route === "cancelled") return outcome;
  if (outcome.route === "complete")
    return { ...outcome, usage: spent ?? outcome.usage };
  return { ...outcome, usage: spent };
}
