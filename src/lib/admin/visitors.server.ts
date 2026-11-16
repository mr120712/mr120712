// @polsia:user-owned — registrazione e aggregazione delle visite (scheda Visitatori), senza dati
// personali: di una pagina aperta si salvano giorno, percorso normalizzato, host di provenienza,
// Paese stimato dall'hosting, tipo di dispositivo e un'IMPRONTA del visitatore. L'impronta è un HMAC
// di indirizzo IP e browser con una chiave che cambia ogni giorno (derivata dal segreto del server e
// dal giorno): conta i visitatori distinti della giornata, non segue nessuno da un giorno all'altro
// e non si può riportare all'indirizzo. L'indirizzo IP non viene mai scritto.
// Le statistiche sono query aggregate e parametrizzate sulla tabella "SiteVisit" (solo conteggi).
import 'server-only';
import { createHmac, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { romeDayKey } from '@/lib/admin/signups';
import {
  buildVisitorStats,
  countryFrom,
  deviceFrom,
  isAutomatedUserAgent,
  normalizeVisitPath,
  type RawVisitorCountry,
  type RawVisitorDay,
  type RawVisitorDevice,
  type RawVisitorPage,
  type RawVisitorReferrer,
  referrerHostFrom,
  visitorDayKeys,
  visitRetentionCutoff,
} from '@/lib/admin/visitors';
import { getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { type AdminVisitors, VISITORS_TOP_LIMIT } from '@/lib/contracts/admin-visitors';
import { prisma } from '@/lib/db';
import { siteUrl } from '@/lib/site';

export type VisitorsDb = Pick<PrismaClient, '$queryRaw' | 'siteVisit'>;

/** Caratteri esadecimali dell'impronta salvata (96 bit: bastano a distinguere i visitatori di un giorno). */
const VISITOR_HASH_LENGTH = 24;

/**
 * Senza il segreto del server (ambiente di prova) la chiave del giorno nasce da un sale casuale del
 * processo: le impronte restano coerenti dentro il processo e cambiano a ogni riavvio.
 */
const processSalt = randomBytes(32);

/** La chiave del giorno: HMAC del segreto del server sul giorno di calendario italiano. */
function dailyKey(day: string): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET?.trim();
  const base = secret ? Buffer.from(secret, 'utf8') : processSalt;
  return createHmac('sha256', base).update(`solco-visits-v1:${day}`).digest();
}

/**
 * L'impronta del visitatore per il giorno dato: stessa persona (stesso IP e browser) → stessa
 * impronta nello stesso giorno, impronta diversa il giorno dopo. `identity` è la stringa dell'IP come
 * la vede il limite di richieste (`ip:…`), o null quando l'hosting non la manda.
 */
export function visitorHashFor(day: string, identity: string | null, userAgent: string | null) {
  return createHmac('sha256', dailyKey(day))
    .update(`${identity ?? ''}\n${userAgent ?? ''}`)
    .digest('hex')
    .slice(0, VISITOR_HASH_LENGTH);
}

/** Gli host del sito stesso: una pagina interna che ne apre un'altra non è una provenienza. */
function ownHosts(headers: Headers): string[] {
  const hosts: string[] = [];
  try {
    hosts.push(new URL(siteUrl).hostname);
  } catch {
    // siteUrl non valido in un ambiente di prova: resta l'host della richiesta.
  }
  const requestHost = headers.get('host')?.split(':')[0]?.trim();
  if (requestHost) hosts.push(requestHost);
  return hosts;
}

export type VisitInput = {
  /** Percorso della pagina come lo manda il beacon (viene normalizzato). */
  path: string;
  /** `document.referrer` della prima pagina; se ne tiene solo l'host. */
  referrer?: string | undefined;
  headers: Headers;
  now?: Date;
};

export type VisitOutcome = 'recorded' | 'ignored';

/**
 * Registra una pagina aperta, oppure la ignora senza scrivere nulla: robot e monitor, browser che
 * chiedono di non essere tracciati (DNT, Global Privacy Control), percorsi non conteggiabili.
 */
export async function recordVisit(
  input: VisitInput,
  db: VisitorsDb = prisma,
): Promise<VisitOutcome> {
  const userAgent = input.headers.get('user-agent');
  if (isAutomatedUserAgent(userAgent)) return 'ignored';
  if (input.headers.get('dnt') === '1' || input.headers.get('sec-gpc') === '1') return 'ignored';
  const path = normalizeVisitPath(input.path);
  if (!path) return 'ignored';
  const now = input.now ?? new Date();
  const day = romeDayKey(now);
  await db.siteVisit.create({
    data: {
      day,
      visitorHash: visitorHashFor(day, getRateLimitIdentity(null, input.headers), userAgent),
      path,
      referrerHost: referrerHostFrom(input.referrer, ownHosts(input.headers)),
      country: countryFrom(input.headers.get('x-vercel-ip-country')),
      device: deviceFrom(userAgent),
      createdAt: now,
    },
    select: { id: true },
  });
  return 'recorded';
}

/** Statistiche aggregate degli ultimi 30 giorni: un solo giro di query parallele, solo conteggi. */
export async function getVisitorStats(
  now: Date = new Date(),
  db: VisitorsDb = prisma,
): Promise<AdminVisitors> {
  const keys = visitorDayKeys(now);
  const firstDay = keys[0] ?? romeDayKey(now);
  const [daily, pages, countries, referrers, devices] = await Promise.all([
    db.$queryRaw<RawVisitorDay[]>`
      SELECT "day",
        COUNT(DISTINCT "visitorHash")::bigint AS "visitors",
        COUNT(*)::bigint AS "views"
      FROM "SiteVisit"
      WHERE "day" >= ${firstDay}
      GROUP BY 1
    `,
    db.$queryRaw<RawVisitorPage[]>`
      SELECT "path",
        COUNT(DISTINCT "visitorHash")::bigint AS "visitors",
        COUNT(*)::bigint AS "views"
      FROM "SiteVisit"
      WHERE "day" >= ${firstDay}
      GROUP BY 1
      ORDER BY 3 DESC, 1 ASC
      LIMIT ${VISITORS_TOP_LIMIT}
    `,
    db.$queryRaw<RawVisitorCountry[]>`
      SELECT "country",
        COUNT(DISTINCT "visitorHash")::bigint AS "visitors"
      FROM "SiteVisit"
      WHERE "day" >= ${firstDay}
      GROUP BY 1
      ORDER BY 2 DESC, 1 ASC
      LIMIT ${VISITORS_TOP_LIMIT}
    `,
    db.$queryRaw<RawVisitorReferrer[]>`
      SELECT "referrerHost" AS "host",
        COUNT(DISTINCT "visitorHash")::bigint AS "visitors"
      FROM "SiteVisit"
      WHERE "day" >= ${firstDay} AND "referrerHost" IS NOT NULL
      GROUP BY 1
      ORDER BY 2 DESC, 1 ASC
      LIMIT ${VISITORS_TOP_LIMIT}
    `,
    db.$queryRaw<RawVisitorDevice[]>`
      SELECT "device",
        COUNT(DISTINCT "visitorHash")::bigint AS "visitors"
      FROM "SiteVisit"
      WHERE "day" >= ${firstDay}
      GROUP BY 1
      ORDER BY 2 DESC, 1 ASC
    `,
  ]);
  return buildVisitorStats(now, keys, { daily, pages, countries, referrers, devices });
}

/** Cancella le righe oltre il periodo di conservazione (90 giorni); idempotente. */
export async function pruneOldVisits(now: Date = new Date(), db: VisitorsDb = prisma) {
  return db.siteVisit.deleteMany({ where: { createdAt: { lt: visitRetentionCutoff(now) } } });
}
