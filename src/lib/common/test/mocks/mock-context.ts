import type { Context } from "@/lib/common/create-context";

/**
 * Test mirror of createContext. Pass in exactly the fakes your unit under
 * test needs; the returned object satisfies `ContextWith<...>` for those
 * keys. Real IO is never touched in a unit test — this is the whole point
 * of routing dependencies through ctx.
 *
 * ```ts
 * const ctx = createMockContext({ prisma: fakePrisma })
 * await createItem(ctx, { title: 'x' })
 * ```
 */
export function createMockContext<T extends Partial<Context>>(
  overrides: T = {} as T,
): Context & T {
  return { ...overrides } as Context & T;
}
