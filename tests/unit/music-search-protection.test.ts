// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  enforceRateLimit: vi.fn(),
  getRateLimitIdentity: vi.fn((userId: string | null, headers: Headers) => {
    if (userId) return `user:${userId}`;
    const ip = headers.get('cf-connecting-ip') ?? headers.get('x-real-ip');
    return ip ? `ip:${ip}` : null;
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: { audiusRequestBudget: {} } }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: mocks.getRateLimitIdentity,
  consumeRateLimit: async () => ({ allowed: true }),
}));

import { GET } from '@/app/api/music/search/route';
import { clearYouTubeSearchCacheForTests } from '@/lib/music/music-api.server';

function request(query: string, source: 'audius' | 'youtube', consent = false, ip = '192.0.2.81') {
  const url = new URL('https://solco.test/api/music/search');
  url.searchParams.set('q', query);
  url.searchParams.set('source', source);
  if (consent) url.searchParams.set('youtubeConsent', 'accepted');
  return new Request(url, { headers: { 'x-real-ip': ip } });
}

beforeEach(() => {
  clearYouTubeSearchCacheForTests();
  mocks.getSession.mockReset().mockResolvedValue(null);
  mocks.enforceRateLimit.mockReset().mockResolvedValue(null);
  vi.stubEnv('YOUTUBE_DATA_API_KEY', '');
  vi.stubEnv('AUDIUS_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('route di ricerca musicale', () => {
  it('rifiuta query non valide e YouTube senza invio esplicito del consenso', async () => {
    const empty = await GET(request('  ', 'youtube', true, '192.0.2.82'));
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ errors: { q: expect.any(String) } });

    const missingConsent = await GET(request('artista', 'youtube', false, '192.0.2.83'));
    expect(missingConsent.status).toBe(403);
    expect(await missingConsent.json()).toEqual({ error: 'youtube_consent_required' });
  });

  it('mostra la chiave mancante con il nome richiesto senza contattare YouTube', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const response = await GET(request('jazz', 'youtube', true, '192.0.2.84'));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      source: 'youtube',
      outcome: 'unavailable',
      videos: [],
      sourceStatus: { active: false, unavailableReason: 'not_configured' },
    });
    expect(JSON.stringify(body)).toContain('YOUTUBE_DATA_API_KEY');
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
  });

  it('normalizza metadati YouTube server-side e non restituisce la chiave', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        items: [
          {
            id: { videoId: 'dQw4w9WgXcQ' },
            snippet: {
              title: 'Titolo ufficiale',
              channelTitle: 'Canale ufficiale',
              channelId: 'UCsample123',
              description: 'Descrizione ufficiale.',
              publishedAt: '2024-05-06T10:00:00Z',
              thumbnails: { medium: { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg' } },
            },
          },
        ],
      }),
    );
    vi.stubEnv('YOUTUBE_DATA_API_KEY', 'secret-test-key');
    vi.stubGlobal('fetch', fetcher);

    const response = await GET(request('titolo', 'youtube', true, '192.0.2.85'));
    const body = await response.json();
    expect(body).toMatchObject({
      source: 'youtube',
      outcome: 'results',
      videos: [
        {
          videoId: 'dQw4w9WgXcQ',
          title: 'Titolo ufficiale',
          channelTitle: 'Canale ufficiale',
          channelId: 'UCsample123',
          description: 'Descrizione ufficiale.',
          publishedAt: '2024-05-06T10:00:00.000Z',
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('secret-test-key');
    expect(JSON.stringify(body)).not.toMatch(/streamUrl|mediaBytes|downloadUrl/i);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('key')).toBe(
      'secret-test-key',
    );
  });

  it('distingue quota, errore API e nessun risultato senza fallback Audius', async () => {
    vi.stubEnv('YOUTUBE_DATA_API_KEY', 'server-key');
    const quota = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 }),
      );
    vi.stubGlobal('fetch', quota);
    const quotaResponse = await GET(request('jazz', 'youtube', true, '192.0.2.86'));
    expect(await quotaResponse.json()).toMatchObject({
      outcome: 'unavailable',
      sourceStatus: { unavailableReason: 'quota_exceeded' },
    });

    const apiError = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ error: { errors: [{ reason: 'backendError' }] } }, { status: 500 }),
      );
    vi.stubGlobal('fetch', apiError);
    const errorResponse = await GET(request('rock', 'youtube', true, '192.0.2.87'));
    expect(await errorResponse.json()).toMatchObject({
      outcome: 'unavailable',
      sourceStatus: { unavailableReason: 'api_error' },
    });

    const noResults = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ items: [] }));
    vi.stubGlobal('fetch', noResults);
    const emptyResponse = await GET(request('ambient', 'youtube', true, '192.0.2.88'));
    expect(await emptyResponse.json()).toMatchObject({ outcome: 'no_results', videos: [] });
  });

  it('mostra Audius non configurata e non invia richieste senza la chiave', async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const response = await GET(request('ambient', 'audius', false, '192.0.2.89'));
    expect(await response.json()).toMatchObject({
      source: 'audius',
      outcome: 'unavailable',
      tracks: [],
      sourceStatus: { unavailableReason: 'not_configured' },
    });
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('restituisce lo stato di fonte mancante anche senza identità di rete locale', async () => {
    const response = await GET(
      new Request('https://solco.test/api/music/search?source=audius&q=ambient'),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: 'audius',
      outcome: 'unavailable',
      tracks: [],
      sourceStatus: { unavailableReason: 'not_configured' },
    });
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
  });

  it('restituisce 429 con Retry-After prima di interrogare una fonte musicale', async () => {
    vi.stubEnv('YOUTUBE_DATA_API_KEY', 'server-key');
    mocks.enforceRateLimit.mockResolvedValueOnce(
      Response.json(
        { error: 'rate_limited', message: 'Riprova tra 10 secondi.', retryAfterSeconds: 10 },
        { status: 429, headers: { 'Retry-After': '10' } },
      ),
    );
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);

    const response = await GET(request('jazz', 'youtube', true, '192.0.2.90'));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('10');
    expect(await response.json()).toMatchObject({ message: 'Riprova tra 10 secondi.' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('usa l’identità dell’account quando la sessione è presente', async () => {
    vi.stubEnv('YOUTUBE_DATA_API_KEY', 'server-key');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ items: [] })),
    );
    mocks.getSession.mockResolvedValueOnce({ user: { id: 'artista-1' } });
    const response = await GET(request('ambient', 'youtube', true, '192.0.2.91'));

    expect(response.status).toBe(200);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('music.search', 'user:artista-1');
  });
});
