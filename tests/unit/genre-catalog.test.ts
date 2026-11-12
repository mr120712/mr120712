// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  search: vi.fn(async () => ({ outcome: 'results' as const, videos: [] })),
  apiKey: 'key',
}));
vi.mock('server-only', () => ({}));
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
import { findGenre, genreCatalog, genreFamilies } from '@/lib/music/genre-catalog';
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
    const savedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
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
