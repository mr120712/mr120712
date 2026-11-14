// @polsia:user-owned — numeri PUBBLICI degli iscritti per la landing: totale degli account non
// bloccati e nuovi negli ultimi 7 giorni (finestra mobile di 7×24 ore), con due `count` di Prisma
// sulla tabella "user" di better-auth. Escono solo questi due numeri e l'istante del conteggio.
//
// La route è pubblica e la cache della CDN si aggira con una query string qualsiasi: la vera
// protezione è la cache in memoria di questa istanza (5 minuti). Le richieste che arrivano mentre
// un conteggio è in corso ricevono subito l'ultimo valore se ha meno di un'ora, altrimenti
// aspettano quello stesso conteggio (single-flight): mai più di una coppia di query alla volta per
// istanza. Un conteggio che supera 4 secondi conta come fallito, così un database che non risponde
// non tiene appese tutte le richieste dell'istanza. Dopo un errore si riprova solo dopo 30 secondi,
// e nel frattempo si risponde con l'ultimo valore se ha meno di un'ora (altrimenti errore → 503).
// Un solo log per conteggio fallito, non uno per richiesta: la route è pubblica.
import 'server-only';
import type { Prisma } from '@prisma/client';
import type { PublicSignups } from '@/lib/contracts/public-signups';
import { prisma } from '@/lib/db';

/** Durata della cache in memoria (per istanza). */
export const PUBLIC_SIGNUPS_TTL_MS = 5 * 60_000;
/** Pausa dopo un conteggio fallito: un database in difficoltà non riceve una query a richiesta. */
export const PUBLIC_SIGNUPS_RETRY_MS = 30_000;
/** Età massima dell'ultimo valore riusato quando il database non risponde. */
export const PUBLIC_SIGNUPS_STALE_MAX_MS = 60 * 60_000;
/** Finestra dei "nuovi": 7 giorni di 24 ore, contati all'indietro dall'istante del conteggio. */
export const PUBLIC_SIGNUPS_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Tempo massimo di un conteggio: oltre, vale come errore (pausa di 30 s e ultimo valore). */
export const PUBLIC_SIGNUPS_TIMEOUT_MS = 4_000;

/**
 * Account non bloccato: `banned` FALSE oppure NULL (la colonna è facoltativa). Serve l'OR esplicito:
 * un `banned: { not: true }` di Prisma diventa `"banned" <> true`, che in SQL esclude anche i NULL.
 */
export const NOT_BANNED = {
  OR: [{ banned: false }, { banned: null }],
} satisfies Prisma.UserWhereInput;

/**
 * Nessun valore disponibile: il database non risponde e non c'è un valore recente da riusare.
 * Il guasto è già stato registrato qui (una volta per conteggio): la route non lo registra di nuovo.
 */
export class PublicSignupsUnavailableError extends Error {
  constructor() {
    super('public_signups_unavailable');
    this.name = 'PublicSignupsUnavailableError';
  }
}

/** Il conteggio ha superato PUBLIC_SIGNUPS_TIMEOUT_MS (connessione appesa, database lento). */
class PublicSignupsTimeoutError extends Error {
  constructor() {
    super('public_signups_timeout');
    this.name = 'PublicSignupsTimeoutError';
  }
}

/** Scadenza sul conteggio: le query appese restano tali, ma nessuna richiesta le aspetta più. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PublicSignupsTimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type CacheEntry = { value: PublicSignups; at: number };

let cache: CacheEntry | null = null;
let inflight: Promise<PublicSignups> | null = null;
let retryAt = 0;

async function countPublicSignups(now: number): Promise<PublicSignups> {
  const since = new Date(now - PUBLIC_SIGNUPS_WINDOW_MS);
  const [total, last7Days] = await Promise.all([
    prisma.user.count({ where: NOT_BANNED }),
    prisma.user.count({ where: { ...NOT_BANNED, createdAt: { gte: since } } }),
  ]);
  // Le due query non sono un'unica fotografia: un'iscrizione arrivata tra l'una e l'altra non deve
  // far risultare più nuovi che iscritti in totale.
  return {
    total,
    last7Days: Math.min(last7Days, total),
    updatedAt: new Date(now).toISOString(),
  };
}

function recentValue(now: number): PublicSignups | null {
  return cache && now - cache.at < PUBLIC_SIGNUPS_STALE_MAX_MS ? cache.value : null;
}

/** Numeri pubblici degli iscritti, dalla cache se ha meno di 5 minuti. */
export function getPublicSignups(): Promise<PublicSignups> {
  const now = Date.now();
  if (cache && now - cache.at < PUBLIC_SIGNUPS_TTL_MS) return Promise.resolve(cache.value);
  const recent = recentValue(now);
  // Aggiornamento già in corso: con un valore recente si risponde subito (aspetta solo chi lo ha
  // avviato, al massimo PUBLIC_SIGNUPS_TIMEOUT_MS); a cache vuota si aspetta lo stesso conteggio.
  if (inflight) return recent ? Promise.resolve(recent) : inflight;
  if (now < retryAt) {
    return recent ? Promise.resolve(recent) : Promise.reject(new PublicSignupsUnavailableError());
  }

  inflight = withTimeout(countPublicSignups(now), PUBLIC_SIGNUPS_TIMEOUT_MS)
    .then(
      (value) => {
        cache = { value, at: now };
        retryAt = 0;
        return value;
      },
      (error: unknown) => {
        const failedAt = Date.now();
        retryAt = failedAt + PUBLIC_SIGNUPS_RETRY_MS;
        // Un log per conteggio fallito (non per richiesta), col solo nome dell'errore: niente
        // query, parametri o stringa di connessione.
        // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore (nessun dettaglio).
        console.error(
          '[public/iscritti] conteggio non disponibile:',
          error instanceof Error ? error.name : typeof error,
        );
        const fallback = recentValue(failedAt);
        if (fallback) return fallback;
        throw new PublicSignupsUnavailableError();
      },
    )
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
