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
import { describeDatabaseUrls, preferPooledDatabaseUrl } from '@/lib/runtime-database-url';
import { hardenGlobalPrototypes } from '@/lib/security/prototype-guard';

export async function seed(): Promise<void> {
  // Difesa-in-profondità contro il prototype pollution: congela i prototype nativi all'avvio del
  // server, prima di servire richieste. Da qui in poi scrivere su Object.prototype (es. tramite un
  // __proto__ malevolo) fallisce. È idempotente; se qualcosa non fosse congelabile, non blocca il boot.
  hardenGlobalPrototypes();

  // Before @/lib/db is first loaded: pooled database connections on Vercel.
  const pooled = preferPooledDatabaseUrl();
  console.info(`[solco] database pooled=${pooled} ${describeDatabaseUrls()}`);

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
