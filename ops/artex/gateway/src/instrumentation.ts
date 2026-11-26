/**
 * Next.js server-side instrumentation hook. Runs once per server boot on the
 * Node runtime, before the first request is served.
 *
 * We only use it to seed the admin user. Edge runtime and build-time calls are
 * no-ops — Prisma is not available there.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Dynamic import so the Prisma client never gets pulled into edge chunks.
  const { seed } = await import('@/lib/seed');
  await seed();
}
