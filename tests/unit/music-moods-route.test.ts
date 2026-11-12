// @polsia:user-owned — GET /api/music/moods/[mood]: 404, limite per IP, sezioni indipendenti,
// tempi massimi per fonte, cache CDN e richiesta Audius (mood e generi ripetuti, ricerca vuota).
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enforceRateLimit: vi.fn(),
  getAudiusMoodTracks: vi.fn(),
  listStations: vi.fn(),
  searchPodcasts: vi.fn(),
  database: { upsert: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: { audiusRequestBudget: mocks.database } }));
vi.mock('@/lib/business/rate-limit.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/business/rate-limit.server')>()),
  enforceRateLimit: mocks.enforceRateLimit,
}));
vi.mock('@/lib/music/audius-source.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/music/audius-source.server')>()),
  getAudiusMoodTracks: mocks.getAudiusMoodTracks,
}));
vi.mock('@/lib/music/radio-browser.server', () => ({ listStations: mocks.listStations }));
vi.mock('@/lib/music/podcasts.server', () => ({ searchPodcasts: mocks.searchPodcasts }));

import { GET } from '@/app/api/music/moods/[mood]/route';
import type { Podcast, RadioStation } from '@/lib/contracts/library';
import { MoodFeedResponseSchema } from '@/lib/contracts/moods';
import type { AudiusTrackSearchResult } from '@/lib/contracts/music';
import {
  AUDIUS_APP_NAME,
  clearAudiusMetadataCacheForTests,
  createAudiusApiClient,
} from '@/lib/music/audius-api.server';
import { runAudiusMoodTracks } from '@/lib/music/audius-source.server';
import { findMood } from '@/lib/music/moods';

const ip = '192.0.2.88';

function request(mood: string, headers: Record<string, string> = { 'x-real-ip': ip }) {
  return GET(new Request(`https://solco.test/api/music/moods/${mood}`, { headers }), {
    params: Promise.resolve({ mood }),
  });
}

function audiusTrack(
  id: string,
  overrides: Partial<AudiusTrackSearchResult> = {},
): AudiusTrackSearchResult {
  return {
    provider: 'audius',
    id,
    qualifiedId: `audius:${id}`,
    title: `Brano ${id}`,
    artistName: 'Artista',
    artistHandle: 'artista',
    artistId: 'artist-1',
    artistQualifiedId: 'audius:artist-1',
    artistUrl: 'https://audius.co/artista',
    trackUrl: `https://audius.co/artista/${id}`,
    artworkUrl: 'https://audius.co/images/cover.jpg',
    durationSeconds: 200,
    genre: 'Ambient',
    mood: 'Peaceful',
    tags: 'calma',
    releaseDate: null,
    bpm: 90,
    musicalKey: null,
    isrc: 'ITABC2600001',
    iswc: null,
    license: null,
    licensorName: 'Artista',
    copyrightNotice: null,
    producerCopyrightNotice: null,
    attributionRemovalRequested: false,
    attributionComplete: true,
    playbackEligible: true,
    playbackReason: 'ready',
    ...overrides,
  } as AudiusTrackSearchResult;
}

function station(
  id: string,
  name = `Radio ${id}`,
  overrides: Partial<RadioStation> = {},
): RadioStation {
  return {
    id,
    name,
    artworkUrl: null,
    country: 'Italy',
    countryCode: 'IT',
    tags: ['chillout'],
    codec: 'MP3',
    bitrate: 128,
    homepage: null,
    votes: 10,
    ...overrides,
  };
}

function podcast(id: string): Podcast {
  return { id, title: `Podcast ${id}`, author: 'Autore', artworkUrl: null, genre: 'Salute' };
}

function rateLimited() {
  return Response.json(
    { error: 'rate_limited', message: 'Hai raggiunto il limite.', retryAfterSeconds: 30 },
    { status: 429, headers: { 'Retry-After': '30', 'Cache-Control': 'private, no-store' } },
  );
}

beforeEach(() => {
  mocks.enforceRateLimit.mockReset().mockResolvedValue(null);
  mocks.getAudiusMoodTracks.mockReset().mockResolvedValue({
    outcome: 'results',
    tracks: [audiusTrack('t1'), audiusTrack('t2')],
  });
  mocks.listStations.mockReset().mockImplementation(async ({ tag }: { tag: string }) => ({
    outcome: 'results',
    stations: [station(`${tag}-1`), station(`${tag}-2`)],
  }));
  mocks.searchPodcasts.mockReset().mockResolvedValue({
    outcome: 'results',
    podcasts: [podcast('101'), podcast('102')],
  });
});

afterEach(() => {
  vi.useRealTimers();
  clearAudiusMetadataCacheForTests();
});

describe('GET /api/music/moods/[mood]', () => {
  it('risponde 404 per un mood sconosciuto senza contare il limite né chiamare le fonti', async () => {
    const response = await request('tristezza');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'mood_not_found' });
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.getAudiusMoodTracks).not.toHaveBeenCalled();
    expect(mocks.listStations).not.toHaveBeenCalled();
    expect(mocks.searchPodcasts).not.toHaveBeenCalled();
  });

  it('conta la richiesta per IP su music.catalog e blocca prima delle fonti esterne', async () => {
    mocks.enforceRateLimit.mockResolvedValueOnce(rateLimited());
    const response = await request('relax');

    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('music.catalog', `ip:${ip}`);
    expect(mocks.getAudiusMoodTracks).not.toHaveBeenCalled();
    expect(mocks.listStations).not.toHaveBeenCalled();
    expect(mocks.searchPodcasts).not.toHaveBeenCalled();
  });

  it('senza un IP affidabile (sviluppo locale) non scrive limiti', async () => {
    const response = await request('relax', { 'cf-connecting-ip': '198.51.100.9' });

    expect(response.status).toBe(200);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
  });

  it('interroga ogni fonte con i filtri del mood e restituisce il feed completo', async () => {
    const relax = findMood('relax');
    if (!relax) throw new Error('relax missing');
    const response = await request('relax');
    const body = MoodFeedResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(mocks.getAudiusMoodTracks).toHaveBeenCalledWith({
      moods: relax.audius.moods,
      genres: relax.audius.genres,
      limit: 100,
    });
    // More than the 8 shown per tag: duplicates are dropped.
    expect(mocks.listStations.mock.calls.map(([query]) => query)).toEqual(
      relax.radioTags.map((tag) => ({ tag, limit: 12 })),
    );
    expect(mocks.searchPodcasts).toHaveBeenCalledWith('meditazione');
    expect(body.mood).toEqual({ id: 'relax', label: 'Relax', description: relax.description });
    expect(body.tracks).toMatchObject({ status: 'results', items: [{ id: 't1' }, { id: 't2' }] });
    // Stations alternate between the mood's tags (the most voted of each first).
    expect(body.stations.items.map((item) => item.id)).toEqual([
      'chillout-1',
      'lounge-1',
      'ambient-1',
      'chillout-2',
      'lounge-2',
      'ambient-2',
    ]);
    expect(body.podcasts.items.map((item) => item.id)).toEqual(['101', '102']);
    expect(body.genres).toEqual({
      status: 'results',
      items: relax.genreSlugs.map((slug) =>
        expect.objectContaining({ slug, href: `/generi/${slug}` }),
      ),
    });
    // Like the sibling catalogue routes: the browser keeps it too (going back to a chip is free).
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=300, s-maxage=600, stale-while-revalidate=600',
    );
  });

  it('invia solo i campi della riga brano e solo i brani OML riproducibili, al massimo 20', async () => {
    mocks.getAudiusMoodTracks.mockResolvedValueOnce({
      outcome: 'results',
      tracks: [
        audiusTrack('cc', {
          license: 'CC BY',
          playbackEligible: false,
          playbackReason: 'license_not_allowed',
        }),
        ...Array.from({ length: 25 }, (_, index) =>
          audiusTrack(`ok${index}`, {
            artistId: `artist-${index}`,
            artistName: `Artista ${index}`,
          }),
        ),
      ],
    });
    const body = (await (await request('relax')).json()) as {
      tracks: { items: Record<string, unknown>[] };
    };

    expect(body.tracks.items).toHaveLength(20);
    expect(body.tracks.items.some((item) => item.id === 'cc')).toBe(false);
    expect(Object.keys(body.tracks.items[0] ?? {}).sort()).toEqual(
      [
        'artistName',
        'artistUrl',
        'artworkUrl',
        'attributionRemovalRequested',
        'copyrightNotice',
        'durationSeconds',
        'id',
        'license',
        'licensorName',
        'playbackEligible',
        'playbackReason',
        'qualifiedId',
        'title',
        'trackUrl',
      ].sort(),
    );
  });

  it('limita radio (senza doppioni di nome) e podcast a 8', async () => {
    mocks.listStations.mockImplementation(async ({ tag }: { tag: string }) => ({
      outcome: 'results',
      stations: [
        station(`same-name-${tag}`, 'Radio Calma'),
        ...Array.from({ length: 8 }, (_, index) => station(`${tag}-${index}`)),
      ],
    }));
    mocks.searchPodcasts.mockResolvedValueOnce({
      outcome: 'results',
      podcasts: Array.from({ length: 25 }, (_, index) => podcast(String(200 + index))),
    });
    const body = MoodFeedResponseSchema.parse(await (await request('notte')).json());

    expect(body.stations.items).toHaveLength(8);
    expect(body.stations.items.filter((item) => item.name === 'Radio Calma')).toHaveLength(1);
    expect(body.podcasts.items).toHaveLength(8);
  });

  it('scarta la stessa radio in un altro bitrate, codec o canale dello stesso sito', async () => {
    // Shapes seen live on Radio Browser (Notte, Relax and Romantico).
    const lists: Record<string, RadioStation[]> = {
      sleep: [
        station('groove-mp3', 'SomaFM Groove Salad (128k MP3)', {
          homepage: 'https://somafm.com/groovesalad/',
        }),
        station('love-1', 'LOVE RADIO - LOVE.radio', { homepage: 'https://love.radio/' }),
        station('vinyl', 'Classic Vinyl HD', { homepage: 'https://walmradio.com/classic' }),
      ],
      ambient: [
        station('groove-aac', 'SomaFM Groove Salad (128k AAC)', {
          homepage: 'https://somafm.com/groovesalad',
        }),
        station('love-2', 'LOVE.radio Only Love Songs 70s80s90s', {
          homepage: 'https://www.love.radio',
        }),
        station('vinyl-opus', 'Classic Vinyl HD Opus', { homepage: null }),
      ],
      chillout: [
        // Another SomaFM channel: its own page on the same site, so it stays.
        station('secret-agent', 'SomaFM Secret Agent (128k MP3)', {
          homepage: 'https://somafm.com/secretagent/',
        }),
        station('smooth', 'Smooth Chill', { homepage: 'https://www.smoothradio.com/chill' }),
      ],
    };
    mocks.listStations.mockImplementation(async ({ tag }: { tag: string }) => ({
      outcome: 'results',
      stations: lists[tag] ?? [],
    }));
    const body = MoodFeedResponseSchema.parse(await (await request('notte')).json());

    expect(body.stations.items.map((item) => item.id)).toEqual([
      'groove-mp3',
      'secret-agent',
      'love-1',
      'smooth',
      'vinyl',
    ]);
  });

  it('tiene le sezioni indipendenti quando una fonte fallisce', async () => {
    mocks.getAudiusMoodTracks.mockRejectedValueOnce(new Error('Audius down'));
    mocks.searchPodcasts.mockResolvedValueOnce({ outcome: 'unavailable', podcasts: [] });
    const response = await request('festa');
    const body = MoodFeedResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.tracks).toEqual({ status: 'unavailable', items: [] });
    expect(body.podcasts).toEqual({ status: 'unavailable', items: [] });
    expect(body.stations.status).toBe('results');
    expect(body.stations.items.length).toBeGreaterThan(0);
    expect(body.genres.status).toBe('results');
    // Something to show, but a source is down: only a short shared cache.
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
  });

  it('con Audius non disponibile e radio con risultati mette in cache solo per un minuto', async () => {
    mocks.getAudiusMoodTracks.mockResolvedValueOnce({
      outcome: 'unavailable',
      tracks: [],
      retryAfterSeconds: 5,
    });
    const response = await request('relax');
    const body = MoodFeedResponseSchema.parse(await response.json());

    expect(body.tracks).toEqual({ status: 'unavailable', items: [] });
    expect(body.stations.items.length).toBeGreaterThan(0);
    expect(body.podcasts.items.length).toBeGreaterThan(0);
    // No stale reuse: the next request after a minute asks Audius again.
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
  });

  it('mette prima 3 brani per artista, poi riempie i posti liberi con quelli in più', async () => {
    mocks.getAudiusMoodTracks.mockResolvedValueOnce({
      outcome: 'results',
      tracks: [
        ...Array.from({ length: 6 }, (_, index) =>
          audiusTrack(`big${index}`, { artistId: 'big', artistName: 'Catalogo grande' }),
        ),
        audiusTrack('arr', {
          artistId: 'other',
          license: 'All rights reserved',
          playbackEligible: false,
          playbackReason: 'license_not_allowed',
        }),
        ...Array.from({ length: 4 }, (_, index) =>
          audiusTrack(`other${index}`, { artistId: 'other', artistName: 'Altro artista' }),
        ),
        audiusTrack('solo', { artistId: 'solo', artistName: 'Solista' }),
      ],
    });
    const body = MoodFeedResponseSchema.parse(await (await request('notte')).json());

    // The non-OML track does not use one of the artist's 3 places nor fill a free one; the tracks
    // over the cap come after the varied ones, in popularity order.
    expect(body.tracks.items.map((item) => item.id)).toEqual([
      'big0',
      'big1',
      'big2',
      'other0',
      'other1',
      'other2',
      'solo',
      'big3',
      'big4',
      'big5',
      'other3',
    ]);
  });

  it('con un catalogo che domina i risultati arriva comunque a min(20, brani riproducibili)', async () => {
    const pool = (bigCount: number) => [
      ...Array.from({ length: bigCount }, (_, index) =>
        audiusTrack(`big${index}`, { artistId: 'college', artistName: 'Catalogo grande' }),
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        audiusTrack(`solo${index}`, { artistId: `solo-${index}`, artistName: `Solista ${index}` }),
      ),
    ];
    mocks.getAudiusMoodTracks.mockResolvedValueOnce({ outcome: 'results', tracks: pool(10) });
    const small = MoodFeedResponseSchema.parse(await (await request('relax')).json());
    const ids = small.tracks.items.map((item) => item.id);

    // 3 + 5 + 7 over the cap = the whole pool of 15.
    expect(ids).toHaveLength(15);
    expect(ids.slice(0, 8)).toEqual([
      'big0',
      'big1',
      'big2',
      'solo0',
      'solo1',
      'solo2',
      'solo3',
      'solo4',
    ]);
    expect(ids.slice(8)).toEqual(['big3', 'big4', 'big5', 'big6', 'big7', 'big8', 'big9']);

    mocks.getAudiusMoodTracks.mockResolvedValueOnce({ outcome: 'results', tracks: pool(30) });
    const large = MoodFeedResponseSchema.parse(await (await request('relax')).json());

    // 3 + 5 + 12 over the cap: never more than 20.
    expect(large.tracks.items).toHaveLength(20);
    expect(large.tracks.items.slice(0, 8).map((item) => item.id)).toEqual(ids.slice(0, 8));
    expect(large.tracks.items.at(-1)?.id).toBe('big14');
  });

  it('segna non disponibili le radio solo se tutti i tag falliscono', async () => {
    mocks.listStations.mockImplementation(async ({ tag }: { tag: string }) =>
      tag === 'dance'
        ? { outcome: 'unavailable', stations: [] }
        : { outcome: 'results', stations: [station(`${tag}-1`)] },
    );
    const partial = MoodFeedResponseSchema.parse(await (await request('festa')).json());
    expect(partial.stations.status).toBe('results');
    expect(partial.stations.items.map((item) => item.id)).toEqual(['house-1', 'disco-1']);

    mocks.listStations.mockResolvedValue({ outcome: 'unavailable', stations: [] });
    const down = MoodFeedResponseSchema.parse(await (await request('festa')).json());
    expect(down.stations).toEqual({ status: 'unavailable', items: [] });
  });

  it('chiude una fonte lenta al suo tempo massimo senza aspettare oltre', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.getAudiusMoodTracks.mockReturnValueOnce(new Promise(() => undefined));
    const pending = request('concentrazione');
    await vi.advanceTimersByTimeAsync(12_000);
    const response = await pending;
    const body = MoodFeedResponseSchema.parse(await response.json());

    expect(body.tracks).toEqual({ status: 'unavailable', items: [] });
    expect(body.stations.status).toBe('results');
    expect(body.podcasts.status).toBe('results');
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
  });

  it('lascia ad Audius e alle radio il tempo di un host di riserva dopo il primo (8 s e 6 s)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // First host times out at 8 s (Audius) / first mirror at 6 s (radio), the next one answers.
    mocks.getAudiusMoodTracks.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ outcome: 'results', tracks: [audiusTrack('late')] }), 9_500);
        }),
    );
    mocks.listStations.mockImplementation(
      ({ tag }: { tag: string }) =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve({ outcome: 'results', stations: [station(`${tag}-late`)] }),
            7_000,
          );
        }),
    );
    let settled = false;
    const pending = request('concentrazione').then((response) => {
      settled = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    const response = await pending;
    const body = MoodFeedResponseSchema.parse(await response.json());

    expect(body.tracks.items.map((item) => item.id)).toEqual(['late']);
    expect(body.stations.items.map((item) => item.id)).toEqual([
      'lofi-late',
      'piano-late',
      'study-late',
    ]);
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=300, s-maxage=600, stale-while-revalidate=600',
    );
  });

  it('dichiara un limite di durata sopra il tempo massimo più lungo', async () => {
    const route = await import('@/app/api/music/moods/[mood]/route');
    expect(route.maxDuration).toBeGreaterThan(12);
    expect(route.maxDuration).toBeLessThanOrEqual(60);
  });

  it('con Audius non configurato la sezione brani è non disponibile', async () => {
    mocks.getAudiusMoodTracks.mockResolvedValueOnce({ outcome: 'inactive', tracks: [] });
    const body = MoodFeedResponseSchema.parse(await (await request('energia')).json());

    expect(body.tracks).toEqual({ status: 'unavailable', items: [] });
  });

  it('non mette in cache quando nessuna fonte esterna ha qualcosa da mostrare', async () => {
    mocks.getAudiusMoodTracks.mockResolvedValueOnce({ outcome: 'unavailable', tracks: [] });
    mocks.listStations.mockResolvedValue({ outcome: 'unavailable', stations: [] });
    mocks.searchPodcasts.mockResolvedValueOnce({ outcome: 'unavailable', podcasts: [] });
    const failed = await request('romantico');
    expect(failed.status).toBe(200);
    expect(failed.headers.get('cache-control')).toBe('no-store');
    // The static genre links stay available.
    expect(MoodFeedResponseSchema.parse(await failed.json()).genres.items.length).toBeGreaterThan(
      0,
    );

    mocks.getAudiusMoodTracks.mockResolvedValueOnce({ outcome: 'no_results', tracks: [] });
    mocks.listStations.mockResolvedValue({ outcome: 'no_results', stations: [] });
    mocks.searchPodcasts.mockResolvedValueOnce({ outcome: 'no_results', podcasts: [] });
    const empty = await request('romantico');
    expect(empty.headers.get('cache-control')).toBe('no-store');
  });
});

describe('richiesta Audius per mood', () => {
  const rawTrack = {
    id: 'track-71',
    title: 'Brano calmo',
    permalink: 'https://audius.co/sample-artist/brano-calmo',
    artwork: { '480x480': 'https://audius.co/images/cover.jpg' },
    duration: 183,
    genre: 'Ambient',
    mood: 'Peaceful',
    license: null,
    is_available: true,
    is_streamable: true,
    is_stream_gated: false,
    access_authorities: null,
    access: { stream: true },
    user: { id: 'artist-71', name: 'Sample Artist', handle: 'sample-artist' },
  };

  it('ripete i parametri mood e genre, con ricerca vuota e ordine per popolarità', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ data: [rawTrack, { ...rawTrack, id: 'track-72', license: 'CC BY' }] }),
      );
    const client = createAudiusApiClient({
      apiKey: 'mood-test-key',
      fetcher,
      reserve: async () => ({ allowed: true, notBefore: 0 }),
      wait: async () => undefined,
      hostResolver: async () => ['https://mood.audius.co'],
      now: () => 100,
    });

    const tracks = await client.moodTracks(
      { moods: ['Peaceful', 'Easygoing'], genres: ['Ambient', 'Lo-Fi'], limit: 100 },
      true,
    );
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));

    expect(url.origin).toBe('https://mood.audius.co');
    expect(url.pathname).toBe('/v1/tracks/search');
    expect(url.searchParams.has('query')).toBe(true);
    expect(url.searchParams.get('query')).toBe('');
    expect(url.searchParams.getAll('mood')).toEqual(['Peaceful', 'Easygoing']);
    expect(url.searchParams.getAll('genre')).toEqual(['Ambient', 'Lo-Fi']);
    expect(url.searchParams.get('sort_method')).toBe('popular');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('app_name')).toBe(AUDIUS_APP_NAME);
    // The OML gate of the shared normaliser: another licence is listed but not playable.
    expect(tracks.map((track) => [track.id, track.playbackReason])).toEqual([
      ['track-71', 'ready'],
      ['track-72', 'license_not_allowed'],
    ]);
  });

  it('riporta il limite Audius come fonte non disponibile', async () => {
    const result = await runAudiusMoodTracks(
      true,
      {
        moodTracks: async () => {
          const { AudiusApiError } = await import('@/lib/music/audius-api.server');
          throw new AudiusApiError('rate_limited', 'limite', 12);
        },
      },
      { moods: ['Peaceful'], genres: ['Ambient'], limit: 100 },
    );

    expect(result).toEqual({ tracks: [], outcome: 'unavailable', retryAfterSeconds: 12 });
    expect(
      await runAudiusMoodTracks(
        false,
        { moodTracks: async () => [] },
        { moods: [], genres: [], limit: 1 },
      ),
    ).toEqual({ tracks: [], outcome: 'inactive' });
  });
});
