// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import {
  storedYouTubeSearch,
  YOUTUBE_STORE_FRESH_MS,
  youtubeStoreKey,
} from '@/lib/music/youtube-search-store.server';

type Row = { key: string; payload: unknown; createdAt: Date; expiresAt: Date };

function fakeDb(initial?: Row) {
  const rows = new Map<string, Row>(initial ? [[initial.key, initial]] : []);
  return {
    rows,
    youTubeSearchCache: {
      findUnique: vi.fn(
        async ({ where }: { where: { key: string } }) => rows.get(where.key) ?? null,
      ),
      upsert: vi.fn(async ({ where, create }: { where: { key: string }; create: Row }) => {
        rows.set(where.key, create);
        return create;
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
}

const results = { outcome: 'results', videos: [{ videoId: 'abcdefghijk' }] } as never;
const now = new Date('2026-11-11T12:00:00Z');

describe('cache delle ricerche YouTube nel database', () => {
  it('chiama YouTube una volta e poi riusa il risultato per 24 ore', async () => {
    const db = fakeDb();
    const load = vi.fn(async () => results);
    await storedYouTubeSearch('Alfa', 10, load, { now, db: db as never });
    const later = new Date(now.getTime() + YOUTUBE_STORE_FRESH_MS - 1000);
    const again = await storedYouTubeSearch('  alfa ', 10, load, { now: later, db: db as never });
    expect(load).toHaveBeenCalledOnce();
    expect(again).toEqual(results);
    expect(db.rows.has(youtubeStoreKey('alfa', 10))).toBe(true);
  });

  it('con la quota finita usa l’ultimo risultato salvato', async () => {
    const db = fakeDb({
      key: youtubeStoreKey('alfa', 10),
      payload: results,
      createdAt: new Date(now.getTime() - 2 * YOUTUBE_STORE_FRESH_MS),
      expiresAt: new Date(now.getTime() - YOUTUBE_STORE_FRESH_MS),
    });
    const load = vi.fn(async () => ({ outcome: 'unavailable', videos: [] }) as never);
    const result = await storedYouTubeSearch('alfa', 10, load, { now, db: db as never });
    expect(load).toHaveBeenCalledOnce();
    expect(result).toEqual(results);
  });

  it('non salva gli errori di YouTube', async () => {
    const db = fakeDb();
    const unavailable = { outcome: 'unavailable', videos: [] } as never;
    const result = await storedYouTubeSearch('x', 10, async () => unavailable, {
      now,
      db: db as never,
    });
    expect(result).toBe(unavailable);
    expect(db.youTubeSearchCache.upsert).not.toHaveBeenCalled();
  });
});
