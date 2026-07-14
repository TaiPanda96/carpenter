import { z } from 'zod/v4'

/** Validation schema for item input — the boundary contract. */
export const itemInputSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  done: z.boolean().default(false),
})

export type ItemInput = z.input<typeof itemInputSchema>
export type ValidItemInput = z.output<typeof itemInputSchema>

/**
 * Pure function: validate + normalize raw item input. Throws ZodError on
 * bad input. No IO, no ctx — trivially unit-testable.
 */
export function validateItemInput(input: ItemInput): ValidItemInput {
  return itemInputSchema.parse(input)
}
