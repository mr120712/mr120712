import { PrismaClient } from '@prisma/client';

/**
 * Prisma singleton for the gateway.
 *
 * Node reloads on dev would otherwise open a new SQLite connection per hot
 * reload and the file lock contention gets ugly. In production the file lives
 * at /data/gateway.db (bind-mounted) and only this single process touches it.
 */
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
