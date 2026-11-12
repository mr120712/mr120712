// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  checkYouTubeVideos,
  getYouTubeVideoDetails,
  searchYouTubeMusic,
} from '@/lib/music/youtube-search.server';

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
    const quotaExceeded = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 }),
      );
    const apiError = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
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
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        items: [
          {
            id: 'dQw4w9WgXcQ',
            snippet: {
              title: 'Sample music video',
              channelTitle: 'Sample Music Channel',
              channelId: 'UCsample123',
            },
            status: { madeForKids: false },
          },
        ],
      }),
    );
    const result = await getYouTubeVideoDetails('dQw4w9WgXcQ', 'server-only-key', fetcher);
    expect(result).toMatchObject({
      outcome: 'found',
      details: { madeForKids: false, video: { videoId: 'dQw4w9WgXcQ' } },
    });
    expect(JSON.stringify(result)).not.toContain('server-only-key');
    expect(JSON.stringify(result)).not.toMatch(/streamUrl|mediaBytes|downloadUrl/i);
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('key')).toBe(
      'server-only-key',
    );
  });
});

describe('quota e rallentamenti di YouTube', () => {
  it('separa la quota giornaliera finita da un rallentamento temporaneo', async () => {
    const reply = (reason: string) =>
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ error: { errors: [{ reason }] } }, { status: 403 }));
    for (const reason of ['quotaExceeded', 'dailyLimitExceeded']) {
      await expect(searchYouTubeMusic('jazz', 'k', reply(reason))).resolves.toMatchObject({
        unavailableReason: 'quota_exceeded',
      });
    }
    for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded']) {
      await expect(searchYouTubeMusic('jazz', 'k', reply(reason))).resolves.toMatchObject({
        unavailableReason: 'rate_limited',
      });
    }
  });
});

describe('ricontrollo dei video salvati (videos.list, 1 unità)', () => {
  const item = (id: string, status: Record<string, unknown>, title = `Titolo ${id}`) => ({
    id,
    snippet: { title, channelTitle: 'Canale', thumbnails: {} },
    status,
  });

  it('tiene solo i video ancora pubblici e incorporabili, con i dati aggiornati', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        items: [
          item('aaaaaaaaaaa', { privacyStatus: 'public', embeddable: true }, 'Nuovo titolo'),
          item('bbbbbbbbbbb', { privacyStatus: 'private', embeddable: true }),
          item('ccccccccccc', { privacyStatus: 'public', embeddable: false }),
          item('ddddddddddd', { privacyStatus: 'unlisted', embeddable: true }),
        ],
      }),
    );
    const result = await checkYouTubeVideos(
      ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd', 'eeeeeeeeeee', 'aaaaaaaaaaa'],
      'k',
      fetcher,
    );
    expect(result.outcome).toBe('checked');
    if (result.outcome !== 'checked') return;
    expect([...result.videos.keys()]).toEqual(['aaaaaaaaaaa', 'ddddddddddd']);
    expect(result.videos.get('aaaaaaaaaaa')?.title).toBe('Nuovo titolo');
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/youtube/v3/videos');
    expect(url.searchParams.get('id')).toBe(
      'aaaaaaaaaaa,bbbbbbbbbbb,ccccccccccc,ddddddddddd,eeeeeeeeeee',
    );
    expect(fetcher).toHaveBeenCalledOnce();
    // contentDetails for region limits (still 1 unit); maxResults is not allowed with id.
    expect(url.searchParams.get('part')).toBe('snippet,status,contentDetails');
    expect(url.searchParams.has('maxResults')).toBe(false);
  });

  it('toglie i video bloccati in Italia o permessi solo altrove', async () => {
    const withRegion = (id: string, regionRestriction?: Record<string, unknown>) => ({
      ...item(id, { privacyStatus: 'public', embeddable: true }),
      contentDetails: regionRestriction ? { regionRestriction } : {},
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        items: [
          withRegion('aaaaaaaaaaa'),
          withRegion('bbbbbbbbbbb', { blocked: ['DE', 'IT'] }),
          withRegion('ccccccccccc', { allowed: ['US', 'CA'] }),
          withRegion('ddddddddddd', { allowed: ['IT', 'SM'] }),
          withRegion('eeeeeeeeeee', { blocked: ['US'] }),
        ],
      }),
    );
    const result = await checkYouTubeVideos(
      ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd', 'eeeeeeeeeee'],
      'k',
      fetcher,
    );
    expect(result.outcome === 'checked' && [...result.videos.keys()]).toEqual([
      'aaaaaaaaaaa',
      'ddddddddddd',
      'eeeeeeeeeee',
    ]);
  });

  it('segnala quota finita e chiave mancante senza inventare risultati', async () => {
    const quota = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 }),
      );
    await expect(checkYouTubeVideos(['aaaaaaaaaaa'], 'k', quota)).resolves.toEqual({
      outcome: 'quota_exceeded',
    });
    const none = vi.fn<typeof fetch>();
    await expect(checkYouTubeVideos(['aaaaaaaaaaa'], '', none)).resolves.toEqual({
      outcome: 'not_configured',
    });
    expect(none).not.toHaveBeenCalled();
  });
});
