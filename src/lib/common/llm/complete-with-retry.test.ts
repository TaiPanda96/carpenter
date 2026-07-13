import { describe, expect, it, mock } from "bun:test";
import { createMockContext } from "@/lib/common/test/mocks/mock-context";
import { LlmError } from "./llm-errors";
import type { LlmClient } from "./llm-client";
import type { LlmResult } from "./llm-response";
import { completeWithRetry } from "./complete-with-retry";

const REQ = { model: "claude-opus-4-8", prompt: "hi", maxTokens: 256 };

/** A successful result with an overridable stop. */
function ok(overrides: Partial<LlmResult> = {}): LlmResult {
  return {
    text: "answer",
    stop: { kind: "complete", providerReason: "end_turn" },
    usage: { inputTokens: 1, outputTokens: 1 },
    model: "claude-opus-4-8",
    provider: "anthropic",
    ...overrides,
  };
}

/** A fake clock — instant, and records that backoff was actually awaited. */
function fakeSleep() {
  const calls: number[] = [];
  const sleep = mock(async (ms: number) => {
    calls.push(ms);
  });
  return { sleep, calls };
}

describe("completeWithRetry", () => {
  it("returns immediately on success — no retry, no sleep", async () => {
    const complete = mock(async () => ok());
    const { sleep, calls } = fakeSleep();
    const ctx = createMockContext({
      llm: { complete } as unknown as LlmClient,
      sleep,
    });

    const res = await completeWithRetry(ctx, REQ);

    expect(res.text).toBe("answer");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]); // never slept
  });

  it("retries a transient (retryable) error, then succeeds", async () => {
    let n = 0;
    const complete = mock(async () => {
      n++;
      if (n === 1) {
        throw new LlmError({
          kind: "provider_unavailable",
          message: "overloaded",
          retryable: true,
        });
      }
      return ok();
    });
    const { sleep, calls } = fakeSleep();
    const ctx = createMockContext({
      llm: { complete } as unknown as LlmClient,
      sleep,
    });

    const res = await completeWithRetry(ctx, REQ, { backoffBaseMs: 10 });

    expect(res.text).toBe("answer");
    expect(complete).toHaveBeenCalledTimes(2); // one failure + one success
    expect(calls).toEqual([10]); // backed off once
  });

  it("does NOT retry a caller error — fails fast", async () => {
    const complete = mock(async () => {
      throw new LlmError({
        kind: "invalid_request",
        message: "bad request",
        retryable: false,
      });
    });
    const { sleep, calls } = fakeSleep();
    const ctx = createMockContext({
      llm: { complete } as unknown as LlmClient,
      sleep,
    });

    await expect(completeWithRetry(ctx, REQ)).rejects.toThrow("bad request");
    expect(complete).toHaveBeenCalledTimes(1); // no retry
    expect(calls).toEqual([]);
  });

  it("gives up after maxRetries and rethrows the last error", async () => {
    const complete = mock(async () => {
      throw new LlmError({
        kind: "rate_limit",
        message: "rate limited",
        retryable: true,
      });
    });
    const { sleep, calls } = fakeSleep();
    const ctx = createMockContext({
      llm: { complete } as unknown as LlmClient,
      sleep,
    });

    await expect(
      completeWithRetry(ctx, REQ, { maxRetries: 2, backoffBaseMs: 10 }),
    ).rejects.toThrow("rate limited");
    expect(complete).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(calls).toEqual([10, 20]); // exponential: 10, then 20
  });

  it("treats a refusal stop as a non-retryable failure", async () => {
    // 200 OK from the API, but the model declined — content must not be used.
    const complete = mock(async () =>
      ok({ stop: { kind: "refusal", providerReason: "refusal" }, text: "" }),
    );
    const { sleep, calls } = fakeSleep();
    const ctx = createMockContext({
      llm: { complete } as unknown as LlmClient,
      sleep,
    });

    await expect(completeWithRetry(ctx, REQ)).rejects.toThrow("refused");
    expect(complete).toHaveBeenCalledTimes(1); // refusal is not retried
    expect(calls).toEqual([]);
  });
});
