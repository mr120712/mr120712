// @polsia:user-owned — numeri PUBBLICI degli iscritti per la landing: totale degli account non
// bloccati e nuovi negli ultimi 7 giorni (finestra mobile di 7×24 ore), con due `count` di Prisma
// sulla tabella "user" di better-auth. Escono solo questi due numeri e l'istante del conteggio.
//
// Freschezza: un nuovo account compare sulla landing entro circa un minuto. Il valore dato da
// questa istanza ha meno di 20 secondi (PUBLIC_SIGNUPS_TTL_MS), o meno di 24 nel caso descritto
// sotto (richiesta arrivata durante un conteggio); la CDN aggiunge al massimo 40 secondi
// (s-maxage 20 + stale-while-revalidate 20, vedi route.ts). Caso peggiore per un caricamento
// nuovo della pagina: 20 + 40 = 60 s (64 s nel caso limite). Nessun polling, nessuna
// invalidazione all'iscrizione: il numero si aggiorna solo perché le cache scadono presto.
//
// La route è pubblica e la cache della CDN si aggira con una query string qualsiasi: la vera
// protezione è la cache in memoria di questa istanza. Al massimo una coppia di COUNT ogni 20
// secondi per istanza (≤ 3 al minuto, ≤ 2 al minuto se il database sbaglia) e solo se arrivano
// visite: su una tabella "user" di poche migliaia di righe sono pochi millisecondi.
// Le richieste che arrivano mentre un conteggio è in corso ricevono subito il valore appena
// scaduto (meno di 20 + 4 secondi); se il valore è più vecchio (istanza rimasta ferma) aspettano
// quello stesso conteggio (single-flight): mai più di una coppia di query alla volta per
// istanza. Un conteggio che supera 4 secondi conta come fallito, così un database che non
// risponde non tiene appese le richieste dell'istanza. Dopo un errore si riprova solo dopo 30
// secondi, e nel frattempo si risponde con l'ultimo valore se ha meno di un'ora (altrimenti
// errore → 503). Quell'ora vale SOLO a ridosso di un conteggio fallito (la pausa di 30 secondi e
// i 4 del tentativo che la segue) o quando il conteggio stesso fallisce, mai per un errore vecchio
// a database tornato sano: lì vale di nuovo la regola dei 24 secondi.
// Un solo log per conteggio fallito, non uno per richiesta: la route è pubblica.
import 'server-only';
import type { Prisma } from '@prisma/client';
import type { PublicSignups } from '@/lib/contracts/public-signups';
import { prisma } from '@/lib/db';

/**
 * Durata della cache in memoria (per istanza): 20 secondi, così un nuovo account compare sulla
 * landing entro circa un minuto (con la CDN, vedi l'intestazione). Il database riceve al massimo
 * una coppia di COUNT per istanza ogni 20 secondi.
 */
export const PUBLIC_SIGNUPS_TTL_MS = 20_000;
/** Pausa dopo un conteggio fallito: un database in difficoltà non riceve una query a richiesta. */
export const PUBLIC_SIGNUPS_RETRY_MS = 30_000;
/** Età massima dell'ultimo valore riusato quando il database non risponde. */
export const PUBLIC_SIGNUPS_STALE_MAX_MS = 60 * 60_000;
/** Finestra dei "nuovi": 7 giorni di 24 ore, contati all'indietro dall'istante del conteggio. */
export const PUBLIC_SIGNUPS_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Tempo massimo di un conteggio: oltre, vale come errore (pausa di 30 s e ultimo valore). */
export const PUBLIC_SIGNUPS_TIMEOUT_MS = 4_000;
/**
 * Età massima del valore dato SUBITO, a database sano, a chi arriva mentre un conteggio è in
 * corso: il valore appena scaduto (TTL + durata massima del conteggio). Uno più vecchio (istanza
 * rimasta ferma) non si dà: si aspetta lo stesso conteggio, al massimo PUBLIC_SIGNUPS_TIMEOUT_MS.
 */
export const PUBLIC_SIGNUPS_INFLIGHT_MAX_AGE_MS = PUBLIC_SIGNUPS_TTL_MS + PUBLIC_SIGNUPS_TIMEOUT_MS;

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

/** Valore da dare subito a chi arriva mentre un conteggio è in corso (null = aspetta quello). */
function inflightValue(now: number): PublicSignups | null {
  // Il conteggio in corso è il nuovo tentativo subito dopo la pausa di un errore (l'errore ha meno
  // di 30 + 4 secondi): il database è in difficoltà e vale il ripiego di sempre, l'ultimo valore
  // di meno di un'ora, senza far aspettare nessuno. Un errore più vecchio non conta: retryAt si
  // azzera solo al primo successo, ma dopo un periodo senza visite il database può essere tornato.
  if (retryAt > 0 && now - retryAt < PUBLIC_SIGNUPS_TIMEOUT_MS) return recentValue(now);
  // Database sano (o errore vecchio): solo il valore appena scaduto, così la freschezza resta entro
  // ~1 minuto; con uno più vecchio si aspetta lo stesso conteggio (al massimo 4 s), che se fallisce
  // ripiega comunque sull'ultimo valore di meno di un'ora.
  return cache && now - cache.at < PUBLIC_SIGNUPS_INFLIGHT_MAX_AGE_MS ? cache.value : null;
}

/** Numeri pubblici degli iscritti, dalla cache se ha meno di 20 secondi. */
export function getPublicSignups(): Promise<PublicSignups> {
  const now = Date.now();
  if (cache && now - cache.at < PUBLIC_SIGNUPS_TTL_MS) return Promise.resolve(cache.value);
  // Aggiornamento già in corso: col valore appena scaduto si risponde subito (aspetta solo chi lo
  // ha avviato, al massimo PUBLIC_SIGNUPS_TIMEOUT_MS); con un valore più vecchio o a cache vuota
  // si aspetta lo stesso conteggio, che se fallisce ripiega sull'ultimo valore di meno di un'ora.
  if (inflight) {
    const ready = inflightValue(now);
    return ready ? Promise.resolve(ready) : inflight;
  }
  // Pausa dopo un errore: il database non risponde, vale il ripiego sull'ultimo valore (≤ 1 ora).
  if (now < retryAt) {
    const recent = recentValue(now);
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
