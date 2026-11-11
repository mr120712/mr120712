// @polsia:user-owned
import 'server-only';

export const YOUTUBE_SEARCH_CACHE_TTL_MS = 2 * 60 * 1000;
export const YOUTUBE_SEARCH_CACHE_MAX_ENTRIES = 100;

type CacheableResult = { outcome: string };

type CacheEntry<T> = {
  expiresAt: number;
  value?: Promise<T>;
};

export function createYouTubeSearchCache<T extends CacheableResult>(options?: {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}) {
  const ttlMs = options?.ttlMs ?? YOUTUBE_SEARCH_CACHE_TTL_MS;
  const maxEntries = options?.maxEntries ?? YOUTUBE_SEARCH_CACHE_MAX_ENTRIES;
  const now = options?.now ?? Date.now;
  const entries = new Map<string, CacheEntry<T>>();

  function normalizedKey(query: string) {
    return query.normalize('NFKC').trim().toLocaleLowerCase('it-IT');
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
      if (existing && existing.expiresAt > now() && existing.value) return existing.value;
      if (existing) entries.delete(key);
      pruneExpired();

      const entry: CacheEntry<T> = { expiresAt: now() + ttlMs };
      const value = load()
        .then((result) => {
          if (result.outcome === 'unavailable') {
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
