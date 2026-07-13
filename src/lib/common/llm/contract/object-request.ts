import { z } from "zod/v4";

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
