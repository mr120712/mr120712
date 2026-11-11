// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  search: vi.fn(async () => ({ outcome: 'results' as const, videos: [] })),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/music/youtube-search.server', () => ({ searchYouTubeMusic: mocks.search }));
vi.mock('@/lib/music/music-api.server', () => ({ readYouTubeApiKey: () => 'key' }));

import { GET } from '@/app/api/music/genres/[slug]/route';
import { findGenre, genreCatalog, genreFamilies } from '@/lib/music/genre-catalog';

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
    expect(response.headers.get('cache-control')).toContain('s-maxage=86400');
    const missing = await GET(new Request('https://solco.test/api/music/genres/nope'), {
      params: Promise.resolve({ slug: 'nope' }),
    });
    expect(missing.status).toBe(404);
  });
});
