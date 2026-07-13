import type { ContextWith } from '@/lib/common/create-context'
import { type ItemInput, validateItemInput } from './validate-item-input'

/**
 * Create an item. Declares its IO surface via `ContextWith<'prisma'>`,
 * validates at the boundary, and writes inside a transaction for atomicity.
 *
 * This is THE reference pattern — mirror its shape for every new mutation:
 *   validate (pure) -> ctx.prisma.$transaction (atomic write).
 */
export async function createItem(ctx: ContextWith<'prisma'>, input: ItemInput) {
  const data = validateItemInput(input)

  return ctx.prisma.$transaction(async (tx) => {
    return tx.item.create({ data })
  })
}
