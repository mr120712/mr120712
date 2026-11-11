// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { getYouTubeMusicChart, parseYouTubeDuration } from '@/lib/music/youtube-search.server';

describe('classifica YouTube', () => {
  it('converte le durate ISO 8601', () => {
    expect(parseYouTubeDuration('PT3M21S')).toBe(201);
    expect(parseYouTubeDuration('PT1H2M')).toBe(3720);
    expect(parseYouTubeDuration('P0D')).toBeNull();
    expect(parseYouTubeDuration(42)).toBeNull();
  });

  it('chiede i video musicali più popolari del paese ed esclude quelli non incorporabili', async () => {
    const item = (id: string, embeddable: boolean) => ({
      id,
      snippet: { title: `Video ${id}`, channelTitle: 'Canale', thumbnails: {} },
      contentDetails: { duration: 'PT4M' },
      status: { embeddable },
    });
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ items: [item('aaaaaaaaaaa', true), item('bbbbbbbbbbb', false)] }),
        ),
      );
    const result = await getYouTubeMusicChart('IT', 'key', fetcher as unknown as typeof fetch);
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get('chart')).toBe('mostPopular');
    expect(url.searchParams.get('videoCategoryId')).toBe('10');
    expect(url.searchParams.get('regionCode')).toBe('IT');
    expect(result.videos.map((video) => [video.videoId, video.durationSeconds])).toEqual([
      ['aaaaaaaaaaa', 240],
    ]);
    expect(await getYouTubeMusicChart('IT', '', fetcher as unknown as typeof fetch)).toEqual({
      outcome: 'unavailable',
      videos: [],
    });
  });
});
