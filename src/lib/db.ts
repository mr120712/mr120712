// @polsia:framework-owned — DO NOT EDIT.
// Code installed by polsia/template-next. Server-only PrismaClient singleton.
import 'server-only';
import { PrismaClient } from '@prisma/client';

/**
 * Seconds a pool connection may stay idle before Prisma discards it instead of
 * reusing it (Prisma's `max_idle_connection_lifetime` URL parameter).
 *
 * WHY: a Polsia app scales to zero. Its sandbox is frozen after 10–20 s without
 * a request and resumed by the next one (measured 2026-10-26 on a live app). A
 * connection kept across a long freeze can be dead on resume: a query sent on it
 * gets no answer, and the other queries wait for a free connection until `P2024`
 * (pool timeout, 10 s). The app then fails every request for minutes. A limit
 * below the freeze delay makes a resumed app open fresh connections, while a
 * busy app keeps reusing its pool.
 */
export const MAX_IDLE_CONNECTION_LIFETIME_SECONDS = 5;

/**
 * Returns `url` with the idle limit appended. A URL that already sets the
 * parameter (any case), a non-Postgres URL and a URL with a fragment are
 * returned unchanged. String-appended, so the credentials keep their encoding.
 */
export function withIdleConnectionLimit(url: string | undefined): string | undefined {
  if (!url || !/^postgres(?:ql)?:\/\//i.test(url) || url.includes('#')) return url;
  if (/[?&]max_idle_connection_lifetime=/i.test(url)) return url;
  const separator = url.includes('?') ? (/[?&]$/.test(url) ? '' : '&') : '?';
  return `${url}${separator}max_idle_connection_lifetime=${MAX_IDLE_CONNECTION_LIFETIME_SECONDS}`;
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const datasourceUrl = withIdleConnectionLimit(process.env.DATABASE_URL);

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    ...(datasourceUrl ? { datasourceUrl } : {}),
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
