// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  search: vi.fn(async () => ({ outcome: 'results' as const, videos: [] })),
  apiKey: 'key',
  // Tasks scheduled after the response (next/server after()), run when the test decides.
  afterTasks: [] as Array<() => Promise<unknown>>,
}));
vi.mock('server-only', () => ({}));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => {
    mocks.afterTasks.push(task);
  },
}));
vi.mock('@/lib/music/youtube-search.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/music/youtube-search.server')>()),
  searchYouTubeMusic: mocks.search,
}));
vi.mock('@/lib/music/music-api.server', () => ({ readYouTubeApiKey: () => mocks.apiKey }));
// The real budget and search store run on an in-memory database.
vi.mock('@/lib/db', async () => ({
  prisma: (await import('./support/youtube-db-fake')).sharedYouTubeDbFake,
}));

import { GET } from '@/app/api/music/genres/[slug]/route';
import {
  findGenre,
  funPlaylists,
  genreCatalog,
  genreFamilies,
  isPlaylistEntry,
} from '@/lib/music/genre-catalog';
import { isPlaylistCoverId, PLAYLIST_COVER_LABELS } from '@/lib/music/playlist-covers';
import { youtubeQuotaDay, youtubeSearchPurposeCap } from '@/lib/music/youtube-budget.server';
import { youtubeStoreKey } from '@/lib/music/youtube-search-store.server';
import { sharedYouTubeDbFake } from './support/youtube-db-fake';

const db = sharedYouTubeDbFake;

describe('generi e playlist', () => {
  it('ha slug unici e validi in ogni famiglia, underground incluso', () => {
    const slugs = genreCatalog.map((entry) => entry.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9-]+$/);
    for (const family of genreFamilies) {
      expect(genreCatalog.some((entry) => entry.family === family.id)).toBe(true);
    }
    expect(genreCatalog.length).toBeGreaterThanOrEqual(60);
    for (const slug of ['drum-and-bass', 'post-punk', 'phonk', 'dark-techno', 'shoegaze']) {
      expect(findGenre(slug)).not.toBeNull();
    }
  });

  it('le playlist divertenti sono nel server, ognuna con la sua copertina disegnata', () => {
    expect(funPlaylists.length).toBeGreaterThanOrEqual(12);
    expect(genreFamilies[0]).toEqual({ id: 'divertenti', label: 'Playlist divertenti' });
    const covers = funPlaylists.map((entry) => entry.cover);
    // Una copertina diversa per ogni playlist, sempre con la descrizione del disegno.
    expect(new Set(covers).size).toBe(covers.length);
    for (const entry of funPlaylists) {
      expect(entry.family, entry.slug).toBe('divertenti');
      expect(isPlaylistCoverId(entry.cover), entry.slug).toBe(true);
      if (entry.cover) expect(PLAYLIST_COVER_LABELS[entry.cover], entry.slug).toMatch(/\S/);
      expect(entry.description.length, entry.slug).toBeGreaterThan(30);
      expect(entry.description.length, entry.slug).toBeLessThanOrEqual(120);
      expect(entry.query, entry.slug).toMatch(/\S/);
      // La ricerca Audius è breve (genere o mood): il catalogo YouTube in italiano lì non rende.
      expect(entry.audiusQuery, entry.slug).toMatch(/^[a-z0-9 ]{3,20}$/);
      expect(isPlaylistEntry(entry), entry.slug).toBe(true);
    }
    // «Piede comodino» con il comodino, come chiesto.
    const comodino = findGenre('piede-comodino');
    expect(comodino?.cover).toBe('comodino');
    expect(comodino?.name).toBe('Piede comodino');
    // I generi veri non hanno copertina e non sono playlist; le playlist a tema restano playlist.
    for (const entry of genreCatalog) {
      if (entry.family === 'divertenti') continue;
      expect(entry.cover, entry.slug).toBeUndefined();
      expect(isPlaylistEntry(entry), entry.slug).toBe(entry.family === 'playlist');
    }
  });

  it('una playlist divertente si cerca su YouTube con la sua ricerca fissa, come un genere', async () => {
    db.reset();
    mocks.search.mockClear();
    const response = await GET(new Request('https://solco.test/api/music/genres/piede-comodino'), {
      params: Promise.resolve({ slug: 'piede-comodino' }),
    });
    expect(response.status).toBe(200);
    expect(mocks.search).toHaveBeenCalledWith('screamo', 'key', fetch, 25);
  });

  it('cerca il genere con una query fissa e mette in cache al CDN', async () => {
    const response = await GET(new Request('https://solco.test/api/music/genres/phonk'), {
      params: Promise.resolve({ slug: 'phonk' }),
    });
    expect(response.status).toBe(200);
    expect(mocks.search).toHaveBeenCalledWith('phonk', 'key', fetch, 25);
    // The database keeps the search 24 h; the edge only 1 h, so "current" stays near 24 h.
    expect(response.headers.get('cache-control')).toBe('public, max-age=600, s-maxage=3600');
    const missing = await GET(new Request('https://solco.test/api/music/genres/nope'), {
      params: Promise.resolve({ slug: 'nope' }),
    });
    expect(missing.status).toBe(404);
  });

  it('a ricerche dei generi finite mostra i brani salvati, con la data e poca cache CDN', async () => {
    db.reset();
    mocks.search.mockClear();
    db.usage.set(
      `${youtubeQuotaDay()}|search:genre`,
      youtubeSearchPurposeCap('genre', youtubeQuotaDay()),
    );
    // Over 7 days old (not reused as current), re-checked today: shown as saved, with its date.
    const savedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    // The techno page searches "underground techno".
    db.searches.set(youtubeStoreKey('Underground Techno'), {
      key: youtubeStoreKey('underground techno'),
      payload: {
        outcome: 'results',
        size: 25,
        checkedAt: new Date().toISOString(),
        videos: [
          {
            provider: 'youtube',
            videoId: 'abcdefghijk',
            title: 'Techno salvata',
            channelTitle: 'Canale',
            channelId: null,
            description: null,
            publishedAt: null,
            thumbnailUrl: null,
          },
        ],
      },
      createdAt: savedAt,
      expiresAt: new Date(savedAt.getTime() + 24 * 60 * 60 * 1000),
    });
    const response = await GET(new Request('https://solco.test/api/music/genres/techno'), {
      params: Promise.resolve({ slug: 'techno' }),
    });
    const body = await response.json();
    expect(mocks.search).not.toHaveBeenCalled();
    expect(body.videos).toHaveLength(1);
    expect(body.youtube).toMatchObject({
      freshness: 'saved',
      savedAt: savedAt.toISOString(),
      limit: 'everyone',
    });
    expect(response.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=900');
  });

  it('un genere salvato da pochi giorni si mostra subito; la quota dei generi lo rinnova dopo', async () => {
    db.reset();
    mocks.search.mockClear();
    mocks.afterTasks.length = 0;
    const savedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    db.searches.set(youtubeStoreKey('underground techno'), {
      key: youtubeStoreKey('underground techno'),
      payload: {
        outcome: 'results',
        size: 25,
        checkedAt: new Date().toISOString(),
        videos: [
          {
            provider: 'youtube',
            videoId: 'abcdefghijk',
            title: 'Techno salvata',
            channelTitle: 'Canale',
            channelId: null,
            description: null,
            publishedAt: null,
            thumbnailUrl: null,
          },
        ],
      },
      createdAt: savedAt,
      expiresAt: new Date(savedAt.getTime() + 24 * 60 * 60 * 1000),
    });
    const response = await GET(new Request('https://solco.test/api/music/genres/techno'), {
      params: Promise.resolve({ slug: 'techno' }),
    });
    const body = await response.json();
    // Shown at once as current: nobody waits for YouTube.
    expect(body.videos).toHaveLength(1);
    expect(body.youtube).toMatchObject({ freshness: 'live', savedAt: null });
    expect(response.headers.get('cache-control')).toBe('public, max-age=600, s-maxage=3600');
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.afterTasks).toHaveLength(1);

    // After the response: one new search from the genre share, saved for the next visits.
    for (const task of mocks.afterTasks.splice(0)) await task();
    expect(mocks.search).toHaveBeenCalledOnce();
    expect(mocks.search).toHaveBeenCalledWith('underground techno', 'key', fetch, 25);
    expect(db.usage.get(`${youtubeQuotaDay()}|search:genre`)).toBe(1);
    expect(
      db.searches.get(youtubeStoreKey('underground techno'))?.createdAt.getTime(),
    ).toBeGreaterThan(savedAt.getTime());
  });

  it('il monitor automatico non spende ricerche YouTube: solo risultati salvati', async () => {
    db.reset();
    mocks.search.mockClear();
    const response = await GET(
      new Request('https://solco.test/api/music/genres/techno', {
        headers: {
          'user-agent':
            'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.0 Safari/537.36 SolcoMonitor/1.0 (+https://github.com/x/y)',
        },
      }),
      { params: Promise.resolve({ slug: 'techno' }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.search).not.toHaveBeenCalled();
    expect(db.usage.size).toBe(0);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('senza chiave YouTube non consuma il budget dei generi', async () => {
    db.reset();
    mocks.search.mockClear();
    mocks.apiKey = '';
    try {
      const response = await GET(new Request('https://solco.test/api/music/genres/phonk'), {
        params: Promise.resolve({ slug: 'phonk' }),
      });
      const body = await response.json();
      expect(body.sourceStatus.unavailableReason).toBe('not_configured');
      expect(mocks.search).not.toHaveBeenCalled();
      expect(db.usage.size).toBe(0);
    } finally {
      mocks.apiKey = 'key';
    }
  });
});
