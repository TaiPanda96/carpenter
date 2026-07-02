import { type Config, config } from '@/lib/common/config/config'
import { getPrismaClient } from '@/lib/common/prisma'
import type { PrismaClient } from '@prisma/client'

/**
 * The dependency registry. Every IO client / external dependency lives here,
 * and every field is OPTIONAL — a given call site only hydrates what it needs.
 * Add new dependencies (redis, an API client, a repo) as new optional fields.
 */
export interface Context {
  prisma?: PrismaClient
  config?: Config
  fetch?: typeof fetch
}

/**
 * A Context guaranteed to have the given keys present (non-optional).
 *
 * This is the load-bearing trick: a function declares the exact slice it
 * needs in its signature, e.g. `ctx: ContextWith<'prisma'>`, so its IO
 * surface is visible at the type level and nothing else is assumed.
 */
export type ContextWith<K extends keyof Context> = Pick<Required<Context>, K>

/**
 * Build a Context, lazily hydrating ONLY the requested keys. `overrides`
 * take precedence over the defaults — that is the dependency-injection seam.
 *
 * ```ts
 * const ctx = await createContext(['prisma'])
 * const ctx = await createContext(['prisma', 'fetch'], { fetch: myFakeFetch })
 * ```
 */
export async function createContext<K extends readonly (keyof Context)[]>(
  withKeys: K,
  overrides: Partial<Context> = {},
): Promise<ContextWith<K[number]>> {
  const ctx: Context = {}

  for (const key of withKeys) {
    if (key === 'prisma') ctx.prisma = overrides.prisma ?? getPrismaClient()
    if (key === 'config') ctx.config = overrides.config ?? config
    if (key === 'fetch') ctx.fetch = overrides.fetch ?? fetch
  }

  return ctx as ContextWith<K[number]>
}
