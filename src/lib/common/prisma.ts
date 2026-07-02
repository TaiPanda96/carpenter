import { PrismaClient } from '@prisma/client'

// Reuse a single client across hot reloads in dev.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

/**
 * Return the process-wide PrismaClient. Kept behind a function so the rest
 * of the app never news-up a client directly — that keeps IO instantiation
 * in one place and makes ctx the only seam.
 */
export function getPrismaClient(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = new PrismaClient()
  }
  return globalForPrisma.prisma
}
