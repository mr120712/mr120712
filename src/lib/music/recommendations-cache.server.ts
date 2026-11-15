// @polsia:user-owned — dati salvati di «Potrebbe piacerti» che non servono al motore per rispondere:
// durata e pulizia della cache dei consigli personali, cancellazione della cache di un utente (con
// «Cancella cronologia») e classifica aggregata della community, ricalcolata dalla pulizia
// giornaliera. Modulo minimo (solo il database), così la pulizia e la Libreria non caricano il motore.
import 'server-only';
import { prisma } from '@/lib/db';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Righe di cache più vecchie di così vengono cancellate (pulizia giornaliera e a ogni scrittura). */
export const RECOMMENDATION_CACHE_MAX_AGE_MS = 2 * DAY_MS;
/** Community: brani Audius ascoltati da almeno 3 persone negli ultimi 30 giorni (solo conteggi). */
export const COMMUNITY_MIN_LISTENERS = 3;
const COMMUNITY_WINDOW_DAYS = 30;
/** Brani della community salvati a ogni ricalcolo (il motore ne riverifica su Audius i primi 8). */
export const COMMUNITY_STORE_LIMIT = 40;

/** Cancella le cache dei consigli più vecchie di 2 giorni. Mai throw. */
export async function purgeStaleRecommendations(now = new Date()) {
  try {
    return await prisma.recommendationCache.deleteMany({
      where: { generatedAt: { lt: new Date(now.getTime() - RECOMMENDATION_CACHE_MAX_AGE_MS) } },
    });
  } catch {
    return { count: 0 };
  }
}

/**
 * Cancella i consigli preparati per un utente (es. dopo «Cancella cronologia»): i motivi non
 * nominano più gli artisti appena cancellati e la prossima richiesta li rifà dai dati rimasti.
 * Mai throw: la cronologia è già cancellata e la cache scade comunque.
 */
export async function clearRecommendationCache(userId: string) {
  try {
    return await prisma.recommendationCache.deleteMany({ where: { userId } });
  } catch {
    // biome-ignore lint/suspicious/noConsole: log del server senza dati (né utente né errore).
    console.warn('[solco] recommendations: cache non cancellata dopo la cronologia');
    return { count: 0 };
  }
}

/**
 * Ricalcola i brani Audius più ascoltati su Solco: SOLO un conteggio aggregato per brano (persone
 * distinte, almeno 3, ultimi 30 giorni), mai chi li ha ascoltati. La lettura di tutta la
 * cronologia (senza indice utile) avviene qui, una volta al giorno nella pulizia, e mai durante una
 * richiesta: il motore legge solo questa tabella piccola. Mai throw (si riprova il giorno dopo).
 */
export async function refreshRecommendationCommunity(now = new Date()) {
  try {
    const since = new Date(now.getTime() - COMMUNITY_WINDOW_DAYS * DAY_MS);
    const rows = await prisma.$queryRaw<{ qualifiedId: string; listeners: number | bigint }[]>`
      SELECT "qualifiedId", COUNT(DISTINCT "userId")::int AS listeners
      FROM "UserPlaybackHistory"
      WHERE "qualifiedId" LIKE 'audius:%' AND "lastPlayedAt" >= ${since}
      GROUP BY "qualifiedId"
      HAVING COUNT(DISTINCT "userId") >= ${COMMUNITY_MIN_LISTENERS}
      ORDER BY listeners DESC, "qualifiedId" ASC
      LIMIT ${COMMUNITY_STORE_LIMIT}`;
    const data = rows.flatMap((row) =>
      /^audius:[A-Za-z0-9_-]{1,128}$/.test(row.qualifiedId)
        ? [{ qualifiedId: row.qualifiedId, listeners: Number(row.listeners), computedAt: now }]
        : [],
    );
    await prisma.$transaction([
      prisma.recommendationCommunity.deleteMany({}),
      prisma.recommendationCommunity.createMany({ data }),
    ]);
    return { count: data.length };
  } catch {
    // biome-ignore lint/suspicious/noConsole: log del server senza dati (né utenti né errore).
    console.warn('[solco] recommendations: classifica della community non ricalcolata');
    return { count: 0 };
  }
}
