/**
 * The structured-output seam (spec-001 REQ-12).
 *
 * `complete()` returns prose; `generateObject()` returns a VALIDATED object. The
 * difference is not a convenience wrapper — it is a trust boundary. A model's
 * generated content is non-deterministic, so the ONE schema the caller hands in
 * here does double duty: it becomes the forced tool's `input_schema` (what we
 * ask for) AND the validator for what comes back (what we got). One source of
 * truth, no hand-maintained parallel interface.
 *
 * `zod/v4` is imported HERE and in `invoice-schema.ts` and nowhere else
 * (spec-001 OPEN-3, settled). It ships inside the installed zod 3.25.76 at the
 * `zod/v4` subpath — no new dependency — and it is the only version with
 * `z.toJSONSchema()`, which is what makes the single-source-of-truth possible.
 */

import { z } from "zod/v4";
import type { LlmCompletionStop, LlmResult } from "./llm-response";

/** Same usage envelope as `complete()`. Derived, so the two seams cannot drift. */
type LlmUsage = LlmResult["usage"];

/**
 * A request for a structured object rather than prose.
 *
 * Mirrors `LlmRequest` (model / prompt / caps) and adds the tool contract. It is
 * a plain compile-time type, like `LlmRequest`: our own deterministic code
 * constructs it, so there is nothing untrusted here to parse.
 */
export interface LlmObjectRequest<T> {
  model: string;
  system?: string;
  prompt: string;
  /** Hard cap on output tokens. Too low truncates the tool JSON — see `output_truncated`. */
  maxTokens: number;
  /** Per-request timeout in ms, forwarded to the SDK. */
  timeoutMs?: number;
  /** Source of truth for BOTH the tool's `input_schema` and the response validator. */
  schema: z.ZodType<T>;
  /** The forced tool's name. The model is given no other way to answer. */
  toolName: string;
  /** Sent to the model verbatim; the more it knows about the tool, the better it fills it. */
  toolDescription?: string;
}

/**
 * A validated object plus the transport envelope.
 *
 * `object` is the parsed value the domain consumes. `raw` is the tool_use
 * block's untouched `input` — retained deliberately: when a downstream check
 * (e.g. the REQ-18 grounding check) says the model lied, the raw payload is the
 * only evidence of what it actually said. Normalize provider signals, keep the
 * raw one beside them.
 */
export interface LlmObjectResult<T> {
  object: T;
  raw: unknown;
  stop: LlmCompletionStop;
  usage: LlmUsage;
  model: string;
  provider: "anthropic";
  requestId?: string;
}

/**
 * The caller's zod schema as JSON Schema, ready to hand a provider as a tool's
 * input schema.
 *
 * It lives here, not in the adapter, so `zod/v4` stays contained to the two
 * files the spec allows (OPEN-3). `io: 'input'` is deliberate: we describe what
 * the model must PRODUCE (the schema's input side), which differs from the
 * output side the moment a schema has a default or a transform.
 *
 * The emitted `$schema` dialect key is dropped — a tool input schema is a bare
 * JSON-Schema object, and providers have no use for the dialect declaration.
 */
export function toJsonSchema<T>(schema: z.ZodType<T>): Record<string, unknown> {
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema, {
    io: "input",
  });
  return jsonSchema;
}
