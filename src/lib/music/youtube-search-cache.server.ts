// @polsia:user-owned — cache in memoria (per istanza, 2 minuti) davanti alla cache nel database:
// risparmia letture e unisce le richieste uguali che arrivano insieme alla stessa istanza.
import 'server-only';
import { normalizeYouTubeQuery } from '@/lib/music/youtube-query';

export const YOUTUBE_SEARCH_CACHE_TTL_MS = 2 * 60 * 1000;
export const YOUTUBE_SEARCH_CACHE_MAX_ENTRIES = 100;

type CacheEntry<T> = {
  expiresAt: number;
  value?: Promise<T>;
};

function defaultCacheable(value: unknown) {
  return (value as { outcome?: unknown } | null)?.outcome !== 'unavailable';
}

export function createYouTubeSearchCache<T>(options?: {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
  /** Whether a finished result may be reused (default: anything but an "unavailable" outcome). */
  cacheable?: (value: T) => boolean;
}) {
  const ttlMs = options?.ttlMs ?? YOUTUBE_SEARCH_CACHE_TTL_MS;
  const maxEntries = options?.maxEntries ?? YOUTUBE_SEARCH_CACHE_MAX_ENTRIES;
  const now = options?.now ?? Date.now;
  const cacheable = options?.cacheable ?? defaultCacheable;
  const entries = new Map<string, CacheEntry<T>>();

  // The same canonical form as the database cache key.
  function normalizedKey(query: string) {
    return normalizeYouTubeQuery(query);
  }

  function pruneExpired() {
    const timestamp = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= timestamp) entries.delete(key);
    }
  }

  return {
    async get(query: string, load: () => Promise<T>): Promise<T> {
      const key = normalizedKey(query);
      const existing = entries.get(key);
      if (existing && existing.expiresAt > now() && existing.value) {
        // A load still running is shared; if it ends with a result that may not be reused (it
        // depends on who asked, e.g. their personal share), it is worked out again for this caller.
        return existing.value.then((result) => (cacheable(result) ? result : load()));
      }
      if (existing) entries.delete(key);
      pruneExpired();

      const entry: CacheEntry<T> = { expiresAt: now() + ttlMs };
      const value = load()
        .then((result) => {
          if (!cacheable(result)) {
            if (entries.get(key) === entry) entries.delete(key);
          } else {
            entry.expiresAt = now() + ttlMs;
          }
          return result;
        })
        .catch((error: unknown) => {
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        });
      entry.value = value;
      entries.set(key, entry);

      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }

      return value;
    },
    clear() {
      entries.clear();
    },
    size() {
      pruneExpired();
      return entries.size;
    },
  };
}
