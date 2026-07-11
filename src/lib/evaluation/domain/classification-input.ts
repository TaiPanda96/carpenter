import { z } from 'zod'

/**
 * Boundary contract for one classifier prediction row. `gold` is the true label,
 * `predicted` is the model's guess. Kept as free `string`s (not an enum) so the
 * label universe is data-driven — see `evaluate-classification.ts`.
 */
export const classificationInputSchema = z.object({
  id: z.string(),
  text: z.string(),
  gold: z.string(),
  predicted: z.string(),
})

export type ClassificationInput = z.infer<typeof classificationInputSchema>
