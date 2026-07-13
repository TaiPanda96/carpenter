import { describe, expect, it, mock } from "bun:test";
import { createMockContext } from "@/lib/common/test/mocks/mock-context";
import { generateObjectWithRetry } from "./generate-object-with-retry";
import type { LlmClient } from "./llm-client";
import { LlmError } from "./llm-errors";
import type { LlmObjectRequest, LlmObjectResult } from "./llm-object";

interface Extracted {
  total: string;
}

/**
 * The retry loop never touches the schema — it hands the request to `ctx.llm`
 * and reacts to the error kind. So the fake needs a schema-SHAPED value, not a
 * real zod schema, which also keeps `zod/v4` contained to the two files the spec
 * allows (spec-001 OPEN-3).
 */
const SCHEMA = {} as LlmObjectRequest<Extracted>["schema"];

const REQ: LlmObjectRequest<Extracted> = {
  model: "claude-opus-4-8",
  prompt: "extract",
  maxTokens: 1000,
  schema: SCHEMA,
  toolName: "extract_invoice",
};

function ok(): LlmObjectResult<Extracted> {
  return {
    object: { total: "1.180,00" },
    raw: { total: "1.180,00" },
    stop: { kind: "tool_use", providerReason: "tool_use" },
    usage: { inputTokens: 1, outputTokens: 1 },
    model: "claude-opus-4-8",
    provider: "anthropic",
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

/** A fake model that records every request it was handed, in order. */
function fakeLlm(
  impl: (req: LlmObjectRequest<Extracted>, call: number) => Promise<unknown>,
) {
  const requests: LlmObjectRequest<Extracted>[] = [];
  const generateObject = mock(async (req: LlmObjectRequest<Extracted>) => {
    requests.push(req);
    return impl(req, requests.length);
  });
  return {
    requests,
    generateObject,
    llm: { generateObject } as unknown as LlmClient,
  };
}

describe("generateObjectWithRetry", () => {
  it("returns the validated object on the first try — no retry, no sleep", async () => {
    const { llm, generateObject } = fakeLlm(async () => ok());
    const { sleep, calls } = fakeSleep();
    const ctx = createMockContext({ llm, sleep });

    const res = await generateObjectWithRetry(ctx, REQ);

    expect(res.object).toEqual({ total: "1.180,00" });
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]); // never slept
  });

  it("retries a transient (retryable) error, then succeeds", async () => {
    const { llm, generateObject } = fakeLlm(async (_req, call) => {
      if (call === 1) {
        throw new LlmError({
          kind: "tool_use_missing",
          message: "model ignored the forced tool",
          retryable: true,
        });
      }
      return ok();
    });
    const { sleep, calls } = fakeSleep();
    const ctx = createMockContext({ llm, sleep });

    const res = await generateObjectWithRetry(ctx, REQ, { backoffBaseMs: 10 });

    expect(res.object).toEqual({ total: "1.180,00" });
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([10]); // backed off once
  });

  it("does NOT retry a schema-validation failure — the shape is wrong, not late", async () => {
    const { llm, generateObject } = fakeLlm(async () => {
      throw new LlmError({
        kind: "output_validation",
        message: "Model output failed schema validation",
        retryable: false,
        issues: [{ path: "lineItems.0.amountRaw", message: "Required" }],
      });
    });
    const { sleep, calls } = fakeSleep();
    const ctx = createMockContext({ llm, sleep });

    await expect(generateObjectWithRetry(ctx, REQ)).rejects.toThrow(
      "failed schema validation",
    );
    expect(generateObject).toHaveBeenCalledTimes(1); // no retry
    expect(calls).toEqual([]);
  });

  it("DOUBLES maxTokens after a truncation — an identical retry would truncate identically", async () => {
    const { llm, requests, generateObject } = fakeLlm(async (_req, call) => {
      if (call === 1) {
        throw new LlmError({
          kind: "output_truncated",
          message: "Tool output was truncated at max_tokens (1000)",
          retryable: true,
        });
      }
      return ok();
    });
    const { sleep, calls } = fakeSleep();
    const ctx = createMockContext({ llm, sleep });

    const res = await generateObjectWithRetry(ctx, REQ, { backoffBaseMs: 10 });

    expect(res.object).toEqual({ total: "1.180,00" });
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(requests.map((r) => r.maxTokens)).toEqual([1000, 2000]);
    expect(REQ.maxTokens).toBe(1000); // the caller's request is never mutated
    expect(calls).toEqual([10]);
  });

  it("gives up after maxRetries and rethrows the last error", async () => {
    const { llm, requests, generateObject } = fakeLlm(async () => {
      throw new LlmError({
        kind: "provider_unavailable",
        message: "overloaded",
        retryable: true,
      });
    });
    const { sleep, calls } = fakeSleep();
    const ctx = createMockContext({ llm, sleep });

    await expect(
      generateObjectWithRetry(ctx, REQ, { maxRetries: 2, backoffBaseMs: 10 }),
    ).rejects.toThrow("overloaded");
    expect(generateObject).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(calls).toEqual([10, 20]); // exponential: 10, then 20
    expect(requests.map((r) => r.maxTokens)).toEqual([1000, 1000, 1000]); // only truncation grows the budget
  });

  it("obeys the provider's retry-after over its own exponential backoff", async () => {
    const { llm } = fakeLlm(async (_req, call) => {
      if (call === 1) {
        throw new LlmError({
          kind: "rate_limit",
          message: "rate limited",
          retryable: true,
          retryAfterMs: 1500, // from the `retry-after` header
        });
      }
      return ok();
    });
    const { sleep, calls } = fakeSleep();
    const ctx = createMockContext({ llm, sleep });

    await generateObjectWithRetry(ctx, REQ, { backoffBaseMs: 10 });

    expect(calls).toEqual([1500]); // not 10 — the API said how long to wait
  });
});
