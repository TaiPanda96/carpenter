import { describe, expect, it, mock } from 'bun:test'
import { createMockContext } from '@/lib/common/test/mocks/mock-context'
import type { LlmSignals, RetryReason } from '../contract/disposition'
import { LlmError } from '../contract/errors'
import type { LlmOutcome } from '../contract/outcome'
import { withLlmRetry } from './with-llm-retry'

/**
 * The retry loop's whole job is knowing which remedy fits which route, and how much
 * of each remedy is worth spending. That is a business rule, so it is tested.
 *
 * Three budgets, not one. A backoff costs TIME, a resample of a forced tool is
 * near-certain to fail again, and a resend after a TIMEOUT may pay twice for a
 * generation that already happened. Sharing one counter between them lets a job run
 * out of attempts having done none of them properly.
 *
 * And one NON-remedy, which is the newest rule here: a truncation is not retried at
 * all. See the truncation tests below for why the budget-doubling that used to live
 * here was a mistake rather than a missing feature.
 */

const REQ = { model: 'claude-opus-4-8', prompt: 'hi', maxTokens: 256 }

const SIGNALS: LlmSignals = {
  provider: 'anthropic',
  rawStopReason: null,
  httpStatus: null,
  providerCode: null,
  requestId: null,
  model: 'claude-opus-4-8',
}

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: null,
  cacheWriteTokens: null,
}

type Outcome = LlmOutcome<{ text: string }>

function complete(): Outcome {
  return {
    route: 'complete',
    value: { text: 'answer' },
    usage: USAGE,
    signals: SIGNALS,
  }
}

/** A 429/529/5xx: the server ANSWERED, refusing. Nothing generated, nothing billed. */
function transient(
  retryAfterMs: number | null = null,
  reason: RetryReason = 'overloaded',
): Outcome {
  return {
    route: 'retry',
    reason,
    retryAfterMs,
    error: new LlmError({
      route: 'retry',
      reason,
      message: reason,
      signals: SIGNALS,
    }),
    usage: null,
    signals: SIGNALS,
  }
}

/**
 * A timeout: we never got an answer, so we do not know whether the request RAN. It
 * may have generated a full response and billed us for it. `usage: null` because we
 * never saw a usage record — which is exactly the problem.
 */
function timedOut(): Outcome {
  return transient(null, 'timeout')
}

function noncompliant(): Outcome {
  return {
    route: 'retry',
    reason: 'model_noncompliant',
    retryAfterMs: null,
    error: new LlmError({
      route: 'retry',
      reason: 'model_noncompliant',
      message: 'model ignored the forced tool',
      signals: SIGNALS,
    }),
    usage: USAGE,
    signals: SIGNALS,
  }
}

function truncated(): Outcome {
  return {
    route: 'decompose',
    reason: 'output_truncated',
    error: new LlmError({
      route: 'decompose',
      reason: 'output_truncated',
      message: 'truncated',
      signals: SIGNALS,
    }),
    usage: USAGE,
    signals: SIGNALS,
  }
}

function inputTooLarge(): Outcome {
  return {
    route: 'decompose',
    reason: 'input_too_large',
    error: new LlmError({
      route: 'decompose',
      reason: 'input_too_large',
      message: 'prompt is too long',
      signals: SIGNALS,
    }),
    usage: null,
    signals: SIGNALS,
  }
}

/** A fake clock — instant, and records that backoff was actually awaited. */
function fakeSleep() {
  const calls: number[] = []
  const sleep = mock(async (ms: number) => {
    calls.push(ms)
  })
  return { sleep, calls }
}

/**
 * Fake entropy. `0` is the no-jitter corner: the exponential collapses to its
 * GUARANTEED half and a `retry-after` is obeyed to the millisecond, so every delay
 * below is the floor of its window. The jitter itself is tested separately.
 */
function ctxWith(sleep: (ms: number) => Promise<void>, random: () => number = () => 0) {
  return createMockContext({ sleep, random })
}

/** A fake model that records every request it was handed, in order. */
function fakeCall(impl: (req: typeof REQ, call: number) => Outcome) {
  const requests: (typeof REQ & { timeoutMs?: number })[] = []
  const call = mock(async (req: typeof REQ & { timeoutMs?: number }) => {
    requests.push(req)
    return impl(req, requests.length)
  })
  return { requests, call }
}

describe('withLlmRetry', () => {
  it('returns route complete immediately on success — no retry, no sleep', async () => {
    const { call } = fakeCall(() => complete())
    const { sleep, calls } = fakeSleep()

    const outcome = await withLlmRetry(ctxWith(sleep), REQ, call)

    expect(outcome.route).toBe('complete')
    expect(call).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([])
  })

  it('backs off exponentially on a transient failure, then succeeds', async () => {
    const { call } = fakeCall((_r, n) => (n < 3 ? transient() : complete()))
    const { sleep, calls } = fakeSleep()

    const outcome = await withLlmRetry(ctxWith(sleep), REQ, call, {
      backoffBaseMs: 10,
    })

    expect(outcome.route).toBe('complete')
    // Windows are 10 and 20 (10 * 2^0, 10 * 2^1); half of each is guaranteed and half
    // is jitter, and this ctx's random() is 0 — so we see the guaranteed halves.
    expect(calls).toEqual([5, 10])
  })

  it("obeys the provider's retry-after over its own exponential backoff", async () => {
    const { call } = fakeCall((_r, n) => (n === 1 ? transient(1500) : complete()))
    const { sleep, calls } = fakeSleep()

    await withLlmRetry(ctxWith(sleep), REQ, call, { backoffBaseMs: 10 })

    expect(calls).toEqual([1500]) // not 10 — the API said how long to wait
  })

  it('JITTERS the backoff — a fleet that fails together must not retry together', async () => {
    // The delay is the mechanism that spreads a retry storm out. Without jitter every
    // client that got 429'd on the same tick comes back on the same tick and recreates
    // the overload. `random() => 1` is the top of each window.
    const { call } = fakeCall((_r, n) => (n < 3 ? transient() : complete()))
    const { sleep, calls } = fakeSleep()

    await withLlmRetry(
      ctxWith(sleep, () => 1),
      REQ,
      call,
      { backoffBaseMs: 10 },
    )

    expect(calls).toEqual([10, 20]) // the full window, vs [5, 10] at random() === 0
  })

  it('adds jitter ON TOP of a retry-after, never subtracting from it', async () => {
    // Waiting LESS than the provider asked for just burns a call. But every rate-limited
    // client was handed the SAME retry-after, so obeying it exactly re-synchronizes the
    // fleet. The spread therefore goes on top.
    const { call } = fakeCall((_r, n) => (n === 1 ? transient(1500) : complete()))
    const { sleep, calls } = fakeSleep()

    await withLlmRetry(
      ctxWith(sleep, () => 1),
      REQ,
      call,
      { jitterMs: 400 },
    )

    expect(calls).toEqual([1900]) // 1500 + 400 — never below 1500
  })

  it('caps the exponential at maxBackoffMs rather than sleeping for minutes', async () => {
    const { call } = fakeCall((_r, n) => (n < 5 ? transient() : complete()))
    const { sleep, calls } = fakeSleep()

    await withLlmRetry(
      ctxWith(sleep, () => 1),
      REQ,
      call,
      {
        backoffBaseMs: 1_000,
        maxBackoffMs: 2_500,
      },
    )

    // Windows would be 1000, 2000, 4000, 8000 — the last two are clamped.
    expect(calls).toEqual([1000, 2000, 2500, 2500])
  })

  it('PARKS the job rather than blocking when retry-after exceeds what we will wait for', async () => {
    // A `retry-after: 3600` is a real thing to receive. Sleeping it in-process pins a
    // request (and a Node process) for an hour. The outcome already carries the number,
    // so hand it back and let a queue park it — that costs nothing while it waits.
    const { call } = fakeCall(() => transient(3_600_000))
    const { sleep, calls } = fakeSleep()

    const outcome = await withLlmRetry(ctxWith(sleep), REQ, call, {
      maxBackoffMs: 30_000,
    })

    expect(call).toHaveBeenCalledTimes(1) // never resent
    expect(calls).toEqual([]) // and never slept
    expect(outcome.route).toBe('retry')
    if (outcome.route !== 'retry') throw new Error('unreachable')
    expect(outcome.retryAfterMs).toBe(3_600_000) // intact, so the queue knows when to come back
  })

  it('returns the exhausted retry outcome so the queue can park the job', async () => {
    const { call } = fakeCall(() => transient())
    const { sleep, calls } = fakeSleep()

    const outcome = await withLlmRetry(ctxWith(sleep), REQ, call, {
      maxTransientRetries: 2,
      backoffBaseMs: 10,
    })

    expect(outcome.route).toBe('retry')
    if (outcome.route !== 'retry') throw new Error('unreachable')
    expect(outcome.reason).toBe('overloaded') // 529 is capacity, NOT a 5xx incident
    expect(call).toHaveBeenCalledTimes(3) // initial + 2 retries
    expect(calls).toEqual([5, 10])
  })

  it('resends a TIMEOUT at most once — the request may already have run, and billed', async () => {
    // The Messages API has no idempotency key, so a resend cannot be deduplicated. A
    // 429 is safe to resend (the server refused; nothing was generated). A timeout is
    // NOT: the request may have completed and charged us, and we simply stopped
    // listening. So it gets its own budget, and a tiny one.
    const { call } = fakeCall(() => timedOut())
    const { sleep } = fakeSleep()

    const outcome = await withLlmRetry(ctxWith(sleep), REQ, call, {
      maxTransientRetries: 4,
    })

    expect(call).toHaveBeenCalledTimes(2) // initial + 1 — NOT the 5 a 429 would have got
    expect(outcome.route).toBe('retry')
    if (outcome.route !== 'retry') throw new Error('unreachable')
    expect(outcome.reason).toBe('timeout')
  })

  it('keeps the timeout budget SEPARATE from the rate-limit budget', async () => {
    // A 429 must not consume the (much smaller) allowance for resends that risk paying
    // twice, and a timeout must not consume the cheap backoff allowance.
    const script: Outcome[] = [transient(), timedOut(), transient(), complete()]
    const { call } = fakeCall((_r, n) => script[n - 1] ?? complete())
    const { sleep } = fakeSleep()

    const outcome = await withLlmRetry(ctxWith(sleep), REQ, call, {
      maxTransientRetries: 2,
      maxUnconfirmedRetries: 1,
      backoffBaseMs: 10,
    })

    // The timeout spent the unconfirmed budget; the two 429s spent the transient one.
    // Under a shared counter of 2 this job would have died on the third failure.
    expect(outcome.route).toBe('complete')
    expect(call).toHaveBeenCalledTimes(4)
  })

  it('SUMS the usage of every attempt — a job that paid twice must report paying twice', async () => {
    // A failed attempt that reached the model still burned tokens, and the adapter keeps
    // `usage` on it for exactly that reason. Returning only the final attempt's usage
    // would destroy that one layer up: the discarded generation was billed, and the cost
    // dashboard has to see it.
    const { call } = fakeCall((_r, n) => (n === 1 ? noncompliant() : complete()))
    const { sleep } = fakeSleep()

    const outcome = await withLlmRetry(ctxWith(sleep), REQ, call)

    expect(outcome.route).toBe('complete')
    // Two attempts, each 1 in / 1 out — not the 1/1 of the surviving attempt alone.
    expect(outcome.usage).toEqual({
      inputTokens: 2,
      outputTokens: 2,
      cacheReadTokens: null, // neither attempt REPORTED cache; that is not the same as 0
      cacheWriteTokens: null,
    })
  })

  it('carries the spend of earlier attempts onto a failure outcome too', async () => {
    const { call } = fakeCall(() => noncompliant())
    const { sleep } = fakeSleep()

    const outcome = await withLlmRetry(ctxWith(sleep), REQ, call)

    // Two attempts that both burned tokens and produced nothing usable. The DLQ should
    // see what the job cost before it gave up.
    expect(outcome.usage).toMatchObject({ inputTokens: 2, outputTokens: 2 })
  })

  it('does NOT retry a truncation — a cut-off answer cannot be resumed, only re-bought', async () => {
    // THE REGRESSION TEST FOR THE FIX. This loop used to double `maxTokens` and resend,
    // up to twice. That is not a retry: a truncated answer cannot be CONTINUED
    // (assistant-turn prefill is a 400 on every current model, and half-written tool
    // JSON cannot be continued regardless), so each "retry" was a full resample that
    // discarded a generation we had already paid for.
    //
    // The doubling only ever existed to compensate for a low `maxTokens`, and that was
    // only forced by a non-streaming request. The adapter streams now. So a truncation
    // means what it says — the answer does not fit in the model's output ceiling — and
    // goes straight to the caller to split the task.
    const { requests, call } = fakeCall(() => truncated())
    const { sleep, calls } = fakeSleep()

    const outcome = await withLlmRetry(ctxWith(sleep), REQ, call)

    expect(outcome.route).toBe('decompose')
    if (outcome.route !== 'decompose') throw new Error('unreachable')
    expect(outcome.reason).toBe('output_truncated')
    expect(call).toHaveBeenCalledTimes(1) // ONE paid request, not three
    expect(requests.map((r) => r.maxTokens)).toEqual([256]) // the budget is never rewritten
    expect(calls).toEqual([])
  })

  it('does not retry an oversized INPUT either — a bigger output cap cannot fix it', async () => {
    // The two decompose reasons share a route and a non-remedy, but NOT a fix: chunk the
    // INPUT here, split the TASK for a truncation. That distinction is why they are two
    // reasons and not one `payload_too_large` boolean.
    const { requests, call } = fakeCall(() => inputTooLarge())
    const { sleep, calls } = fakeSleep()

    const outcome = await withLlmRetry(ctxWith(sleep), REQ, call)

    expect(outcome.route).toBe('decompose')
    if (outcome.route !== 'decompose') throw new Error('unreachable')
    expect(outcome.reason).toBe('input_too_large')
    expect(call).toHaveBeenCalledTimes(1)
    expect(requests.map((r) => r.maxTokens)).toEqual([256])
    expect(calls).toEqual([])
  })

  it('still bills a truncation — one paid failure is cheaper than three, not free', async () => {
    // Not retrying does not mean not paying. The generation ran to the cap and was
    // billed; nulling the usage would make a paid-for failure look free to the cost
    // dashboard, which is the exact thing the running bill exists to prevent.
    const { call } = fakeCall(() => truncated())
    const { sleep } = fakeSleep()

    const outcome = await withLlmRetry(ctxWith(sleep), REQ, call)

    expect(outcome.usage).toMatchObject({ inputTokens: 1, outputTokens: 1 })
  })

  it('resamples a noncompliant model WITHOUT backoff, and gives up fast', async () => {
    // A forced tool that did not fire is not a backoff — nothing is busy. And under
    // `tool_choice: {type: "tool"}` a model that refused twice will refuse again, so the
    // budget is tiny (default 1) and separate from the rate-limit pool.
    const { call } = fakeCall(() => noncompliant())
    const { sleep, calls } = fakeSleep()

    const outcome = await withLlmRetry(ctxWith(sleep), REQ, call)

    expect(outcome.route).toBe('retry')
    if (outcome.route !== 'retry') throw new Error('unreachable')
    expect(outcome.reason).toBe('model_noncompliant')
    expect(call).toHaveBeenCalledTimes(2) // initial + 1 resample (the default)
    expect(calls).toEqual([]) // never slept
  })

  it('keeps the budgets SEPARATE — a resample cannot eat the rate-limit budget', async () => {
    // THE regression this design exists to prevent. Under one shared counter of 2, this
    // job would exhaust after 429 -> noncompliant -> 429, having resampled only once and
    // backed off only once. With separate budgets each remedy gets its full allowance,
    // and the job succeeds on the fourth attempt.
    const script: Outcome[] = [transient(), noncompliant(), transient(), complete()]
    const { call } = fakeCall((_r, n) => script[n - 1] ?? complete())
    const { sleep, calls } = fakeSleep()

    const outcome = await withLlmRetry(ctxWith(sleep), REQ, call, {
      maxTransientRetries: 2,
      maxResamples: 1,
      backoffBaseMs: 10,
    })

    expect(outcome.route).toBe('complete')
    expect(call).toHaveBeenCalledTimes(4)
    // Two backoffs on the transient counter; the resample slept for nothing in between,
    // because nothing was busy.
    expect(calls).toEqual([5, 10])
  })
})
