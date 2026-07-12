import z from "zod";

/**
 * The LLM response schema is a runtime-validated representation of the shape of the response we expect from an LLM provider.
 * It is used to ensure that the data we receive from the provider matches our expectations and to provide type safety in our code.
 */

export const llmUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

/**
 * The LLM completion stop schema is a discriminated union that represents the different reasons why an LLM response may have stopped generating text.
 * Each variant of the union has a `kind` property that indicates the type of stop, and a `providerReason` property that provides additional context about the stop reason.
 */
export const llmCompletionStopSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("complete"),
    providerReason: z.literal("end_turn"),
  }),

  z.object({
    kind: z.literal("max_tokens"),
    providerReason: z.literal("max_tokens"),
  }),

  z.object({
    kind: z.literal("refusal"),
    providerReason: z.literal("refusal"),
  }),

  z.object({
    kind: z.literal("tool_use"),
    providerReason: z.literal("tool_use"),
  }),

  z.object({
    kind: z.literal("other"),
    providerReason: z.string().nullable(),
  }),
]);

export const llmResponseSchema = z.object({
  text: z.string(),
  stop: llmCompletionStopSchema,
  usage: llmUsageSchema,
  model: z.string().min(1),
  provider: z.literal("anthropic"),
  requestId: z.string().min(1).optional(),
});

export type LlmResult = z.infer<typeof llmResponseSchema>;
export type LlmCompletionStop = z.infer<typeof llmCompletionStopSchema>;
