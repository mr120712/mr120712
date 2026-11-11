// @polsia:user-owned — cache delle ricerche YouTube nel database, condivisa da tutte le istanze.
// Una ricerca costa 100 unità su 10.000 al giorno: la stessa ricerca si fa una volta ogni 24 h.
// Se la quota è finita, si usa l'ultimo risultato salvato (al massimo 7 giorni).
import 'server-only';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { YouTubeSearchResult } from '@/lib/music/youtube-search.server';

export const YOUTUBE_STORE_FRESH_MS = 24 * 60 * 60 * 1000;
export const YOUTUBE_STORE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export function youtubeStoreKey(query: string, maxResults: number) {
  return `${maxResults}:${query.normalize('NFKC').trim().toLocaleLowerCase('it-IT')}`.slice(0, 200);
}

function readPayload(value: Prisma.JsonValue): YouTubeSearchResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { outcome?: unknown; videos?: unknown };
  if (
    (record.outcome !== 'results' && record.outcome !== 'no_results') ||
    !Array.isArray(record.videos)
  ) {
    return null;
  }
  return value as unknown as YouTubeSearchResult;
}

type Store = Pick<typeof prisma, 'youTubeSearchCache'>;

export async function storedYouTubeSearch(
  query: string,
  maxResults: number,
  load: () => Promise<YouTubeSearchResult>,
  options: { now?: Date; db?: Store } = {},
): Promise<YouTubeSearchResult> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const key = youtubeStoreKey(query, maxResults);
  // The cache only saves quota: if the database is unreachable, search YouTube directly.
  const row = await Promise.resolve()
    .then(() => db.youTubeSearchCache.findUnique({ where: { key } }))
    .catch(() => null);
  const saved = row ? readPayload(row.payload) : null;
  if (row && saved && row.expiresAt > now) return saved;

  const fresh = await load();
  if (fresh.outcome === 'unavailable') {
    // Quota finished or API error: an older saved result is better than nothing.
    if (row && saved && now.getTime() - row.createdAt.getTime() < YOUTUBE_STORE_STALE_MS) {
      return saved;
    }
    return fresh;
  }
  const data = {
    payload: fresh as unknown as Prisma.InputJsonValue,
    createdAt: now,
    expiresAt: new Date(now.getTime() + YOUTUBE_STORE_FRESH_MS),
  };
  await Promise.resolve()
    .then(() =>
      db.youTubeSearchCache.upsert({ where: { key }, create: { key, ...data }, update: data }),
    )
    .catch(() => undefined);
  // Housekeeping now and then: drop entries past the 7-day limit.
  if (Math.random() < 0.05) {
    await db.youTubeSearchCache
      .deleteMany({
        where: { createdAt: { lt: new Date(now.getTime() - YOUTUBE_STORE_STALE_MS) } },
      })
      .catch(() => undefined);
  }
  return fresh;
}
