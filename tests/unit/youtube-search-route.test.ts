// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ searchMusic: vi.fn(), getMusicSourceStatuses: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/music/music-api.server', () => ({
  searchMusic: mocks.searchMusic,
  getMusicSourceStatuses: mocks.getMusicSourceStatuses,
}));
vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: vi.fn().mockResolvedValue(null),
  getRateLimitIdentity: vi.fn(() => 'ip:unit-test'),
}));

import { GET } from '@/app/api/music/search/route';

const youtubeStatus = {
  id: 'youtube',
  label: 'YouTube',
  active: true,
  searchOutcome: 'results',
  summary: 'YouTube Data API v3 configurata.',
  prerequisite: 'Configura YOUTUBE_DATA_API_KEY.',
};

const video = {
  provider: 'youtube' as const,
  videoId: 'dQw4w9WgXcQ',
  title: 'Titolo dalla risposta API',
  channelTitle: 'Canale API',
  channelId: 'UCsample123',
  description: 'Descrizione API',
  publishedAt: '2024-02-03T12:00:00.000Z',
  thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg',
};

function request(source: string, query: string, consent = false) {
  const url = new URL('https://solco.test/api/music/search');
  url.searchParams.set('source', source);
  url.searchParams.set('q', query);
  if (consent) url.searchParams.set('youtubeConsent', 'accepted');
  return new Request(url, { headers: { 'x-real-ip': '192.0.2.41' } });
}

beforeEach(() => {
  mocks.searchMusic.mockReset().mockResolvedValue({
    source: 'youtube',
    outcome: 'results',
    tracks: [],
    artists: [],
    playlists: [],
    albums: [],
    videos: [video],
    sourceStatus: youtubeStatus,
  });
  mocks.getMusicSourceStatuses.mockReset().mockReturnValue([youtubeStatus]);
});

describe('route di ricerca musicale per fonte', () => {
  it('non avvia YouTube senza invio esplicito con consenso', async () => {
    const response = await GET(request('youtube', 'Khruangbin'));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'youtube_consent_required' });
    expect(mocks.searchMusic).not.toHaveBeenCalled();
  });

  it('restituisce soltanto i metadati API dopo l’invio esplicito e non include la chiave server', async () => {
    const response = await GET(request('youtube', 'Khruangbin', true));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(mocks.searchMusic).toHaveBeenCalledOnce();
    expect(mocks.searchMusic).toHaveBeenCalledWith('youtube', 'Khruangbin');
    expect(body).toMatchObject({ source: 'youtube', outcome: 'results', videos: [video] });
    expect(JSON.stringify(body)).not.toContain('test-secret');
    expect(JSON.stringify(body)).not.toMatch(/streamUrl|downloadUrl|mediaBytes/i);
  });

  it('mantiene distinti nessun risultato e quota esaurita', async () => {
    mocks.searchMusic
      .mockResolvedValueOnce({
        source: 'youtube',
        outcome: 'no_results',
        tracks: [],
        artists: [],
        playlists: [],
        albums: [],
        videos: [],
        sourceStatus: { ...youtubeStatus, searchOutcome: 'no_results' },
      })
      .mockResolvedValueOnce({
        source: 'youtube',
        outcome: 'unavailable',
        tracks: [],
        artists: [],
        playlists: [],
        albums: [],
        videos: [],
        sourceStatus: {
          ...youtubeStatus,
          searchOutcome: 'unavailable',
          unavailableReason: 'quota_exceeded',
        },
      });

    const empty = await GET(request('youtube', 'nobody', true));
    const quota = await GET(request('youtube', 'ambient', true));
    expect((await empty.json()).outcome).toBe('no_results');
    expect((await quota.json()).sourceStatus.unavailableReason).toBe('quota_exceeded');
    expect(mocks.searchMusic).toHaveBeenCalledTimes(2);
  });

  it('rifiuta una fonte diversa dalle due dichiarate', async () => {
    const response = await GET(request('other', 'query', true));
    expect(response.status).toBe(400);
    expect(mocks.searchMusic).not.toHaveBeenCalled();
  });
});
