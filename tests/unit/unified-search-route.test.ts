// @polsia:user-owned — GET /api/music/search-all: forma aggregata, YouTube escluso mentre si
// digita (0 chiamate), quota YouTube finita con avviso e altre fonti intatte, deduplica fra fonti,
// ordinamento, isolamento di una fonte in errore o oltre il tempo massimo, e cache.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  searchMusic: vi.fn(),
  listStations: vi.fn(),
  searchPodcasts: vi.fn(),
  enforceRateLimit: vi.fn(),
  getRateLimitIdentity: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/music/music-api.server', () => ({ searchMusic: mocks.searchMusic }));
vi.mock('@/lib/music/radio-browser.server', () => ({ listStations: mocks.listStations }));
vi.mock('@/lib/music/podcasts.server', () => ({ searchPodcasts: mocks.searchPodcasts }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: mocks.getRateLimitIdentity,
}));

import { GET } from '@/app/api/music/search-all/route';
import type { Podcast, RadioStation } from '@/lib/contracts/library';
import type { AudiusTrackSearchResult, YouTubeVideoSearchResult } from '@/lib/contracts/music';
import { UnifiedSearchResponseSchema } from '@/lib/contracts/unified-search';
import type { YouTubeSearchNotice } from '@/lib/contracts/youtube-search';

const ip = '192.0.2.55';

function request(query: string, youtubeConsent = false) {
  const url = new URL('https://solco.test/api/music/search-all');
  url.searchParams.set('q', query);
  if (youtubeConsent) url.searchParams.set('youtubeConsent', 'accepted');
  return GET(new Request(url, { headers: { 'x-real-ip': ip } }));
}

function audiusTrack(
  id: string,
  title = `Brano ${id}`,
  artistName = 'Artista',
): AudiusTrackSearchResult {
  return {
    provider: 'audius',
    id,
    qualifiedId: `audius:${id}`,
    title,
    artistName,
    artistHandle: 'artista',
    artistId: `artist-${id}`,
    artistQualifiedId: `audius:artist-${id}`,
    artistUrl: 'https://audius.co/artista',
    trackUrl: `https://audius.co/artista/${id}`,
    artworkUrl: 'https://audius.co/images/cover.jpg',
    durationSeconds: 200,
    genre: null,
    mood: null,
    tags: null,
    releaseDate: null,
    license: null,
    licensorName: null,
    copyrightNotice: null,
    producerCopyrightNotice: null,
    attributionRemovalRequested: false,
    attributionComplete: true,
    playbackEligible: true,
    playbackReason: 'ready',
  } as AudiusTrackSearchResult;
}

function youtubeVideo(
  videoId: string,
  title = 'Video',
  channelTitle = 'Canale',
): YouTubeVideoSearchResult {
  return {
    provider: 'youtube',
    videoId,
    title,
    channelTitle,
    channelId: 'UCabc123',
    description: null,
    publishedAt: null,
    thumbnailUrl: null,
  };
}

function station(id: string, name = `Radio ${id}`): RadioStation {
  return {
    id,
    name,
    artworkUrl: null,
    country: 'Italy',
    countryCode: 'IT',
    tags: [],
    codec: 'MP3',
    bitrate: 128,
    homepage: null,
    votes: 10,
  };
}

function podcast(id: string, title = `Podcast ${id}`): Podcast {
  return { id, title, author: 'Autore', artworkUrl: null, genre: null };
}

const notice: YouTubeSearchNotice = {
  freshness: 'live',
  savedAt: null,
  limit: null,
  resetsAt: '2026-11-13T08:00:00.000Z',
};

function audiusResult(tracks: AudiusTrackSearchResult[]) {
  return {
    source: 'audius' as const,
    outcome: tracks.length ? ('results' as const) : ('no_results' as const),
    tracks,
    artists: [],
    playlists: [],
    albums: [],
    videos: [],
    sourceStatus: { id: 'audius' },
  };
}

function youtubeResult(
  videos: YouTubeVideoSearchResult[],
  overrides: { outcome?: string; youtube?: YouTubeSearchNotice } = {},
) {
  return {
    source: 'youtube' as const,
    outcome: overrides.outcome ?? (videos.length ? 'results' : 'no_results'),
    tracks: [],
    artists: [],
    playlists: [],
    albums: [],
    videos,
    sourceStatus: { id: 'youtube' },
    youtube: overrides.youtube ?? notice,
  };
}

beforeEach(() => {
  mocks.getSession.mockReset().mockResolvedValue(null);
  mocks.getRateLimitIdentity.mockReset().mockReturnValue(`ip:${ip}`);
  mocks.enforceRateLimit.mockReset().mockResolvedValue(null);
  mocks.searchMusic
    .mockReset()
    .mockImplementation(async (source: string) =>
      source === 'audius'
        ? audiusResult([audiusTrack('a1'), audiusTrack('a2')])
        : youtubeResult([youtubeVideo('vvvvvvvvvvv')]),
    );
  mocks.listStations
    .mockReset()
    .mockResolvedValue({ outcome: 'results', stations: [station('s1'), station('s2')] });
  mocks.searchPodcasts
    .mockReset()
    .mockResolvedValue({ outcome: 'results', podcasts: [podcast('101')] });
});

describe('GET /api/music/search-all', () => {
  it('rifiuta una query vuota o troppo lunga senza chiamare le fonti', async () => {
    const empty = await request('   ');
    expect(empty.status).toBe(400);
    expect((await empty.json()).errors.q).toContain('1 a 80');
    expect(mocks.searchMusic).not.toHaveBeenCalled();
    expect(mocks.listStations).not.toHaveBeenCalled();
    expect(mocks.searchPodcasts).not.toHaveBeenCalled();
  });

  it('aggrega le fonti in un elenco unico più le sezioni per fonte', async () => {
    const response = await request('ambient', true);
    const body = UnifiedSearchResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.youtubeRequested).toBe(true);
    expect(mocks.searchMusic).toHaveBeenCalledWith('audius', 'ambient');
    expect(mocks.searchMusic).toHaveBeenCalledWith('youtube', 'ambient', {
      youtubeIdentity: `ip:${ip}`,
    });
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('music.search', `ip:${ip}`);
    // Ogni fonte ha il suo stato.
    expect(body.sources.audius.status).toBe('results');
    expect(body.sources.youtube.status).toBe('results');
    expect(body.sources.radio.status).toBe('results');
    expect(body.sources.podcasts.status).toBe('results');
    // L'elenco misto contiene voci di tutte le fonti.
    expect(new Set(body.results.map((item) => item.kind))).toEqual(
      new Set(['audius', 'youtube', 'radio', 'podcast']),
    );
    expect(body.youtube).toEqual(notice);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('mentre si digita NON interroga YouTube (0 chiamate) e lascia la sezione "skipped"', async () => {
    const response = await request('ambient');
    const body = UnifiedSearchResponseSchema.parse(await response.json());

    expect(body.youtubeRequested).toBe(false);
    expect(body.sources.youtube).toEqual({ status: 'skipped', videos: [] });
    // searchMusic solo per Audius, mai per YouTube.
    const sources = mocks.searchMusic.mock.calls.map(([source]) => source);
    expect(sources).toEqual(['audius']);
    expect(body.results.some((item) => item.kind === 'youtube')).toBe(false);
    // Senza YouTube i dati sono pubblici: cache condivisa breve, non privata.
    expect(response.headers.get('cache-control')).toContain('s-maxage');
  });

  it('con quota YouTube finita tiene le altre fonti e restituisce l’avviso, senza cache', async () => {
    const quotaNotice: YouTubeSearchNotice = {
      freshness: 'live',
      savedAt: null,
      limit: 'everyone',
      resetsAt: '2026-11-13T08:00:00.000Z',
    };
    mocks.searchMusic.mockImplementation(async (source: string) =>
      source === 'audius'
        ? audiusResult([audiusTrack('a1')])
        : youtubeResult([], { outcome: 'unavailable', youtube: quotaNotice }),
    );
    const response = await request('ambient', true);
    const body = UnifiedSearchResponseSchema.parse(await response.json());

    expect(body.sources.youtube.status).toBe('unavailable');
    expect(body.youtube).toEqual(quotaNotice);
    expect(body.sources.audius.status).toBe('results');
    expect(body.sources.radio.status).toBe('results');
    expect(body.sources.podcasts.status).toBe('results');
    // Mai in cache un "unavailable" YouTube.
    expect(response.headers.get('cache-control')).toContain('no-store');
    // Una sola chiamata a YouTube.
    expect(mocks.searchMusic.mock.calls.filter(([source]) => source === 'youtube')).toHaveLength(1);
  });

  it('con quota finita ma risultati salvati mostra i video salvati e conserva l’avviso', async () => {
    const savedNotice: YouTubeSearchNotice = {
      freshness: 'saved',
      savedAt: '2026-11-10T09:00:00.000Z',
      limit: 'everyone',
      resetsAt: '2026-11-13T08:00:00.000Z',
    };
    mocks.searchMusic.mockImplementation(async (source: string) =>
      source === 'audius'
        ? audiusResult([])
        : youtubeResult([youtubeVideo('sssssssssss')], {
            outcome: 'results',
            youtube: savedNotice,
          }),
    );
    const body = UnifiedSearchResponseSchema.parse(await (await request('ambient', true)).json());

    expect(body.sources.youtube.status).toBe('results');
    expect(body.sources.youtube.videos.map((video) => video.videoId)).toEqual(['sssssssssss']);
    expect(body.youtube).toEqual(savedNotice);
  });

  it('deduplica lo stesso brano fra Audius e YouTube', async () => {
    mocks.searchMusic.mockImplementation(async (source: string) =>
      source === 'audius'
        ? audiusResult([audiusTrack('a1', 'August 10', 'Khruangbin')])
        : youtubeResult([
            youtubeVideo('vvvvvvvvvvv', 'Khruangbin - August 10 (Official Audio)', 'Khruangbin'),
          ]),
    );
    mocks.listStations.mockResolvedValue({ outcome: 'no_results', stations: [] });
    mocks.searchPodcasts.mockResolvedValue({ outcome: 'no_results', podcasts: [] });
    const body = UnifiedSearchResponseSchema.parse(await (await request('august 10', true)).json());

    // Nell'elenco misto il brano appare una volta sola, come voce Audius con l'alternativa YouTube.
    expect(body.results).toHaveLength(1);
    const entry = body.results[0];
    expect(entry?.kind).toBe('audius');
    if (entry?.kind === 'audius') {
      expect(entry.youtubeAlternative?.videoId).toBe('vvvvvvvvvvv');
    }
    // La sezione YouTube elenca comunque il video (vista non mista).
    expect(body.sources.youtube.videos.map((video) => video.videoId)).toEqual(['vvvvvvvvvvv']);
  });

  it('ordina per rilevanza, con la priorità della fonte come spareggio', async () => {
    mocks.searchMusic.mockImplementation(async (source: string) =>
      source === 'audius'
        ? audiusResult([audiusTrack('a1', 'Luna', 'Artista')])
        : youtubeResult([youtubeVideo('yyyyyyyyyyy', 'Mezza luna', 'Canale')]),
    );
    mocks.listStations.mockResolvedValue({ outcome: 'results', stations: [station('s1', 'Luna')] });
    mocks.searchPodcasts.mockResolvedValue({
      outcome: 'results',
      podcasts: [podcast('101', 'Luna park')],
    });
    const body = UnifiedSearchResponseSchema.parse(await (await request('luna', true)).json());

    expect(body.results.map((item) => item.key)).toEqual([
      'audius:a1', // 100, priorità alta
      'radio:s1', // 100, priorità più bassa
      'podcast:101', // 70 (inizia con)
      'youtube:yyyyyyyyyyy', // 40 (contiene)
    ]);
  });

  it('isola una fonte in errore: le altre restano, stato 200', async () => {
    mocks.searchPodcasts.mockRejectedValue(new Error('iTunes down'));
    const response = await request('ambient', true);
    const body = UnifiedSearchResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.sources.podcasts).toEqual({ status: 'unavailable', podcasts: [] });
    expect(body.sources.audius.status).toBe('results');
    expect(body.sources.radio.status).toBe('results');
    expect(body.sources.youtube.status).toBe('results');
  });

  it('chiude una fonte oltre il suo tempo massimo senza aspettare le altre', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.searchMusic.mockImplementation((source: string) =>
      source === 'audius'
        ? new Promise(() => undefined)
        : Promise.resolve(youtubeResult([youtubeVideo('vvvvvvvvvvv')])),
    );
    const pending = request('ambient', true);
    await vi.advanceTimersByTimeAsync(12_000);
    const response = await pending;
    const body = UnifiedSearchResponseSchema.parse(await response.json());
    vi.useRealTimers();

    expect(body.sources.audius).toEqual({
      status: 'unavailable',
      tracks: [],
      artists: [],
      playlists: [],
      albums: [],
    });
    expect(body.sources.radio.status).toBe('results');
    expect(body.sources.podcasts.status).toBe('results');
    expect(body.sources.youtube.status).toBe('results');
  });

  it('senza un’identità affidabile (sviluppo locale) non applica il limite', async () => {
    mocks.getRateLimitIdentity.mockReturnValue(null);
    const response = await request('ambient', true);

    expect(response.status).toBe(200);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    // Con identità assente YouTube riceve comunque null (il budget lo gestisce).
    expect(mocks.searchMusic).toHaveBeenCalledWith('youtube', 'ambient', { youtubeIdentity: null });
  });

  it('dichiara un limite di durata sopra il tempo massimo più lungo', async () => {
    const route = await import('@/app/api/music/search-all/route');
    expect(route.maxDuration).toBeGreaterThan(12);
    expect(route.maxDuration).toBeLessThanOrEqual(60);
  });
});
