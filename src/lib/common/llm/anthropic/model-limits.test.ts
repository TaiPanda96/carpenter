import { describe, expect, it } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import {
  CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  contextWindow,
  estimateTokens,
  maxOutputTokens,
  needsTokenPreflight,
} from './model-limits'

describe('contextWindow', () => {
  it('returns undefined for an unknown model rather than guessing', () => {
    // A guessed window is worse than none. Defaulting to 200k against a 1M-window
    // model would reject valid prompts as "too large" and chunk them for nothing.
    expect(contextWindow('claude-from-the-future')).toBeUndefined()
  })
})

describe('maxOutputTokens', () => {
  it('returns undefined for an unknown model rather than guessing', () => {
    // Same rule as the window: the adapter only uses this to CLAMP a caller's cap, so
    // an unknown model means "pass the caller's number through". Inventing a ceiling
    // here would silently shrink a request against a limit we made up.
    expect(maxOutputTokens('claude-from-the-future')).toBeUndefined()
  })

  it('is NOT the same as the context window — they are different limits', () => {
    // 1M in, 128k out. Collapsing them into one "limit" is how you end up sending
    // max_tokens: 1_000_000 and getting a 400.
    expect(maxOutputTokens('claude-opus-4-8')).toBe(128_000)
    expect(contextWindow('claude-opus-4-8')).toBe(1_000_000)
  })
})

describe('estimateTokens', () => {
  it('OVER-counts, never under-counts — an under-counting guard stops guarding', () => {
    // The familiar chars/4 rule is OpenAI's and undercounts Claude by 15-20% on
    // prose, worse on code. We use chars/3, so the estimate must come out ABOVE
    // what a chars/4 estimator would produce. If someone "fixes" the divisor back
    // to 4, this test fails and tells them why.
    const text = 'x'.repeat(1200)
    expect(estimateTokens(text)).toBeGreaterThan(text.length / 4)
  })
})

describe('needsTokenPreflight', () => {
  it('is false for a small prompt — most traffic pays for zero extra round trips', () => {
    expect(needsTokenPreflight('claude-opus-4-8', 'hello')).toBe(false)
  })

  it('is true once the free estimate approaches the window', () => {
    // 1M window, chars/3 → ~3M chars is ~1M tokens. 2.9M chars clears the 90% gate.
    expect(needsTokenPreflight('claude-opus-4-8', 'x'.repeat(2_900_000))).toBe(true)
  })

  it('is false for an unknown model — you cannot compare against a window you lack', () => {
    expect(needsTokenPreflight('claude-from-the-future', 'x'.repeat(9_000_000))).toBe(false)
  })

  it('respects the per-model window — the same prompt gates differently', () => {
    // ~700k chars ≈ 233k estimated tokens: way over Haiku's 200k, nowhere near
    // Opus's 1M. A single global context-window constant would get one of these
    // wrong, which is why the table is per-model.
    const text = 'x'.repeat(700_000)
    expect(needsTokenPreflight('claude-haiku-4-5', text)).toBe(true)
    expect(needsTokenPreflight('claude-opus-4-8', text)).toBe(false)
  })
})

/**
 * The drift test. This is what buys us the right to hardcode the table at all:
 * the Models API is the source of truth, and CI tells us when we disagree with it —
 * before production does.
 *
 * Skips cleanly without a key so `bun test` still runs offline and in CI forks.
 */
describe('model limits drift', () => {
  const apiKey = process.env.ANTHROPIC_API_KEY

  it.skipIf(!apiKey)('matches the live Models API', async () => {
    const sdk = new Anthropic({ apiKey })

    for (const model of Object.keys(CONTEXT_WINDOW)) {
      const live = await sdk.models.retrieve(model)

      // Both tables in one pass — one round trip per model carries both numbers, and
      // an output ceiling that drifts is exactly as damaging as an input one: too low
      // strands budget, too high is a 400 on every request.
      expect({
        model,
        window: live.max_input_tokens,
        output: live.max_tokens,
      }).toEqual({
        model,
        window: CONTEXT_WINDOW[model],
        output: MAX_OUTPUT_TOKENS[model],
      })
    }
  })
})
