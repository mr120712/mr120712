// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import type { YouTubeVideoSearchResult } from '@/lib/contracts/music';
import {
  storedYouTubeSearchWithTime,
  YOUTUBE_SEARCH_FETCH_SIZE,
  YOUTUBE_STORE_FRESH_MS,
  YOUTUBE_STORE_MAX_AGE_MS,
  YOUTUBE_STORE_RECHECK_BACKOFF_MS,
  YOUTUBE_STORE_REFRESH_LEASE_MS,
  YOUTUBE_STORE_REUSE_MS,
  YOUTUBE_STORE_STALE_MS,
  YOUTUBE_STORE_UNVERIFIED_MS,
  type YouTubeRecheck,
  type YouTubeSearchReuse,
  youtubeStoreKey,
} from '@/lib/music/youtube-search-store.server';
import { createYouTubeDbFake, type YouTubeDbFake } from './support/youtube-db-fake';

const NOW = new Date('2026-11-11T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function video(index: number, title = `Brano ${index}`): YouTubeVideoSearchResult {
  return {
    provider: 'youtube',
    videoId: `video${String(index).padStart(6, '0')}`,
    title,
    channelTitle: 'Canale',
    channelId: null,
    description: null,
    publishedAt: null,
    thumbnailUrl: null,
  };
}

const videos = (count: number) => Array.from({ length: count }, (_, index) => video(index));
const results = (count: number) => ({ outcome: 'results' as const, videos: videos(count) });
const out = (reason: 'budget_exhausted' | 'personal_limit' | 'quota_exceeded' | 'api_error') => ({
  outcome: 'unavailable' as const,
  videos: [],
  unavailableReason: reason,
});

let db: YouTubeDbFake;
beforeEach(() => {
  db = createYouTubeDbFake();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function search(
  query: string,
  maxResults: number,
  load: Parameters<typeof storedYouTubeSearchWithTime>[2],
  options: { now?: Date; recheck?: YouTubeRecheck | null; reuse?: YouTubeSearchReuse } = {},
) {
  return storedYouTubeSearchWithTime(query, maxResults, load, {
    now: options.now ?? NOW,
    db: db as never,
    recheck: options.recheck ?? null,
    ...(options.reuse ? { reuse: options.reuse } : {}),
  });
}

/** Tasks scheduled "after the response", run when the test decides. */
function background() {
  const tasks: Array<() => Promise<void>> = [];
  return {
    schedule: (task: () => Promise<void>) => {
      tasks.push(task);
    },
    tasks,
    async runAll() {
      for (const task of tasks.splice(0)) await task();
    },
  };
}

function saveRow(key: string, payload: unknown, ageMs: number) {
  const createdAt = new Date(NOW.getTime() - ageMs);
  db.searches.set(key, {
    key,
    payload,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + YOUTUBE_STORE_FRESH_MS),
  });
}

describe('cache delle ricerche YouTube nel database', () => {
  it('scritture diverse della stessa ricerca usano un solo risultato salvato', async () => {
    const load = vi.fn(async () => results(25));
    await search('Perché  L’amore!', 10, load);
    const again = await search("perche l'amore", 10, load);
    expect(load).toHaveBeenCalledOnce();
    // YouTube receives what the listener typed (spaces collapsed) and always 25 results; the
    // result is saved under the canonical key.
    expect(load).toHaveBeenCalledWith('Perché L’amore!', YOUTUBE_SEARCH_FETCH_SIZE);
    expect(again).toMatchObject({ stale: false, result: { outcome: 'results' } });
    expect(again.result.videos).toHaveLength(10);
    expect(db.searches.has(youtubeStoreKey('PERCHÈ l’amore'))).toBe(true);
  });

  it('una ricerca da 25 risultati serve anche chi ne chiede 10, e viceversa no', async () => {
    const load = vi.fn(async () => results(25));
    await search('techno', 25, load);
    const smaller = await search('Techno', 10, load);
    expect(load).toHaveBeenCalledOnce();
    expect(smaller.result.videos).toHaveLength(10);

    // An old 10-result row (previous key format) serves 10 but not 25.
    saveRow('10:house', results(10), 60_000);
    const ten = await search('house', 10, load);
    expect(ten.result.videos).toHaveLength(10);
    expect(load).toHaveBeenCalledOnce();
    await search('house', 25, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('riusa il risultato per 24 ore senza allungarne la vita', async () => {
    const load = vi.fn(async () => results(25));
    await search('alfa', 10, load);
    const later = new Date(NOW.getTime() + YOUTUBE_STORE_FRESH_MS - 1000);
    const hit = await search('alfa', 10, load, { now: later });
    expect(load).toHaveBeenCalledOnce();
    expect(hit.fetchedAt).toEqual(NOW);
    expect(db.youTubeSearchCache.upsert).toHaveBeenCalledOnce();
    expect(db.youTubeSearchCache.updateMany).not.toHaveBeenCalled();
    // After 24 h YouTube is asked again.
    await search('alfa', 10, load, { now: new Date(NOW.getTime() + YOUTUBE_STORE_FRESH_MS) });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a ricerche finite mostra il risultato salvato, segnato come salvato e con la sua data', async () => {
    saveRow(youtubeStoreKey('alfa'), { ...results(25), size: 25 }, 3 * DAY_MS);
    const stored = await search('alfa', 10, async () => out('budget_exhausted'));
    expect(stored).toMatchObject({ stale: true, blockedBy: 'budget_exhausted' });
    expect(stored.fetchedAt).toEqual(new Date(NOW.getTime() - 3 * DAY_MS));
    expect(stored.result.videos).toHaveLength(10);
  });

  it('usa anche i risultati salvati con le chiavi precedenti', async () => {
    saveRow('25:mina', results(25), 2 * DAY_MS);
    const stored = await search('Mina', 10, async () => out('personal_limit'));
    expect(stored).toMatchObject({ stale: true, blockedBy: 'personal_limit' });
  });

  it('non mostra mai dati YouTube più vecchi di 28 giorni', async () => {
    const checkedAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    // Even re-checked two hours ago, a search sent 28 days ago is not shown.
    saveRow(
      youtubeStoreKey('alfa'),
      { ...results(25), checkedAt },
      YOUTUBE_STORE_STALE_MS + 60_000,
    );
    const old = await search('alfa', 10, async () => out('quota_exceeded'));
    expect(old).toMatchObject({ stale: false, result: { outcome: 'unavailable' } });
    expect(old.blockedBy).toBe('quota_exceeded');

    saveRow(
      youtubeStoreKey('beta'),
      { ...results(25), checkedAt },
      YOUTUBE_STORE_STALE_MS - 60_000,
    );
    const recent = await search('beta', 10, async () => out('quota_exceeded'));
    expect(recent.stale).toBe(true);
    expect(YOUTUBE_STORE_STALE_MS).toBeLessThan(29 * DAY_MS);
  });

  it('ricontrolla i video salvati: toglie quelli spariti e aggiorna i titoli, una volta al giorno', async () => {
    saveRow(youtubeStoreKey('alfa'), { ...results(3), size: 25 }, 2 * DAY_MS);
    const recheck = vi.fn(
      async () =>
        new Map([
          [video(0).videoId, video(0, 'Titolo aggiornato')],
          [video(2).videoId, video(2)],
        ]),
    );
    const stored = await search('alfa', 10, async () => out('budget_exhausted'), { recheck });
    expect(recheck).toHaveBeenCalledOnce();
    expect(stored.result.videos.map((item) => item.title)).toEqual([
      'Titolo aggiornato',
      'Brano 2',
    ]);
    const row = db.searches.get(youtubeStoreKey('alfa'));
    // Only the video data changes: the 28 days still count from the original search.
    expect(row?.createdAt).toEqual(new Date(NOW.getTime() - 2 * DAY_MS));
    expect(row?.payload).toMatchObject({ checkedAt: NOW.toISOString() });

    const soon = new Date(NOW.getTime() + 60 * 60 * 1000);
    const again = await search('alfa', 10, async () => out('budget_exhausted'), {
      now: soon,
      recheck,
    });
    expect(recheck).toHaveBeenCalledOnce();
    expect(again.result.videos).toHaveLength(2);
  });

  it('entro 7 giorni mostra i risultati salvati anche se il ricontrollo non è possibile', async () => {
    saveRow(youtubeStoreKey('alfa'), results(3), 2 * DAY_MS);
    const stored = await search('alfa', 10, async () => out('quota_exceeded'), {
      recheck: async () => null,
    });
    expect(stored.stale).toBe(true);
    expect(stored.result.videos).toHaveLength(3);
  });

  it('oltre 7 giorni mostra i risultati salvati solo dopo un ricontrollo riuscito', async () => {
    saveRow(youtubeStoreKey('alfa'), results(3), 10 * DAY_MS);
    const failed = await search('alfa', 10, async () => out('quota_exceeded'), {
      recheck: async () => null,
    });
    // YouTube's quota is out, so the re-check cannot run: old, unverified videos are not shown.
    expect(failed).toMatchObject({ stale: false, result: { outcome: 'unavailable' } });
    expect(failed.blockedBy).toBe('quota_exceeded');

    saveRow(youtubeStoreKey('beta'), results(3), 10 * DAY_MS);
    const checked = await search('beta', 10, async () => out('budget_exhausted'), {
      recheck: async () => new Map([[video(1).videoId, video(1, 'Titolo attuale')]]),
    });
    expect(checked.stale).toBe(true);
    expect(checked.result.videos.map((item) => item.title)).toEqual(['Titolo attuale']);
    // The label keeps the date of the original search.
    expect(checked.fetchedAt).toEqual(new Date(NOW.getTime() - 10 * DAY_MS));

    // A re-check 3 days ago keeps a 10-day-old search showable when a new re-check fails.
    saveRow(
      youtubeStoreKey('gamma'),
      { ...results(3), checkedAt: new Date(NOW.getTime() - 3 * DAY_MS).toISOString() },
      10 * DAY_MS,
    );
    const earlier = await search('gamma', 10, async () => out('quota_exceeded'), {
      recheck: async () => null,
    });
    expect(earlier.stale).toBe(true);
    expect(YOUTUBE_STORE_UNVERIFIED_MS).toBe(7 * DAY_MS);
  });

  it('un ricontrollo fallito non si ripete a ogni richiesta, ma dopo un’ora', async () => {
    saveRow(youtubeStoreKey('alfa'), results(3), 2 * DAY_MS);
    const recheck = vi.fn<YouTubeRecheck>(async () => null);
    await search('alfa', 10, async () => out('api_error'), { recheck });
    expect(recheck).toHaveBeenCalledOnce();
    expect(db.searches.get(youtubeStoreKey('alfa'))?.payload).toMatchObject({
      checkFailedAt: NOW.toISOString(),
    });
    const soon = new Date(NOW.getTime() + 10 * 60 * 1000);
    const again = await search('alfa', 10, async () => out('api_error'), { now: soon, recheck });
    expect(recheck).toHaveBeenCalledOnce();
    expect(again.stale).toBe(true);
    const later = new Date(NOW.getTime() + YOUTUBE_STORE_RECHECK_BACKOFF_MS);
    await search('alfa', 10, async () => out('api_error'), { now: later, recheck });
    expect(recheck).toHaveBeenCalledTimes(2);
  });

  it('il ricontrollo aggiorna titolo e canale ma tiene la descrizione breve salvata', async () => {
    const saved = { ...video(0), description: 'Breve' };
    saveRow(youtubeStoreKey('alfa'), { outcome: 'results', videos: [saved], size: 25 }, 2 * DAY_MS);
    const long = 'x'.repeat(5000);
    const stored = await search('alfa', 10, async () => out('budget_exhausted'), {
      recheck: async () =>
        new Map([
          [
            saved.videoId,
            { ...video(0, 'Nuovo titolo'), channelTitle: 'Nuovo canale', description: long },
          ],
        ]),
    });
    expect(stored.result.videos[0]).toMatchObject({
      title: 'Nuovo titolo',
      channelTitle: 'Nuovo canale',
      description: 'Breve',
    });
    const row = db.searches.get(youtubeStoreKey('alfa'));
    expect(JSON.stringify(row?.payload)).not.toContain(long);
  });

  it('un ricontrollo lento non sovrascrive una ricerca nuova salvata nel frattempo', async () => {
    saveRow(youtubeStoreKey('alfa'), results(3), 3 * DAY_MS);
    const freshVideos = [video(7, 'Risultato nuovo')];
    // While this re-check runs, another instance (a listener with searches left) saves a new
    // search under the same key.
    const recheck = vi.fn<YouTubeRecheck>(async () => {
      db.searches.set(youtubeStoreKey('alfa'), {
        key: youtubeStoreKey('alfa'),
        payload: { outcome: 'results', videos: freshVideos, size: 25 },
        createdAt: NOW,
        expiresAt: new Date(NOW.getTime() + YOUTUBE_STORE_FRESH_MS),
      });
      return new Map([[video(0).videoId, video(0, 'Titolo di tre giorni fa')]]);
    });
    const stored = await search('alfa', 10, async () => out('personal_limit'), { recheck });
    expect(stored.stale).toBe(true);
    const row = db.searches.get(youtubeStoreKey('alfa'));
    expect(row?.createdAt).toEqual(NOW);
    expect(row?.payload).toMatchObject({ videos: freshVideos });
    expect(row?.payload).not.toHaveProperty('checkedAt');
    // The next request gets the new search as current, never the old videos.
    const next = await search('alfa', 10, async () => out('personal_limit'));
    expect(next).toMatchObject({ stale: false, result: { videos: freshVideos } });
  });

  it('se nessun video salvato è ancora disponibile non mostra nulla di salvato', async () => {
    saveRow(youtubeStoreKey('alfa'), results(3), 2 * DAY_MS);
    const stored = await search('alfa', 10, async () => out('quota_exceeded'), {
      recheck: async () => new Map(),
    });
    expect(stored).toMatchObject({ stale: false, result: { outcome: 'unavailable' } });
  });

  it('non salva gli errori di YouTube', async () => {
    const stored = await search('x', 10, async () => out('api_error'));
    expect(stored.result.outcome).toBe('unavailable');
    expect(db.youTubeSearchCache.upsert).not.toHaveBeenCalled();
  });

  it('con il database irraggiungibile lascia decidere al budget (che non cerca)', async () => {
    db.youTubeSearchCache.findMany.mockRejectedValueOnce(new Error('db down'));
    const load = vi.fn(async () => out('api_error'));
    const stored = await search('alfa', 10, load);
    expect(load).toHaveBeenCalledOnce();
    expect(stored.result.outcome).toBe('unavailable');
  });

  it('una query vuota dopo la normalizzazione non chiama YouTube', async () => {
    const load = vi.fn();
    const stored = await search(' 🎵 !! ', 10, load);
    expect(stored.result).toEqual({ outcome: 'no_results', videos: [] });
    expect(load).not.toHaveBeenCalled();
  });

  it('la pulizia occasionale cancella le ricerche oltre i 28 giorni', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    saveRow(youtubeStoreKey('vecchia'), results(1), YOUTUBE_STORE_MAX_AGE_MS + 60_000);
    saveRow(youtubeStoreKey('recente'), results(1), YOUTUBE_STORE_MAX_AGE_MS - 60_000);
    await search('nuova', 10, async () => results(1));
    expect(db.searches.has(youtubeStoreKey('vecchia'))).toBe(false);
    expect(db.searches.has(youtubeStoreKey('recente'))).toBe(true);
  });
});

describe('riuso delle ricerche salvate da 1 a 7 giorni (opzione reuse)', () => {
  const savedAlfa = (count = 25, ageMs = 2 * DAY_MS) =>
    saveRow(youtubeStoreKey('alfa'), { ...results(count), size: 25 }, ageMs);
  const newVideos = Array.from({ length: 25 }, (_, index) => video(100 + index));

  it('risponde subito come attuale, senza aspettare YouTube; la ricerca nuova parte dopo', async () => {
    savedAlfa();
    const load = vi.fn(async () => results(25));
    const refresh = vi.fn(async () => ({ outcome: 'results' as const, videos: newVideos }));
    const after = background();
    const reuse = { refresh, schedule: after.schedule };

    const stored = await search('Alfa', 10, load, { reuse });
    expect(stored).toMatchObject({ stale: false, reused: true, result: { outcome: 'results' } });
    expect(stored.result.videos).toHaveLength(10);
    // The 28 days still count from when YouTube sent the saved search.
    expect(stored.fetchedAt).toEqual(new Date(NOW.getTime() - 2 * DAY_MS));
    expect(load).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(after.tasks).toHaveLength(1);

    await after.runAll();
    expect(refresh).toHaveBeenCalledWith('Alfa', YOUTUBE_SEARCH_FETCH_SIZE);
    // The new search replaces the saved one and is current for the next 24 h.
    const next = await search('alfa', 10, load, { reuse });
    expect(next).toMatchObject({ stale: false, result: { outcome: 'results' } });
    expect(next.reused).toBeUndefined();
    expect(next.fetchedAt).toEqual(NOW);
    expect(next.result.videos[0]?.videoId).toBe(video(100).videoId);
    expect(after.tasks).toHaveLength(0);
    expect(load).not.toHaveBeenCalled();
  });

  it('il rinnovo si prova una volta per riga ogni 6 ore, anche da più istanze', async () => {
    savedAlfa();
    const load = vi.fn(async () => results(25));
    // No quota to spare: the budget refuses the refresh.
    const refresh = vi.fn(async () => out('budget_exhausted'));
    const after = background();
    const reuse = { refresh, schedule: after.schedule };
    // Two instances answer the same search at the same moment.
    await search('alfa', 10, load, { reuse });
    await search('alfa', 10, load, { reuse });
    await after.runAll();
    expect(refresh).toHaveBeenCalledOnce();

    const later = new Date(NOW.getTime() + YOUTUBE_STORE_REFRESH_LEASE_MS - 60_000);
    const stillSaved = await search('alfa', 10, load, { reuse, now: later });
    expect(stillSaved).toMatchObject({ stale: false, reused: true });
    await after.runAll();
    expect(refresh).toHaveBeenCalledOnce();

    await search('alfa', 10, load, {
      reuse,
      now: new Date(NOW.getTime() + YOUTUBE_STORE_REFRESH_LEASE_MS),
    });
    await after.runAll();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(load).not.toHaveBeenCalled();
  });

  it('oltre 7 giorni non riusa: cerca subito, come prima', async () => {
    savedAlfa(25, YOUTUBE_STORE_REUSE_MS + 60_000);
    const load = vi.fn(async () => results(25));
    const after = background();
    const stored = await search('alfa', 10, load, {
      reuse: { refresh: vi.fn(async () => results(25)), schedule: after.schedule },
    });
    expect(load).toHaveBeenCalledOnce();
    expect(stored.reused).toBeUndefined();
    expect(stored.fetchedAt).toEqual(NOW);
    expect(after.tasks).toHaveLength(0);
  });

  it('i video riusati si ricontrollano una volta al giorno: quelli spariti non si mostrano', async () => {
    savedAlfa(3);
    const recheck = vi.fn(async () => new Map([[video(1).videoId, video(1, 'Titolo nuovo')]]));
    const load = vi.fn(async () => results(25));
    const after = background();
    const reuse = { refresh: null, schedule: after.schedule };

    const stored = await search('alfa', 10, load, { recheck, reuse });
    expect(recheck).toHaveBeenCalledOnce();
    expect(stored.result.videos.map((item) => item.title)).toEqual(['Titolo nuovo']);
    const hourLater = new Date(NOW.getTime() + 60 * 60 * 1000);
    const again = await search('alfa', 10, load, { recheck, reuse, now: hourLater });
    expect(recheck).toHaveBeenCalledOnce();
    expect(again.result.videos).toHaveLength(1);
    expect(load).not.toHaveBeenCalled();
    // `refresh: null`: reuse only, nothing scheduled.
    expect(after.tasks).toHaveLength(0);
  });

  it('se nessun video riusato è ancora disponibile decide una ricerca nuova', async () => {
    savedAlfa(3);
    const recheck = vi.fn(async () => new Map<string, YouTubeVideoSearchResult>());
    const load = vi.fn(async () => results(25));
    const after = background();
    const stored = await search('alfa', 10, load, {
      recheck,
      reuse: { refresh: vi.fn(async () => results(25)), schedule: after.schedule },
    });
    expect(recheck).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
    expect(stored).toMatchObject({ stale: false, result: { outcome: 'results' } });
    expect(stored.reused).toBeUndefined();
    expect(after.tasks).toHaveLength(0);
  });

  it('una ricerca salvata senza risultati si riusa come tale e si rinnova', async () => {
    saveRow(youtubeStoreKey('zzz'), { outcome: 'no_results', videos: [], size: 25 }, 3 * DAY_MS);
    const load = vi.fn(async () => results(25));
    const refresh = vi.fn(async () => results(25));
    const after = background();
    const stored = await search('zzz', 10, load, {
      reuse: { refresh, schedule: after.schedule },
    });
    expect(stored).toMatchObject({ reused: true, result: { outcome: 'no_results', videos: [] } });
    expect(load).not.toHaveBeenCalled();
    await after.runAll();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('un risultato salvato con meno video di quelli chiesti non si riusa', async () => {
    saveRow('10:beta', results(10), 2 * DAY_MS);
    const load = vi.fn(async () => results(25));
    const stored = await search('beta', 25, load, { reuse: { refresh: null } });
    expect(load).toHaveBeenCalledOnce();
    expect(stored.reused).toBeUndefined();
  });

  it('fuori da una richiesta (script) il rinnovo parte subito, senza far aspettare', async () => {
    savedAlfa();
    const refresh = vi.fn(async () => results(25));
    const stored = await search(
      'alfa',
      10,
      vi.fn(async () => results(25)),
      {
        reuse: { refresh },
      },
    );
    expect(stored.reused).toBe(true);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });
});
