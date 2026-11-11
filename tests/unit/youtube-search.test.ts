// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { getYouTubeVideoDetails, searchYouTubeMusic } from '@/lib/music/youtube-search.server';

describe('ricerca YouTube su richiesta', () => {
  it('mappa titolo, credito del canale e metadati dalla risposta ufficiale', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        items: [
          {
            id: { videoId: 'dQw4w9WgXcQ' },
            snippet: {
              title: 'Sample music video',
              channelTitle: 'Sample Music Channel',
              channelId: 'UCsample123',
              description: 'Descrizione dal risultato YouTube.',
              publishedAt: '2024-02-03T12:00:00Z',
              thumbnails: { medium: { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg' } },
            },
          },
          {
            id: { videoId: 'a1b2c3d4e5f' },
            snippet: { title: 'No channel credit', channelTitle: '' },
          },
        ],
      }),
    );

    const result = await searchYouTubeMusic('sample artist', 'test-only-key', fetcher);

    expect(result).toEqual({
      outcome: 'results',
      videos: [
        {
          provider: 'youtube',
          videoId: 'dQw4w9WgXcQ',
          title: 'Sample music video',
          channelTitle: 'Sample Music Channel',
          channelId: 'UCsample123',
          description: 'Descrizione dal risultato YouTube.',
          publishedAt: '2024-02-03T12:00:00.000Z',
          thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg',
        },
      ],
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [requestUrl, requestOptions] = fetcher.mock.calls[0] ?? [];
    const url = new URL(String(requestUrl));
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/youtube/v3/search');
    expect(url.searchParams.get('q')).toBe('sample artist');
    expect(url.searchParams.get('videoCategoryId')).toBe('10');
    expect(url.searchParams.get('videoEmbeddable')).toBe('true');
    expect(url.searchParams.get('type')).toBe('video');
    expect(url.searchParams.get('maxResults')).toBe('10');
    expect(url.searchParams.get('key')).toBe('test-only-key');
    expect(requestOptions?.cache).toBe('no-store');
    expect(result.videos[0]).not.toHaveProperty('streamUrl');
    expect(result.videos[0]).not.toHaveProperty('mediaBytes');
  });

  it('non interroga YouTube per una query vuota o senza credenziale', async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(searchYouTubeMusic('   ', 'test-only-key', fetcher)).resolves.toEqual({
      videos: [],
      outcome: 'no_results',
    });
    await expect(searchYouTubeMusic('jazz', undefined, fetcher)).resolves.toEqual({
      videos: [],
      outcome: 'unavailable',
      unavailableReason: 'not_configured',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('separa una risposta senza risultati da quota esaurita ed errore API', async () => {
    const noResults = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ items: [] }));
    const quotaExceeded = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json(
        { error: { errors: [{ reason: 'quotaExceeded' }] } },
        { status: 403 },
      ),
    );
    const apiError = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({ error: { errors: [{ reason: 'backendError' }] } }, { status: 500 }),
    );

    await expect(searchYouTubeMusic('jazz', 'test-key', noResults)).resolves.toEqual({
      videos: [],
      outcome: 'no_results',
    });
    await expect(searchYouTubeMusic('jazz', 'test-key', quotaExceeded)).resolves.toEqual({
      videos: [],
      outcome: 'unavailable',
      unavailableReason: 'quota_exceeded',
    });
    await expect(searchYouTubeMusic('jazz', 'test-key', apiError)).resolves.toEqual({
      videos: [],
      outcome: 'unavailable',
      unavailableReason: 'api_error',
    });
  });

  it('ottiene lo stato Made for Kids solo dal dettaglio ufficiale e non produce link media', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
      items: [{
        id: 'dQw4w9WgXcQ',
        snippet: { title: 'Sample music video', channelTitle: 'Sample Music Channel', channelId: 'UCsample123' },
        status: { madeForKids: false },
      }],
    }));
    const result = await getYouTubeVideoDetails('dQw4w9WgXcQ', 'server-only-key', fetcher);
    expect(result).toMatchObject({ outcome: 'found', details: { madeForKids: false, video: { videoId: 'dQw4w9WgXcQ' } } });
    expect(JSON.stringify(result)).not.toContain('server-only-key');
    expect(JSON.stringify(result)).not.toMatch(/streamUrl|mediaBytes|downloadUrl/i);
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('key')).toBe('server-only-key');
  });
});
