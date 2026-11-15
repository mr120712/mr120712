// @polsia:user-owned — Premium illimitato concesso dall'amministratore a un'email (tabella
// PremiumAccessGrant). Regole:
// - vale SOLO per un account con quell'email VERIFICATA (accesso con Google, o email confermata):
//   chi si registra con email e password usando l'indirizzo di un altro non ottiene nulla finché non
//   la verifica; mai per gli account col numero di telefono (email segnaposto);
// - può essere concesso prima che l'account esista: si attiva al primo accesso con quell'email;
// - nessuna scadenza; una concessione revocata resta salvata (revokedAt) e non torna da sola.
// Le concessioni PREDEFINITE (SEEDED_GRANT_EMAILS: per ora un solo account, su richiesta del
// proprietario) le crea l'avvio del server (src/lib/seed.ts) se mancano; sono slegate dal ruolo di
// amministratore. hasPremiumAccess le legge come ogni altra fonte; le statistiche admin le contano
// come fonte «Illimitato».
import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { ensureAccountUids } from '@/lib/account/uid.server';
import { isPhoneAccountEmail } from '@/lib/business/phone-auth';
import type { PremiumGrant, PremiumGrantStatus } from '@/lib/contracts/account-admin';
import { prisma } from '@/lib/db';

export type GrantDb = Pick<PrismaClient, 'premiumAccessGrant' | 'user' | 'account' | 'userUid'>;

/** L'email come si salva e si confronta: forma NFC, senza spazi ai lati, minuscole. */
export function normalizeGrantEmail(value: string): string {
  return value.normalize('NFC').trim().toLowerCase();
}

/**
 * Email con il Premium illimitato PREDEFINITO, creato all'avvio se manca. Per ora (15/11/2026, su
 * richiesta del proprietario) solo questo account, che accede con Google; non è amministratore.
 */
export const SEEDED_GRANT_EMAILS: readonly string[] = ['francescorogantini9@gmail.com'].map(
  normalizeGrantEmail,
);
/** Nota delle concessioni predefinite. */
export const SEEDED_GRANT_NOTE = 'Premium illimitato concesso dal proprietario';
/** createdBy delle concessioni create all'avvio. */
export const SEEDED_GRANT_CREATOR = 'avvio';

/**
 * true se l'utente ha un Premium illimitato concesso per la sua email VERIFICATA e non revocato.
 * Due letture per chiave (utente, poi concessione). Mai per email non verificate o segnaposto.
 */
export async function hasEmailPremiumGrant(
  userId: string,
  db: Pick<GrantDb, 'premiumAccessGrant' | 'user'> = prisma,
): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  if (!user || user.emailVerified !== true || isPhoneAccountEmail(user.email)) return false;
  const grant = await db.premiumAccessGrant.findUnique({
    where: { email: normalizeGrantEmail(user.email) },
    select: { revokedAt: true },
  });
  return grant !== null && grant.revokedAt === null;
}

/** All'avvio: le concessioni predefinite che mancano (mai riattivate se l'admin le ha revocate). */
export async function ensureSeededPremiumGrants(
  db: Pick<GrantDb, 'premiumAccessGrant'> = prisma,
): Promise<void> {
  if (SEEDED_GRANT_EMAILS.length === 0) return;
  await db.premiumAccessGrant.createMany({
    data: SEEDED_GRANT_EMAILS.map((email) => ({
      email,
      note: SEEDED_GRANT_NOTE,
      createdBy: SEEDED_GRANT_CREATOR,
    })),
    skipDuplicates: true,
  });
}

type GrantRow = {
  id: string;
  email: string;
  note: string | null;
  createdAt: Date;
  revokedAt: Date | null;
};

type GrantAccount = { id: string; name: string; email: string; emailVerified: boolean };

function grantStatus(row: GrantRow, account: GrantAccount | undefined): PremiumGrantStatus {
  if (row.revokedAt) return 'revoked';
  if (!account) return 'pending';
  return account.emailVerified === true ? 'active' : 'unverified';
}

/** Le concessioni come le vede la pagina admin: stato, account collegato (con UID), predefinita. */
async function describeGrants(rows: readonly GrantRow[], db: GrantDb): Promise<PremiumGrant[]> {
  if (rows.length === 0) return [];
  const accounts = await db.user.findMany({
    where: { email: { in: rows.map((row) => row.email) } },
    select: { id: true, name: true, email: true, emailVerified: true },
  });
  const byEmail = new Map(accounts.map((account) => [normalizeGrantEmail(account.email), account]));
  const uids = await ensureAccountUids(
    accounts.map((account) => account.id),
    db,
  );
  return rows.map((row) => {
    const account = byEmail.get(row.email);
    return {
      id: row.id,
      email: row.email,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      status: grantStatus(row, account),
      account: account ? { uid: uids.get(account.id) ?? null, name: account.name } : null,
      seeded: SEEDED_GRANT_EMAILS.includes(row.email),
    };
  });
}

const GRANT_SELECT = {
  id: true,
  email: true,
  note: true,
  createdAt: true,
  revokedAt: true,
} as const;

/** Tutte le concessioni, dalla più recente (al massimo 1000). */
export async function listPremiumGrants(db: GrantDb = prisma): Promise<PremiumGrant[]> {
  const rows = await db.premiumAccessGrant.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: 1000,
    select: GRANT_SELECT,
  });
  return describeGrants(rows, db);
}

/**
 * Concede il Premium illimitato a `email` (già validata e in minuscole dal contratto), oppure
 * riattiva una concessione revocata. `note` assente lascia la nota com'era; vuota la toglie.
 */
export async function grantPremiumToEmail(
  input: { email: string; note?: string; adminId: string },
  db: GrantDb = prisma,
): Promise<PremiumGrant> {
  const email = normalizeGrantEmail(input.email);
  const note = input.note === undefined ? undefined : input.note.trim() || null;
  const row = await db.premiumAccessGrant.upsert({
    where: { email },
    create: { email, note: note ?? null, createdBy: input.adminId },
    update: { revokedAt: null, ...(note === undefined ? {} : { note }) },
    select: GRANT_SELECT,
  });
  const [described] = await describeGrants([row], db);
  if (!described) throw new Error('grant_not_described');
  return described;
}

/** Revoca la concessione `id`; null se non esiste. Revocarla di nuovo non cambia la data. */
export async function revokePremiumGrant(
  id: string,
  db: GrantDb = prisma,
  now: Date = new Date(),
): Promise<PremiumGrant | null> {
  await db.premiumAccessGrant.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: now },
  });
  const row = await db.premiumAccessGrant.findUnique({ where: { id }, select: GRANT_SELECT });
  if (!row) return null;
  const [described] = await describeGrants([row], db);
  return described ?? null;
}

/**
 * Stato dell'account con il Premium illimitato predefinito (il primo di SEEDED_GRANT_EMAILS) e
 * numero di amministratori, per la riga nei log dell'avvio (MAI l'email).
 */
export type SeededAccountStatus = {
  account: boolean;
  emailVerified: boolean;
  admin: boolean;
  google: boolean;
  premium: 'attivo' | 'revocato' | 'assente';
  uid: string | null;
  /** Account con il ruolo admin (anche in un elenco di ruoli), in tutto il database. */
  admins: number;
};

export async function seededAccountStatus(db: GrantDb = prisma): Promise<SeededAccountStatus> {
  const email = SEEDED_GRANT_EMAILS[0] ?? '';
  const [user, grant, admins] = await Promise.all([
    db.user.findUnique({
      where: { email },
      select: { id: true, emailVerified: true, role: true },
    }),
    db.premiumAccessGrant.findUnique({
      where: { email },
      select: { revokedAt: true },
    }),
    db.user.count({ where: { role: { contains: 'admin' } } }),
  ]);
  const [google, uid] = user
    ? await Promise.all([
        db.account.count({ where: { userId: user.id, providerId: 'google' } }),
        db.userUid.findUnique({ where: { userId: user.id }, select: { uid: true } }),
      ])
    : [0, null];
  const roles = (user?.role ?? '').split(',').map((role) => role.trim());
  return {
    account: Boolean(user),
    emailVerified: user?.emailVerified === true,
    admin: roles.includes('admin'),
    google: google > 0,
    premium: grant ? (grant.revokedAt ? 'revocato' : 'attivo') : 'assente',
    uid: uid?.uid ?? null,
    admins,
  };
}

const yesNo = (value: boolean) => (value ? 'sì' : 'no');

/** La riga dei log: niente email né id interni, solo lo stato (e l'UID leggibile). */
export function formatSeededStatus(status: SeededAccountStatus): string {
  const admins = `amministratori in totale: ${status.admins}`;
  if (!status.account) {
    return `[solco] Premium illimitato predefinito: account non ancora creato (si crea al primo accesso con Google), Premium illimitato ${status.premium}; ${admins}`;
  }
  const premiumActive = status.premium === 'attivo' && status.emailVerified;
  return `${[
    '[solco] Premium illimitato predefinito: account presente',
    `email verificata ${yesNo(status.emailVerified)}`,
    `accesso Google ${yesNo(status.google)}`,
    `amministratore ${yesNo(status.admin)}`,
    `Premium illimitato ${status.premium}${status.premium === 'attivo' ? (premiumActive ? ' (in vigore)' : ' (in attesa della verifica dell’email)') : ''}`,
    `UID ${status.uid ?? 'non ancora assegnato'}`,
  ].join(', ')}; ${admins}`;
}
