// @polsia:user-owned — numeri aggregati della scheda Iscritti, letti dalla tabella "user" di
// better-auth e dalle tabelle del Premium con un solo giro di query parallele e parametrizzate
// (nessun dato inserito dall'utente, nessuna stringa concatenata). Escono solo conteggi: mai nomi,
// email, telefoni, id o righe per singolo utente.
//
// Le colonne DateTime di Prisma su Postgres sono `timestamp(3)` SENZA fuso e contengono l'ora UTC:
// `"createdAt" AT TIME ZONE 'UTC'` le rende istanti, `AT TIME ZONE 'Europe/Rome'` le porta all'ora
// italiana (ora legale compresa) prima di troncarle al giorno. I limiti delle finestre arrivano
// come istanti ISO e vengono convertiti allo stesso formato, quindi il risultato non dipende dal
// fuso della sessione del database.
//
// La tabella "user" non ha un indice su "createdAt" (schema di better-auth, framework_owned): ogni
// query è una scansione sequenziale, adatta a una pagina admin aperta ogni tanto.
//
// FREE E PRO. "Pro" = Premium attivo adesso secondo le STESSE regole di hasPremiumAccess
// (src/lib/business/premium-access.server.ts), ma solo sui dati salvati: niente chiamate a
// Stripe, PayPal o agli store e nessuna scrittura (hasPremiumAccess può riverificare e aggiornare
// le righe). Ogni fonte usa i filtri, l'ordine e le funzioni di decisione esportati dal modulo che
// concede l'accesso, così una modifica alla regola vale per entrambi:
//   - Solco Pro: solcoProEntitlementWhere + SOLCO_PRO_ENTITLEMENT_ORDER, poi
//     isActiveSolcoProEntitlement sulla registrazione più recente di ogni utente;
//   - premi: activePremiumGrantWhere (qualunque premio in corso);
//   - Stripe: l'ULTIMO abbonamento di ogni utente (LATEST_STRIPE_SUBSCRIPTION_ORDER) giudicato da
//     isSubscriptionActive;
//   - PayPal: l'ULTIMO abbonamento (LATEST_PAYPAL_SUBSCRIPTION_ORDER) giudicato da
//     isPayPalSubscriptionActive;
//   - acquisti in-app: iapAccessWhere, poi iapGrantsAccess su ogni riga (basta una);
//   - illimitato: le concessioni non revocate di PremiumAccessGrant sulle email VERIFICATE degli
//     account (come hasEmailPremiumGrant). Le sue righe non hanno "userId" (sono per email): gli
//     account bloccati si escludono già nella sua query, che non entra in quella degli esclusi.
// Le regole "ultima riga per utente" e la verifica finale in TypeScript (durata esatta di un mese
// di calendario per Solco Pro) non si possono scrivere come un solo COUNT senza ricopiarle in SQL:
// per questo ogni fonte restituisce gli id dei candidati (righe già filtrate dal database) e
// l'unione distinta si fa qui. Gli id non lasciano mai il server.
//
// Gli utenti da non contare (account cancellato: le righe di pagamento restano senza utente, o
// blocco in corso con la stessa regola di `totals.banned`) arrivano da una query sulle stesse
// tabelle delle fonti, nello stesso giro: niente seconda andata al database.
//
// Free e Pro sono un gruppo a parte dentro lo stesso giro: se una delle loro query non riesce (una
// tabella del Premium lenta o assente in un ambiente) `plans` vale null e i totali e il grafico,
// che leggono solo "user", restano disponibili. Nei log va solo il nome dell'errore.
import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  buildSignupStats,
  type RawPremiumSplit,
  type RawSignupDay,
  type RawSignupTotals,
  type RawUserIdRow,
  romeDayKey,
  signupDayKeys,
  signupWindows,
} from '@/lib/admin/signups';
import { iapAccessWhere, iapGrantsAccess } from '@/lib/business/iap/entitlement.server';
import {
  isPayPalSubscriptionActive,
  LATEST_PAYPAL_SUBSCRIPTION_ORDER,
} from '@/lib/business/paypal-subscriptions.server';
import { isPhoneAccountEmail } from '@/lib/business/phone-auth';
import { activePremiumGrantWhere } from '@/lib/business/rewards.server';
import {
  isActiveSolcoProEntitlement,
  SOLCO_PRO_ENTITLEMENT_ORDER,
  solcoProEntitlementWhere,
} from '@/lib/business/solco-pro-purchase-policy';
import {
  isSubscriptionActive,
  LATEST_STRIPE_SUBSCRIPTION_ORDER,
} from '@/lib/business/stripe-subscriptions.server';
import type { AdminPremiumSource, AdminSignups } from '@/lib/contracts/admin-signups';
import { prisma } from '@/lib/db';

export type SignupsDb = Pick<
  PrismaClient,
  | '$queryRaw'
  | 'solcoProStripeEntitlement'
  | 'premiumGrant'
  | 'solcoSubscription'
  | 'payPalSubscription'
  | 'solcoIapSubscription'
  | 'premiumAccessGrant'
  | 'user'
>;

type PremiumSource = {
  /**
   * Tabella Postgres delle righe della fonte (nome del modello Prisma: nessun @@map), con la colonna
   * "userId": entra nella query degli utenti da escludere. Assente per una fonte che legge già solo
   * account esistenti e non bloccati (illimitato).
   */
  table?: string;
  /** Utenti a cui le righe SALVATE danno Premium adesso, con le regole di hasPremiumAccess. */
  userIds: (db: SignupsDb, now: Date) => Promise<Set<string>>;
};

function userIdsWhere<Row extends { userId: string }>(
  rows: readonly Row[],
  grantsAccess: (row: Row) => boolean,
): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) if (grantsAccess(row)) ids.add(row.userId);
  return ids;
}

/**
 * Una voce per fonte del contratto: una fonte nuova senza voce non compila, e la sua tabella entra
 * da sola nella query degli utenti da escludere.
 */
export const PREMIUM_SOURCES: Readonly<Record<AdminPremiumSource, PremiumSource>> = {
  stripe: {
    table: 'SolcoSubscription',
    async userIds(db, now) {
      // Come getUserSubscription: per ogni utente conta solo l'ultimo abbonamento creato.
      const rows = await db.solcoSubscription.findMany({
        distinct: ['userId'],
        orderBy: [{ userId: 'asc' }, LATEST_STRIPE_SUBSCRIPTION_ORDER],
        select: { userId: true, status: true, currentPeriodEnd: true },
      });
      return userIdsWhere(rows, (row) => isSubscriptionActive(row, now));
    },
  },
  paypal: {
    table: 'PayPalSubscription',
    async userIds(db) {
      // Come getUserPayPalSubscription: per ogni utente conta solo l'ultimo abbonamento creato.
      const rows = await db.payPalSubscription.findMany({
        distinct: ['userId'],
        orderBy: [{ userId: 'asc' }, LATEST_PAYPAL_SUBSCRIPTION_ORDER],
        select: { userId: true, status: true },
      });
      return userIdsWhere(rows, (row) => isPayPalSubscriptionActive(row));
    },
  },
  inApp: {
    table: 'SolcoIapSubscription',
    async userIds(db, now) {
      // Come hasActiveIapSubscription: basta una riga che dia accesso.
      const rows = await db.solcoIapSubscription.findMany({
        where: iapAccessWhere(now),
        select: { userId: true, state: true, validUntil: true },
      });
      return userIdsWhere(rows, (row) => iapGrantsAccess(row, now));
    },
  },
  solcoPro: {
    table: 'SolcoProStripeEntitlement',
    async userIds(db, now) {
      // Come findActiveSolcoProEntitlement: tra le registrazioni del filtro decide la più recente
      // di ogni utente, giudicata (riga intera) da isActiveSolcoProEntitlement.
      const rows = await db.solcoProStripeEntitlement.findMany({
        where: solcoProEntitlementWhere(now),
        distinct: ['userId'],
        orderBy: [{ userId: 'asc' }, SOLCO_PRO_ENTITLEMENT_ORDER],
      });
      return userIdsWhere(rows, (row) => isActiveSolcoProEntitlement(row, row.userId, now));
    },
  },
  rewards: {
    table: 'PremiumGrant',
    async userIds(db, now) {
      // Come getActiveGrant: qualunque premio in corso.
      const rows = await db.premiumGrant.findMany({
        where: activePremiumGrantWhere(now),
        distinct: ['userId'],
        select: { userId: true },
      });
      return new Set(rows.map((row) => row.userId));
    },
  },
  unlimited: {
    async userIds(db, now) {
      // Come hasEmailPremiumGrant: concessione non revocata ed email VERIFICATA dell'account, mai
      // le email segnaposto degli account col telefono. Qui anche senza blocco in corso (stessa
      // regola di `totals.banned`), perché questa fonte non passa dalla query degli esclusi.
      const grants = await db.premiumAccessGrant.findMany({
        where: { revokedAt: null },
        select: { email: true },
      });
      if (grants.length === 0) return new Set<string>();
      const accounts = await db.user.findMany({
        where: {
          email: { in: grants.map((grant) => grant.email) },
          emailVerified: true,
          OR: [{ banned: false }, { banned: null }, { banExpires: { lte: now } }],
        },
        select: { id: true, email: true },
      });
      return new Set(
        accounts
          .filter((account) => !isPhoneAccountEmail(account.email))
          .map((account) => account.id),
      );
    },
  },
};

const SQL_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Nome di tabella da una costante del codice (mai da un input), validato e tra virgolette. */
function tableName(name: string) {
  if (!SQL_IDENTIFIER.test(name)) throw new RangeError('Nome di tabella non valido.');
  return Prisma.raw(`"${name}"`);
}

/**
 * Blocco in corso, come better-auth: `banned` attivo e scadenza assente o futura. Una sola regola
 * per il totale dei bloccati e per gli utenti esclusi da Free e Pro.
 */
function activeBan(nowIso: string) {
  return Prisma.sql`"banned" IS TRUE
    AND ("banExpires" IS NULL OR "banExpires" > (${nowIso}::timestamptz AT TIME ZONE 'UTC'))`;
}

async function premiumSourceUserIds(db: SignupsDb, now: Date) {
  const entries = Object.entries(PREMIUM_SOURCES) as Array<[AdminPremiumSource, PremiumSource]>;
  const sets = await Promise.all(entries.map(([, source]) => source.userIds(db, now)));
  return Object.fromEntries(
    entries.map(([key], index) => [key, sets[index] ?? new Set()]),
  ) as Record<AdminPremiumSource, Set<string>>;
}

/**
 * Dati grezzi di Free e Pro: gli utenti da escludere e gli id di ogni fonte, con le query lanciate
 * tutte insieme (le chiamate partono appena la funzione viene invocata).
 */
async function premiumSplit(db: SignupsDb, now: Date, nowIso: string): Promise<RawPremiumSplit> {
  const sourceUserIds = Prisma.join(
    Object.values(PREMIUM_SOURCES).flatMap(({ table }) =>
      table ? [Prisma.sql`SELECT "userId" FROM ${tableName(table)}`] : [],
    ),
    ' UNION ',
  );
  const [ineligible, sources] = await Promise.all([
    // Utenti presenti nelle tabelle del Premium da NON contare: account che non esiste più
    // oppure blocco in corso. Chiave primaria di "user" per ogni id; esce solo "userId".
    db.$queryRaw<RawUserIdRow[]>`
      SELECT "source"."userId" AS "userId"
      FROM (${sourceUserIds}) AS "source"
      WHERE NOT EXISTS (
        SELECT 1 FROM "user"
        WHERE "user"."id" = "source"."userId"
          AND NOT (${activeBan(nowIso)})
      )
    `,
    premiumSourceUserIds(db, now),
  ]);
  return { sources, ineligible };
}

export async function getSignupStats(
  now: Date = new Date(),
  db: SignupsDb = prisma,
): Promise<AdminSignups> {
  const { nowIso, since24h, since7d, since30d } = signupWindows(now);
  const keys = signupDayKeys(now);
  const firstDay = keys[0] ?? romeDayKey(now);

  // Un solo giro: tutte le query partono insieme, nessuna aspetta il risultato di un'altra. Il
  // gruppo di Free e Pro ha il suo esito: se fallisce restano totali e grafico, con `plans` null.
  const [totals, daily, premium] = await Promise.all([
    db.$queryRaw<RawSignupTotals[]>`
      SELECT
        COUNT(*)::bigint AS "total",
        COUNT(*) FILTER (
          WHERE "createdAt" >= (${since24h}::timestamptz AT TIME ZONE 'UTC')
        )::bigint AS "last24h",
        COUNT(*) FILTER (
          WHERE "createdAt" >= (${since7d}::timestamptz AT TIME ZONE 'UTC')
        )::bigint AS "last7d",
        COUNT(*) FILTER (
          WHERE "createdAt" >= (${since30d}::timestamptz AT TIME ZONE 'UTC')
        )::bigint AS "last30d",
        COUNT(*) FILTER (
          WHERE "emailVerified" IS TRUE OR "phoneNumberVerified" IS TRUE
        )::bigint AS "verified",
        COUNT(*) FILTER (
          WHERE ${activeBan(nowIso)}
        )::bigint AS "banned",
        COUNT(*) FILTER (
          WHERE 'admin' = ANY (string_to_array(replace(COALESCE("role", ''), ' ', ''), ','))
        )::bigint AS "admins"
      FROM "user"
    `,
    db.$queryRaw<RawSignupDay[]>`
      SELECT
        to_char(
          date_trunc('day', ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Rome'),
          'YYYY-MM-DD'
        ) AS "day",
        COUNT(*)::bigint AS "count"
      FROM "user"
      WHERE "createdAt" >= (
        ((${firstDay}::date)::timestamp AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'UTC'
      )
      GROUP BY 1
    `,
    premiumSplit(db, now, nowIso).catch((error: unknown) => {
      // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore (nessun dettaglio).
      console.error(
        '[admin/signups] Free e Pro non disponibili:',
        error instanceof Error ? error.name : typeof error,
      );
      return null;
    }),
  ]);

  return buildSignupStats(now, keys, totals[0], daily, premium);
}
