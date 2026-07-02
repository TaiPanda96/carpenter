import { describe, expect, it, mock } from 'bun:test'
import { createMockContext } from '@/lib/common/test/mocks/mock-context'
import { createItem } from './create-item'

describe('createItem', () => {
  it('validates input then writes inside a transaction', async () => {
    const create = mock(async ({ data }: { data: { title: string; done: boolean } }) => ({
      id: 'item-uuid',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }))

    // Fake prisma: $transaction just runs the callback with a tx exposing item.create.
    const prisma = {
      // biome-ignore lint/suspicious/noExplicitAny: hand-built test double
      $transaction: async (fn: any) => fn({ item: { create } }),
      // biome-ignore lint/suspicious/noExplicitAny: hand-built test double
    } as any

    const ctx = createMockContext({ prisma })

    const item = await createItem(ctx, { title: '  Buy nails  ' })

    expect(item.title).toBe('Buy nails') // trimmed by validation
    expect(item.done).toBe(false) // defaulted
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid input before touching the database', async () => {
    const create = mock(async () => ({}))
    // biome-ignore lint/suspicious/noExplicitAny: hand-built test double
    const prisma = { $transaction: async (fn: any) => fn({ item: { create } }) } as any
    const ctx = createMockContext({ prisma })

    await expect(createItem(ctx, { title: '   ' })).rejects.toThrow('Title is required')
    expect(create).not.toHaveBeenCalled()
  })
})
