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

  const [
    { prisma },
    {
      demoteRevokedAdmins,
      formatRequestedAdminStatus,
      normalizePersistedAdminRoles,
      REQUESTED_ADMIN_EMAIL,
      requestedAdminIdToPromote,
    },
    { announceBuildIfNew },
  ] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/business/admin-account-policy'),
    import('@/lib/business/build-announcement.server'),
  ]);

  // Amministratore designato per email (nessuno, se REQUESTED_ADMIN_EMAIL è null): diventa admin
  // solo con l'email VERIFICATA (requestedAdminIdToPromote).
  const requestedAdmin = REQUESTED_ADMIN_EMAIL
    ? await prisma.user.findUnique({
        where: { email: REQUESTED_ADMIN_EMAIL },
        select: { id: true, emailVerified: true },
      })
    : null;

  await normalizePersistedAdminRoles(
    {
      updateMany: (args) => prisma.user.updateMany(args),
    },
    requestedAdminIdToPromote(requestedAdmin),
  );
  if (REQUESTED_ADMIN_EMAIL) {
    // biome-ignore lint/suspicious/noConsole: riga di stato all'avvio, senza email né id.
    console.info(formatRequestedAdminStatus(requestedAdmin));
  }
  // Account a cui il ruolo admin è stato tolto: tornano utenti normali (dopo la promozione sopra).
  await demoteRevokedAdmins({ updateMany: (args) => prisma.user.updateMany(args) });

  // Gestione account: l'UID leggibile a ogni account che non l'ha ancora e il Premium illimitato
  // predefinito (SEEDED_GRANT_EMAILS: vale solo con l'email verificata, es. accesso con Google).
  // Nei log solo lo stato, mai l'email. Best-effort: non deve mai impedire l'avvio del server.
  try {
    const [{ backfillAccountUids }, grants] = await Promise.all([
      import('@/lib/account/uid.server'),
      import('@/lib/business/premium-grants.server'),
    ]);
    await grants.ensureSeededPremiumGrants();
    const created = await backfillAccountUids();
    const status = await grants.seededAccountStatus();
    // biome-ignore lint/suspicious/noConsole: riga di stato all'avvio, senza email né id interni.
    console.info(`${grants.formatSeededStatus(status)}; UID assegnati ora: ${created}`);
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: solo il nome dell'errore, nessun dettaglio.
    console.warn(
      '[solco] gestione account all’avvio non riuscita:',
      error instanceof Error ? error.name : typeof error,
    );
  }
  // Annuncia sul canale Telegram la build appena distribuita (una sola volta, senza dati sensibili).
  // Best-effort: non deve mai impedire l'avvio del server.
  await announceBuildIfNew().catch(() => undefined);
}
