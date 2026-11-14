// @polsia:user-owned — GET /api/music/search-all con la fonte `featured` (brani in evidenza) dal
// vero indice featured-search + diritti.json (Vercel Blob simulato): solo i brani dichiarati
// compaiono, primi a parità di rilevanza e senza doppioni con Audius/YouTube; la fonte ha il suo
// stato (Blob non configurato o lento) senza toccare le altre; i client che non chiedono
// `featured=1` ricevono la risposta di sempre.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  token: 'tok_test' as string | undefined,
  searchMusic: vi.fn(),
  listStations: vi.fn(),
  searchPodcasts: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@vercel/blob', () => ({ list: mocks.list, get: mocks.get }));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token };
  },
}));
vi.mock('@/lib/music/music-api.server', () => ({ searchMusic: mocks.searchMusic }));
vi.mock('@/lib/music/radio-browser.server', () => ({ listStations: mocks.listStations }));
vi.mock('@/lib/music/podcasts.server', () => ({ searchPodcasts: mocks.searchPodcasts }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: vi.fn(async () => null),
  getRateLimitIdentity: vi.fn(() => 'ip:192.0.2.9'),
}));

import { GET } from '@/app/api/music/search-all/route';
import { UnifiedSearchResponseSchema } from '@/lib/contracts/unified-search';
import { clearFeaturedSearchCacheForTests } from '@/lib/music/featured-search.server';

const PRIVATE = 'https://store.private.blob.vercel-storage.com';

function blob(pathname: string, uploadedAt = '2026-10-01T00:00:00.000Z', size = 1000) {
  const url = `${PRIVATE}/${pathname.split('/').map(encodeURIComponent).join('/')}`;
  return { pathname, url, downloadUrl: url, size, uploadedAt: new Date(uploadedAt) };
}

const DECLARED = 'Cantautori/Lucio Dalla - Caruso.mp3';
const UNDECLARED = 'Download/Lucio Dalla - Caruso (Remastered).mp3';
const STORE = [
  blob(DECLARED, '2026-10-02T00:00:00.000Z'),
  blob(UNDECLARED, '2026-10-03T00:00:00.000Z'),
  blob('diritti.json', '2026-10-04T00:00:00.000Z', 200),
];
const MANIFEST = JSON.stringify({
  versione: 1,
  brani: [{ file: DECLARED, licenza: 'licenza', titolare: 'Etichetta Srl' }],
});

function audiusTrack(id: string, title: string, artistName: string) {
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
  };
}

function youtubeVideo(videoId: string, title: string, channelTitle: string) {
  return {
    provider: 'youtube',
    videoId,
    title,
    channelTitle,
    channelId: null,
    description: null,
    publishedAt: null,
    thumbnailUrl: null,
  };
}

function sourceResult(source: 'audius' | 'youtube', items: unknown[]) {
  return {
    source,
    outcome: items.length ? 'results' : 'no_results',
    tracks: source === 'audius' ? items : [],
    artists: [],
    playlists: [],
    albums: [],
    videos: source === 'youtube' ? items : [],
    sourceStatus: { id: source },
  };
}

function request(query: string, options: { featured?: boolean; youtube?: boolean } = {}) {
  const url = new URL('https://solco.test/api/music/search-all');
  url.searchParams.set('q', query);
  if (options.featured ?? true) url.searchParams.set('featured', '1');
  if (options.youtube) url.searchParams.set('youtubeConsent', 'accepted');
  return GET(new Request(url, { headers: { 'x-real-ip': '192.0.2.9' } }));
}

async function body(response: Response) {
  return UnifiedSearchResponseSchema.parse(await response.json());
}

beforeEach(() => {
  clearFeaturedSearchCacheForTests();
  mocks.token = 'tok_test';
  mocks.list.mockReset().mockResolvedValue({ blobs: STORE, hasMore: false });
  mocks.get.mockReset().mockImplementation(async () => ({
    statusCode: 200,
    stream: new Response(MANIFEST).body,
    headers: new Headers(),
    blob: { pathname: 'diritti.json' },
  }));
  mocks.getSession.mockReset().mockResolvedValue(null);
  mocks.searchMusic
    .mockReset()
    .mockImplementation(async (source: 'audius' | 'youtube') =>
      source === 'audius'
        ? sourceResult('audius', [audiusTrack('a1', 'Caruso', 'Lucio Dalla')])
        : sourceResult('youtube', [
            youtubeVideo('vvvvvvvvvvv', 'Lucio Dalla - Caruso (Official Video)', 'Lucio Dalla'),
          ]),
    );
  mocks.listStations.mockReset().mockResolvedValue({ outcome: 'no_results', stations: [] });
  mocks.searchPodcasts.mockReset().mockResolvedValue({ outcome: 'no_results', podcasts: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/music/search-all: brani in evidenza', () => {
  it('mostra SOLO i brani dichiarati in diritti.json: il brano non dichiarato non compare mai', async () => {
    const result = await body(await request('caruso'));

    const featured = result.results.filter((item) => item.kind === 'featured');
    expect(featured.map((item) => item.key)).toEqual([`featured:${DECLARED}`]);
    expect(result.sources.featured?.status).toBe('results');
    expect(result.sources.featured?.tracks.map((track) => track.id)).toEqual([DECLARED]);
    // In nessun punto della risposta: né nell'elenco né nella sezione.
    expect(JSON.stringify(result)).not.toContain('Remastered');
  });

  it('primo nell’elenco, e lo stesso brano su Audius/YouTube non si ripete', async () => {
    const result = await body(await request('caruso', { youtube: true }));

    expect(result.results[0]?.key).toBe(`featured:${DECLARED}`);
    const first = result.results[0];
    expect(first?.kind === 'featured' && first.youtubeAlternative?.videoId).toBe('vvvvvvvvvvv');
    expect(result.results.some((item) => item.kind === 'audius')).toBe(false);
    expect(result.results.some((item) => item.kind === 'youtube')).toBe(false);
    // Le sezioni per fonte restano complete.
    expect(result.sources.audius.tracks.map((track) => track.id)).toEqual(['a1']);
    expect(result.sources.youtube.videos.map((video) => video.videoId)).toEqual(['vvvvvvvvvvv']);
  });

  it('il brano porta copertina e streamUrl della Home (riproduzione identica)', async () => {
    const result = await body(await request('lucio dalla'));
    const entry = result.results.find((item) => item.kind === 'featured');
    expect(entry?.kind === 'featured' && entry.track).toEqual({
      id: DECLARED,
      title: 'Caruso',
      artist: 'Lucio Dalla',
      streamUrl: `/api/music/home-tracks/stream?p=${encodeURIComponent(DECLARED)}`,
      durationSeconds: 0,
      artworkUrl: `/api/music/home-tracks/cover?p=${encodeURIComponent(DECLARED)}`,
    });
  });

  it('senza featured=1 la risposta è quella di sempre (client meno recenti) e lo store non si tocca', async () => {
    const response = await request('caruso', { featured: false });
    const raw = await response.json();

    expect(raw.sources.featured).toBeUndefined();
    expect(raw.results.some((item: { kind: string }) => item.kind === 'featured')).toBe(false);
    expect(Object.keys(raw.sources).sort()).toEqual(['audius', 'podcasts', 'radio', 'youtube']);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('Blob non configurato: fonte "unavailable", le altre intatte', async () => {
    mocks.token = undefined;
    const response = await request('caruso');
    const result = await body(response);

    expect(response.status).toBe(200);
    expect(result.sources.featured).toEqual({ status: 'unavailable', tracks: [] });
    expect(result.sources.audius.status).toBe('results');
    expect(result.results.map((item) => item.key)).toEqual(['audius:a1']);
    // Una fonte non disponibile non va in cache a lungo.
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
  });

  it('Blob lento: la fonte chiude al suo tempo massimo senza bloccare le altre', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.list.mockReturnValue(new Promise(() => undefined));
    const pending = request('caruso');
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await body(await pending);

    expect(result.sources.featured).toEqual({ status: 'unavailable', tracks: [] });
    expect(result.sources.audius.status).toBe('results');
  });

  it('manifest assente: fonte vuota (nessun brano ricercabile), non un errore', async () => {
    mocks.list.mockResolvedValue({ blobs: STORE.slice(0, 2), hasMore: false });
    const result = await body(await request('caruso'));

    expect(result.sources.featured).toEqual({ status: 'empty', tracks: [] });
    expect(result.results.some((item) => item.kind === 'featured')).toBe(false);
  });

  it('con brani in evidenza la risposta resta in cache condivisa al massimo 1 minuto (revoca rapida)', async () => {
    const withFeatured = await request('caruso');
    expect((await body(withFeatured)).sources.featured?.status).toBe('results');
    expect(withFeatured.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');

    // Senza brani in evidenza pertinenti valgono le regole di sempre.
    mocks.searchMusic.mockImplementation(async (source: 'audius' | 'youtube') =>
      sourceResult(source, source === 'audius' ? [audiusTrack('a2', 'Ambient', 'Altro')] : []),
    );
    const without = await request('ambient');
    expect((await body(without)).sources.featured?.status).toBe('empty');
    expect(without.headers.get('cache-control')).toBe(
      'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
    );
  });

  it('trova il brano con "Artista Titolo" (la query dei link di condivisione del player)', async () => {
    const result = await body(await request('Lucio Dalla Caruso'));
    expect(result.results[0]?.key).toBe(`featured:${DECLARED}`);
    expect(result.sources.featured?.tracks.map((track) => track.id)).toEqual([DECLARED]);
    expect(JSON.stringify(result)).not.toContain('Remastered');
  });

  it('elenca lo store una volta sola per più ricerche (indice in cache)', async () => {
    await request('caruso');
    await request('lucio');
    await request('dalla');
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
});
