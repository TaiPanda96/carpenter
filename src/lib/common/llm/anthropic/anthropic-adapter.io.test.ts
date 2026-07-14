import { describe, expect, it } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import type { LlmSignals } from '../contract/disposition'
import type { LlmCompletionStop, LlmUsage } from '../contract/response'
import {
  parseRetryAfterMs,
  routeNonTerminalStop,
  routeThrownError,
  thinkingConfig,
} from './anthropic-adapter.io'

/**
 * The classification table IS the business rule here. It is the only thing in the
 * system that knows a 529 is capacity and a 500 is breakage, that a 413 and a
 * `max_tokens` stop are both "the payload is wrong" but want opposite remedies, and
 * that a refusal is a 200 OK you must not use.
 *
 * These are pure functions over provider signals, so they test without a network or
 * a mocked SDK — the SDK's own `APIError.generate` builds the real error classes
 * from a real status, which is exactly the dispatch we depend on.
 */

const USAGE: LlmUsage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: null,
  cacheWriteTokens: null,
}

const SIGNALS: LlmSignals = {
  provider: 'anthropic',
  rawStopReason: null,
  httpStatus: 200,
  providerCode: null,
  requestId: 'req_1',
  model: 'claude-opus-4-8',
}

/** Build the error the SDK would actually throw for a given status. */
function apiError(status: number, type: string, message: string, headers = {}) {
  return Anthropic.APIError.generate(
    status,
    { type: 'error', error: { type, message } },
    message,
    new Headers(headers),
  )
}

function stop(kind: LlmCompletionStop['kind'], reason: string): LlmCompletionStop {
  return { kind, providerReason: reason } as LlmCompletionStop
}

describe('routeThrownError — HTTP status to routing decision', () => {
  it('routes 429 to the retry queue and carries the provider retry-after', () => {
    const outcome = routeThrownError(
      apiError(429, 'rate_limit_error', 'rate limited', {
        'retry-after': '30',
      }),
    )

    expect(outcome.route).toBe('retry')
    if (outcome.route !== 'retry') throw new Error('unreachable')
    expect(outcome.reason).toBe('rate_limit')
    expect(outcome.retryAfterMs).toBe(30_000) // obey the header, do not guess
    expect(outcome.signals.httpStatus).toBe(429)
    // Reads `error.type`, NOT `error.error.type` — the latter is the envelope, and
    // yields the literal string 'error' for every failure ever thrown.
    expect(outcome.signals.providerCode).toBe('rate_limit_error')
  })

  it('distinguishes 529 (capacity) from 500 (breakage) — the SDK lumps both into InternalServerError', () => {
    const overloaded = routeThrownError(apiError(529, 'overloaded_error', 'overloaded'))
    const broken = routeThrownError(apiError(500, 'api_error', 'boom'))

    expect(overloaded.route).toBe('retry')
    if (overloaded.route !== 'retry') throw new Error('unreachable')
    expect(overloaded.reason).toBe('overloaded')

    expect(broken.route).toBe('retry')
    if (broken.route !== 'retry') throw new Error('unreachable')
    expect(broken.reason).toBe('server_error')
  })

  it('routes a 413 to the chunk queue as input_too_large — the SDK has no class for it', () => {
    const outcome = routeThrownError(apiError(413, 'request_too_large', 'request too large'))

    expect(outcome.route).toBe('decompose')
    if (outcome.route !== 'decompose') throw new Error('unreachable')
    expect(outcome.reason).toBe('input_too_large')
  })

  it('BACKSTOPS an over-long prompt out of a generic 400', () => {
    // The pre-flight count_tokens guard is the primary path now; this regex only
    // catches what slips past it (a model missing from CONTEXT_WINDOW, or an
    // estimate that under-counted).
    const outcome = routeThrownError(
      apiError(400, 'invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum'),
    )

    expect(outcome.route).toBe('decompose')
    if (outcome.route !== 'decompose') throw new Error('unreachable')
    expect(outcome.reason).toBe('input_too_large')
  })

  it('dead-letters any OTHER 400 — when the backstop misses, the job parks safely', () => {
    const outcome = routeThrownError(
      apiError(400, 'invalid_request_error', 'messages: roles must alternate'),
    )

    expect(outcome.route).toBe('dead_letter')
    if (outcome.route !== 'dead_letter') throw new Error('unreachable')
    expect(outcome.reason).toBe('invalid_request')
  })

  it("dead-letters 401/403 with reason 'auth' — an alerting rule keys on that", () => {
    for (const status of [401, 403]) {
      const outcome = routeThrownError(apiError(status, 'authentication_error', 'bad key'))

      expect(outcome.route).toBe('dead_letter')
      if (outcome.route !== 'dead_letter') throw new Error('unreachable')
      expect(outcome.reason).toBe('auth')
      // 401 vs 403 is no longer named by the taxonomy — it lives on the receipt,
      // which is where detail belongs once you refuse to keep two enums in sync.
      expect(outcome.signals.httpStatus).toBe(status)
    }
  })

  it('dead-letters a 404 as not_found — a bad model id is our bug, not a transient', () => {
    const outcome = routeThrownError(apiError(404, 'not_found_error', 'model not found'))

    expect(outcome.route).toBe('dead_letter')
    if (outcome.route !== 'dead_letter') throw new Error('unreachable')
    expect(outcome.reason).toBe('not_found')
  })

  it("routes an aborted request to 'cancelled' — nothing to retry, nobody to page", () => {
    const outcome = routeThrownError(new Anthropic.APIUserAbortError({ message: 'aborted' }))

    expect(outcome.route).toBe('cancelled')
    expect(outcome.usage).toBeNull()
  })

  it("routes an unrecognized throwable to 'alert' rather than guessing at retryability", () => {
    const outcome = routeThrownError(new Error('something nobody planned for'))

    expect(outcome.route).toBe('alert')
  })

  it('puts the route on the LlmError too, so an unwrapped throw stays triageable', () => {
    const outcome = routeThrownError(apiError(429, 'rate_limit_error', 'rate limited'))

    if (outcome.route !== 'retry') throw new Error('unreachable')
    // ONE taxonomy. The error does not carry a second, private opinion about what
    // happened — it carries the same route the outcome does. That is what lets
    // `expectComplete()` throw at a boundary without destroying the triage.
    expect(outcome.error.route).toBe('retry')
    expect(outcome.error.reason).toBe('rate_limit')
    expect(outcome.error.signals.httpStatus).toBe(429)
  })
})

describe('routeNonTerminalStop — stop_reason to routing decision', () => {
  it('lets a healthy terminal stop through untouched', () => {
    expect(routeNonTerminalStop(stop('complete', 'end_turn'), USAGE, SIGNALS, 1000)).toBeUndefined()
    expect(
      routeNonTerminalStop(stop('stop_sequence', 'stop_sequence'), USAGE, SIGNALS, 1000),
    ).toBeUndefined()
  })

  it('routes max_tokens to decompose/output_truncated and KEEPS the usage', () => {
    const outcome = routeNonTerminalStop(stop('max_tokens', 'max_tokens'), USAGE, SIGNALS, 1000)

    expect(outcome?.route).toBe('decompose')
    if (outcome?.route !== 'decompose') throw new Error('unreachable')
    expect(outcome.reason).toBe('output_truncated') // NOT input_too_large
    // A truncated call still burned tokens. Nulling usage here would make a
    // paid-for failure look free.
    expect(outcome.usage).toEqual(USAGE)
  })

  it('routes model_context_window_exceeded to decompose/input_too_large — the OTHER reason', () => {
    const outcome = routeNonTerminalStop(
      stop('context_window_exceeded', 'model_context_window_exceeded'),
      USAGE,
      SIGNALS,
      1000,
    )

    expect(outcome?.route).toBe('decompose')
    if (outcome?.route !== 'decompose') throw new Error('unreachable')
    // Same queue as a truncation, opposite remedy: chunk the INPUT. Doubling
    // max_tokens here would fail identically, forever.
    expect(outcome.reason).toBe('input_too_large')
  })

  it('routes a refusal to dead_letter — a 200 OK whose content must not be used', () => {
    const outcome = routeNonTerminalStop(stop('refusal', 'refusal'), USAGE, SIGNALS, 1000)

    expect(outcome?.route).toBe('dead_letter')
    if (outcome?.route !== 'dead_letter') throw new Error('unreachable')
    expect(outcome.reason).toBe('refusal')
  })

  it("routes a tool_use stop to 'alert' — complete() sends no tools, so it cannot happen", () => {
    // `generateObject` handles its own tool_use before ever calling this, so reaching
    // here means the provider returned a tool_use stop for a request that carried no
    // tools. Do not invent a meaning for it — say we do not understand, and page.
    const outcome = routeNonTerminalStop(stop('tool_use', 'tool_use'), USAGE, SIGNALS, 1000)

    expect(outcome?.route).toBe('alert')
  })

  it("routes an unknown stop_reason to 'alert' and preserves the raw signal", () => {
    const signals = { ...SIGNALS, rawStopReason: 'some_new_reason_2027' }
    const outcome = routeNonTerminalStop(
      stop('other', 'some_new_reason_2027'),
      USAGE,
      signals,
      1000,
    )

    // Do not guess. The mapping is out of date and a human must see the raw value.
    expect(outcome?.route).toBe('alert')
    expect(outcome?.signals.rawStopReason).toBe('some_new_reason_2027')
  })
})

describe('thinkingConfig', () => {
  it('NEVER omits the field — an omitted `thinking` means different things per model', () => {
    // This is the actual rule. Omitting it at the provider means NO thinking on
    // claude-opus-4-8/4-7 and ADAPTIVE thinking on claude-sonnet-5. Since thinking
    // tokens come out of `max_tokens`, an omitted field would silently change what the
    // identical request costs, and how often it truncates, depending on the model.
    expect(thinkingConfig(undefined)).toEqual({ type: 'adaptive' })
    expect(thinkingConfig('adaptive')).toEqual({ type: 'adaptive' })
    expect(thinkingConfig('disabled')).toEqual({ type: 'disabled' })
  })

  it('defaults to ADAPTIVE, not disabled — reasoning is the biggest quality lever there is', () => {
    // The default was `disabled` for about an hour, justified by "generateObject forces
    // a tool, so the shape is already pinned". That argument is wrong twice: it says
    // nothing about `complete()` (no schema pins anything there), and a forced tool pins
    // the SHAPE of an answer, not the reasoning that produces it — a schema is very good
    // at making a hard extraction look mechanical.
    expect(thinkingConfig(undefined)).toEqual({ type: 'adaptive' })
  })
})

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '30' }))).toBe(30_000)
  })

  it('parses the HTTP-date form — RFC 9110 allows it and the old impl silently dropped it', () => {
    const at = new Date(Date.now() + 20_000).toUTCString()
    const ms = parseRetryAfterMs(new Headers({ 'retry-after': at }))

    expect(ms).not.toBeNull()
    // Second-resolution truncation in the date format, so allow a 1s window.
    expect(ms).toBeGreaterThan(18_000)
    expect(ms).toBeLessThanOrEqual(20_000)
  })

  it('floors a past HTTP-date at 0 rather than going negative', () => {
    const at = new Date(Date.now() - 60_000).toUTCString()
    expect(parseRetryAfterMs(new Headers({ 'retry-after': at }))).toBe(0)
  })

  it('accepts a plain object — the error path is the most-mocked code in any SDK', () => {
    expect(parseRetryAfterMs({ 'retry-after': '5' })).toBe(5_000)
  })

  it('yields null for junk rather than a NaN sleep', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': 'soon' }))).toBeNull()
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '' }))).toBeNull()
    expect(parseRetryAfterMs(new Headers())).toBeNull()
    expect(parseRetryAfterMs(undefined)).toBeNull()
    expect(parseRetryAfterMs('not-an-object')).toBeNull()
  })
})
