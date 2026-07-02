import type { ContextWith } from '@/lib/common/io/context/create-context'

/** Read all items, newest first. Declares its IO surface via ctx. */
export async function listItems(ctx: ContextWith<'prisma'>) {
  return ctx.prisma.item.findMany({ orderBy: { createdAt: 'desc' } })
}
