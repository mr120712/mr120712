// @polsia:user-owned — deploy-time database seed. You OWN this file.
//
// seed() runs once when the server boots (via the framework-owned
// src/instrumentation.ts), on the Node server, AFTER the schema is applied. Use it
// for reference/lookup data your app needs to exist BEFORE the first request:
// plans, categories, feature defaults, a first admin row, etc. Read/write the DB
// through the Prisma singleton in @/lib/db (server startup — there is no request,
// so this does NOT go through /api).
//
// RULES — this runs on EVERY deploy/boot, possibly more than once, possibly on more
// than one instance at the same time:
//   1. Make every write IDEMPOTENT — upsert (`where` + `create` + `update`) or
//      `createMany({ ..., skipDuplicates: true })`, NEVER a bare `create`/`insert`.
//   2. Keep it fast and small — it runs before the server serves traffic.
//   3. NOT for recurring work (that's polsia.toml `[[crons]]`) or per-user/
//      request-time logic (that's an /api route handler). There is no request here.
//
// Preserve all existing roles and grant admin only to the Better Auth record
// matched by the exact requested email.
import { preferPooledDatabaseUrl } from '@/lib/runtime-database-url';

export async function seed(): Promise<void> {
  // Before @/lib/db is first loaded: pooled database connections on Vercel.
  if (preferPooledDatabaseUrl()) console.info('[solco] database: Accelerate connection pool');

  const [{ prisma }, { normalizePersistedAdminRoles, REQUESTED_ADMIN_EMAIL }] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/business/admin-account-policy'),
  ]);

  const requestedAdmin = await prisma.user.findUnique({
    where: { email: REQUESTED_ADMIN_EMAIL },
    select: { id: true },
  });

  await normalizePersistedAdminRoles(
    {
      updateMany: (args) => prisma.user.updateMany(args),
    },
    requestedAdmin?.id,
  );
}
