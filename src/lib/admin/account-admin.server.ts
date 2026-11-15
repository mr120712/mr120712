// @polsia:user-owned — «Gestione account» (/admin/account), lato server: l'elenco degli account con
// UID leggibile, modo di accesso (Google, email, telefono), email verificata, ruolo, blocco e fonti
// del Premium attive adesso. Il Premium segue le STESSE regole delle statistiche «Iscritti»
// (PREMIUM_SOURCES di signups.server: dati salvati, nessuna verifica in tempo reale con Stripe,
// PayPal o gli store). Ricerca per nome, email (contiene, senza maiuscole) o UID (anche scritto senza
// trattini). Solo per l'amministratore: la rotta controlla ruolo ed email verificata.
import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';
import { parseAccountUid } from '@/lib/account/uid';
import { ensureAccountUids } from '@/lib/account/uid.server';
import { PREMIUM_SOURCES, type SignupsDb } from '@/lib/admin/signups.server';
import { isPhoneAccountEmail } from '@/lib/business/phone-auth';
import {
  ACCOUNT_PROVIDERS,
  type AccountProvider,
  ADMIN_ACCOUNT_PAGE_SIZE,
  type AdminAccountsResponse,
} from '@/lib/contracts/account-admin';
import { ADMIN_PREMIUM_SOURCES, type AdminPremiumSource } from '@/lib/contracts/admin-signups';
import { prisma } from '@/lib/db';

export type AccountAdminDb = SignupsDb & Pick<PrismaClient, 'user' | 'account' | 'userUid'>;

type UserRow = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: string | null;
  banned: boolean | null;
  banExpires: Date | null;
  phoneNumber: string | null;
  createdAt: Date;
};

/** Come si accede all'account, dai collegamenti di better-auth (tabella account). */
function providersOf(user: UserRow, providerIds: readonly string[]): AccountProvider[] {
  const found = new Set<AccountProvider>();
  const phone = isPhoneAccountEmail(user.email);
  for (const providerId of providerIds) {
    if (providerId === 'google') found.add('google');
    else if (providerId === 'credential') found.add(phone ? 'phone' : 'email');
    else found.add('other');
  }
  if (phone && user.phoneNumber) found.add('phone');
  return ACCOUNT_PROVIDERS.filter((provider) => found.has(provider));
}

function isAdmin(role: string | null): boolean {
  return (role ?? '')
    .split(',')
    .map((part) => part.trim())
    .includes('admin');
}

/** Blocco in corso, come better-auth: attivo e senza scadenza o con scadenza futura. */
function activeBan(user: UserRow, now: Date): boolean {
  return user.banned === true && (user.banExpires === null || user.banExpires > now);
}

/** Le fonti del Premium attive adesso per gli utenti `ids` (stesse regole delle statistiche). */
async function premiumSourcesFor(
  ids: readonly string[],
  db: AccountAdminDb,
  now: Date,
): Promise<Map<string, AdminPremiumSource[]>> {
  const bySource = new Map<string, AdminPremiumSource[]>();
  if (ids.length === 0) return bySource;
  const wanted = new Set(ids);
  const sets = await Promise.all(
    ADMIN_PREMIUM_SOURCES.map((source) => PREMIUM_SOURCES[source].userIds(db, now)),
  );
  ADMIN_PREMIUM_SOURCES.forEach((source, index) => {
    for (const userId of sets[index] ?? []) {
      if (!wanted.has(userId)) continue;
      bySource.set(userId, [...(bySource.get(userId) ?? []), source]);
    }
  });
  return bySource;
}

/** Il filtro della ricerca: UID (se il testo lo è), email o nome che contengono il testo. */
async function searchWhere(text: string, db: AccountAdminDb): Promise<Prisma.UserWhereInput> {
  if (!text) return {};
  const uid = parseAccountUid(text);
  const byUid = uid
    ? await db.userUid.findUnique({ where: { uid }, select: { userId: true } })
    : null;
  return {
    OR: [
      ...(byUid ? [{ id: byUid.userId }] : []),
      { email: { contains: text, mode: 'insensitive' } },
      { name: { contains: text, mode: 'insensitive' } },
    ],
  };
}

/**
 * Una pagina di account (i più recenti prima) per la ricerca `q`; assegna l'UID a chi non l'ha
 * ancora (account nati dopo l'ultimo avvio).
 */
export async function listAdminAccounts(
  input: { q: string; page: number },
  db: AccountAdminDb = prisma,
  now: Date = new Date(),
): Promise<AdminAccountsResponse> {
  const where = await searchWhere(input.q.trim(), db);
  const [total, users] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: input.page * ADMIN_ACCOUNT_PAGE_SIZE,
      take: ADMIN_ACCOUNT_PAGE_SIZE,
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        role: true,
        banned: true,
        banExpires: true,
        phoneNumber: true,
        createdAt: true,
      },
    }),
  ]);
  const ids = users.map((user) => user.id);
  const [uids, links, premium] = await Promise.all([
    ensureAccountUids(ids, db),
    ids.length > 0
      ? db.account.findMany({
          where: { userId: { in: ids } },
          select: { userId: true, providerId: true },
        })
      : Promise.resolve([]),
    premiumSourcesFor(ids, db, now),
  ]);
  const providerIds = new Map<string, string[]>();
  for (const link of links) {
    providerIds.set(link.userId, [...(providerIds.get(link.userId) ?? []), link.providerId]);
  }
  return {
    items: users.map((user) => ({
      id: user.id,
      uid: uids.get(user.id) ?? null,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified === true,
      role: isAdmin(user.role) ? 'admin' : 'user',
      providers: providersOf(user, providerIds.get(user.id) ?? []),
      banned: activeBan(user, now),
      premium: premium.get(user.id) ?? [],
      createdAt: user.createdAt.toISOString(),
    })),
    total,
    page: input.page,
    hasMore: (input.page + 1) * ADMIN_ACCOUNT_PAGE_SIZE < total,
  };
}
