// @polsia:user-owned — audio.com nella ricerca unificata: fonte SOLO con `audiocom=1` (i client di
// prima ricevono la risposta di sempre, nessuna chiamata ad audio.com), stato proprio
// (results/empty/unavailable/disconnected), tempo massimo che non blocca le altre fonti, regole di
// cache (risposta pubblica condivisibile, breve se audio.com manca), ordinamento con
// relevanceScore e deduplica contro lo stesso brano su Audius / brani in evidenza / YouTube.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  searchMusic: vi.fn(),
  listStations: vi.fn(),
  searchPodcasts: vi.fn(),
  enforceRateLimit: vi.fn(),
  getRateLimitIdentity: vi.fn(),
  getSession: vi.fn(),
  searchFeaturedTracks: vi.fn(),
  searchAudioCom: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/music/music-api.server', () => ({ searchMusic: mocks.searchMusic }));
vi.mock('@/lib/music/radio-browser.server', () => ({ listStations: mocks.listStations }));
vi.mock('@/lib/music/podcasts.server', () => ({ searchPodcasts: mocks.searchPodcasts }));
vi.mock('@/lib/music/featured-search.server', () => ({
  searchFeaturedTracks: mocks.searchFeaturedTracks,
}));
vi.mock('@/lib/music/audiocom.server', () => ({ searchAudioCom: mocks.searchAudioCom }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: mocks.getRateLimitIdentity,
}));

import { GET } from '@/app/api/music/search-all/route';
import type { AudioComTrack } from '@/lib/contracts/audiocom';
import type { AudiusTrackSearchResult, YouTubeVideoSearchResult } from '@/lib/contracts/music';
import { UnifiedSearchResponseSchema } from '@/lib/contracts/unified-search';
import { rankUnifiedResults } from '@/lib/music/unified-search';

function request(query: string, params: Record<string, string> = {}) {
  const url = new URL('https://solco.test/api/music/search-all');
  url.searchParams.set('q', query);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return GET(new Request(url, { headers: { 'x-real-ip': '192.0.2.10' } }));
}

function audiocomTrack(id: string, overrides: Partial<AudioComTrack> = {}): AudioComTrack {
  return {
    id,
    title: `Canzone ${id}`,
    authorName: 'Autrice',
    pageUrl: `https://audio.com/autrice/audio/canzone-${id}`,
    imageUrl: null,
    streamUrl: `https://s3.audio.com/audio/${id}.mp3`,
    durationSeconds: 180,
    category: 'music',
    license: 'cc-by',
    ...overrides,
  };
}

function audiusTrack(id: string, title: string, artistName: string): AudiusTrackSearchResult {
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
  title: string,
  channelTitle: string,
): YouTubeVideoSearchResult {
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

beforeEach(() => {
  mocks.getSession.mockReset().mockResolvedValue(null);
  mocks.getRateLimitIdentity.mockReset().mockReturnValue('ip:192.0.2.10');
  mocks.enforceRateLimit.mockReset().mockResolvedValue(null);
  mocks.searchMusic
    .mockReset()
    .mockResolvedValue(audiusResult([audiusTrack('a1', 'Notturno', 'Altro Artista')]));
  mocks.listStations.mockReset().mockResolvedValue({ outcome: 'no_results', stations: [] });
  mocks.searchPodcasts.mockReset().mockResolvedValue({ outcome: 'no_results', podcasts: [] });
  mocks.searchFeaturedTracks.mockReset().mockResolvedValue({ outcome: 'no_results', tracks: [] });
  mocks.searchAudioCom.mockReset().mockResolvedValue({
    status: 'results',
    tracks: [
      audiocomTrack('1', { title: 'Notturno' }),
      audiocomTrack('2', { license: 'arr', streamUrl: null }),
    ],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('search-all con audio.com', () => {
  it('senza audiocom=1 la risposta è quella di sempre e audio.com non viene interrogato', async () => {
    const response = await request('notturno');
    const raw = await response.json();
    expect(mocks.searchAudioCom).not.toHaveBeenCalled();
    expect(raw.sources.audiocom).toBeUndefined();
    expect(raw.results.some((item: { kind: string }) => item.kind === 'audiocom')).toBe(false);
    // Un client di prima (schema senza `audiocom`) legge ancora tutto: nessun tipo sconosciuto.
    expect(UnifiedSearchResponseSchema.safeParse(raw).success).toBe(true);
  });

  it('con audiocom=1 aggiunge la sezione e le voci, con licenza e stream solo se riproducibile', async () => {
    const response = await request('notturno', { audiocom: '1' });
    const body = UnifiedSearchResponseSchema.parse(await response.json());
    // L'identità di chi cerca arriva alla quota personale di audio.com.
    expect(mocks.searchAudioCom).toHaveBeenCalledWith('notturno', { identity: 'ip:192.0.2.10' });
    expect(body.sources.audiocom?.status).toBe('results');
    expect(body.sources.audiocom?.tracks.map((track) => track.id)).toEqual(['1', '2']);
    const entries = body.results.filter((item) => item.kind === 'audiocom');
    expect(entries.map((item) => item.key)).toEqual(['audiocom:1', 'audiocom:2']);
    // Lo stesso titolo su Audius ma di un altro artista: non è un doppione, restano entrambi.
    expect(body.results.some((item) => item.key === 'audius:a1')).toBe(true);
    const arr = entries.find((item) => item.key === 'audiocom:2');
    expect(arr?.kind === 'audiocom' && arr.track.streamUrl).toBeNull();
    // Dati uguali per tutti: cache condivisa (non privata).
    expect(response.headers.get('cache-control')).toContain('s-maxage');
    expect(response.headers.get('cache-control')).not.toContain('private');
  });

  it.each([
    ['disconnected', 'public, max-age=0, s-maxage=60'],
    ['unavailable', 'public, max-age=0, s-maxage=60'],
  ] as const)('stato %s: nessuna voce, altre fonti intatte, cache breve', async (status, cache) => {
    mocks.searchAudioCom.mockResolvedValue({ status, tracks: [] });
    const response = await request('notturno', { audiocom: '1' });
    const body = UnifiedSearchResponseSchema.parse(await response.json());
    expect(body.sources.audiocom).toEqual({ status, tracks: [] });
    expect(body.sources.audius.status).toBe('results');
    expect(body.results.some((item) => item.kind === 'audius')).toBe(true);
    expect(response.headers.get('cache-control')).toBe(cache);
  });

  it('quota personale finita: audio.com "unavailable" e risposta privata (la CDN non la serve ad altri)', async () => {
    mocks.searchAudioCom.mockResolvedValue({
      status: 'unavailable',
      tracks: [],
      requesterLimited: true,
    });
    const response = await request('notturno', { audiocom: '1' });
    expect(response.status).toBe(200);
    const raw = await response.json();
    // Il segnale interno non finisce nella risposta: il contratto resta quello di sempre.
    expect(raw.sources.audiocom).toEqual({ status: 'unavailable', tracks: [] });
    expect(raw.sources.audius.status).toBe('results');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('senza identità affidabile la ricerca su audio.com riceve identity null', async () => {
    mocks.getRateLimitIdentity.mockReturnValue(null);
    await request('notturno', { audiocom: '1' });
    expect(mocks.searchAudioCom).toHaveBeenCalledWith('notturno', { identity: null });
  });

  it('audio.com lento: oltre il suo tempo massimo è "unavailable" e le altre fonti rispondono', async () => {
    vi.useFakeTimers();
    mocks.searchAudioCom.mockReturnValue(new Promise(() => undefined));
    const pending = request('notturno', { audiocom: '1' });
    await vi.advanceTimersByTimeAsync(7_100);
    const body = UnifiedSearchResponseSchema.parse(await (await pending).json());
    expect(body.sources.audiocom).toEqual({ status: 'unavailable', tracks: [] });
    expect(body.sources.audius.status).toBe('results');
  });

  it('un errore di audio.com non fa fallire la ricerca', async () => {
    mocks.searchAudioCom.mockRejectedValue(new Error('boom'));
    const response = await request('notturno', { audiocom: '1' });
    expect(response.status).toBe(200);
    const body = UnifiedSearchResponseSchema.parse(await response.json());
    expect(body.sources.audiocom?.status).toBe('unavailable');
  });
});

describe('ordinamento e deduplica con audio.com', () => {
  const base = { stations: [], podcasts: [], youtubeVideos: [] as YouTubeVideoSearchResult[] };

  it('lo stesso brano già su Audius non compare due volte (resta Audius)', () => {
    const results = rankUnifiedResults({
      ...base,
      query: 'notturno',
      audiusTracks: [audiusTrack('a1', 'Notturno', 'Anna Rossi')],
      audiocomTracks: [audiocomTrack('1', { title: 'Notturno', authorName: 'Anna Rossi' })],
    });
    expect(results.map((item) => item.key)).toEqual(['audius:a1']);
  });

  it('il gemello Audius NON riproducibile non nasconde la versione CC riproducibile di audio.com', () => {
    const blocked = {
      ...audiusTrack('a1', 'Alba sul mare', 'Anna Rossi'),
      playbackEligible: false,
    } as AudiusTrackSearchResult;
    const results = rankUnifiedResults({
      ...base,
      query: 'alba',
      audiusTracks: [blocked],
      audiocomTracks: [audiocomTrack('1', { title: 'Alba sul mare', authorName: 'Anna Rossi' })],
    });
    expect(results.map((item) => item.key).sort()).toEqual(['audiocom:1', 'audius:a1']);
  });

  it('query «Artista Titolo»: stessa scala di Audius, una voce solo-embed non supera un brano riproducibile', () => {
    const results = rankUnifiedResults({
      ...base,
      query: 'Anna Rossi Alba',
      audiusTracks: [audiusTrack('a1', 'Alba', 'Anna Rossi')],
      audiocomTracks: [
        audiocomTrack('emb', {
          title: 'Alba sul mare',
          authorName: 'Anna Rossi',
          license: 'arr',
          streamUrl: null,
        }),
      ],
    });
    expect(results.map((item) => [item.key, item.score])).toEqual([
      ['audius:a1', 0],
      ['audiocom:emb', 0],
    ]);
  });

  it('una cover CC BY si ordina come le voci solo-embed (non come le riproducibili)', () => {
    const results = rankUnifiedResults({
      ...base,
      query: 'luna',
      audiusTracks: [],
      audiocomTracks: [
        audiocomTrack('cov', {
          title: 'Luna',
          authorName: 'Tre',
          category: 'cover',
          streamUrl: null,
        }),
        audiocomTrack('cc', { title: 'Luna', authorName: 'Due' }),
      ],
      youtubeVideos: [youtubeVideo('vvvvvvvvvvv', 'Luna', 'Canale')],
    });
    expect(results.map((item) => item.key)).toEqual([
      'audiocom:cc',
      'youtube:vvvvvvvvvvv',
      'audiocom:cov',
    ]);
  });

  it('lo stesso brano su YouTube resta come alternativa della voce audio.com', () => {
    const results = rankUnifiedResults({
      ...base,
      query: 'notturno',
      audiusTracks: [],
      audiocomTracks: [audiocomTrack('1', { title: 'Notturno', authorName: 'Anna Rossi' })],
      youtubeVideos: [
        youtubeVideo('yyyyyyyyyyy', 'Anna Rossi - Notturno (Official Video)', 'Anna Rossi'),
      ],
    });
    expect(results).toHaveLength(1);
    const [entry] = results;
    expect(entry?.kind).toBe('audiocom');
    expect(entry?.kind === 'audiocom' && entry.youtubeAlternative?.videoId).toBe('yyyyyyyyyyy');
  });

  it('rilevanza con relevanceScore; a parità: Audius > audio.com riproducibile > YouTube > audio.com solo embed', () => {
    const results = rankUnifiedResults({
      ...base,
      query: 'luna',
      audiusTracks: [audiusTrack('a1', 'Luna', 'Uno')],
      audiocomTracks: [
        audiocomTrack('emb', { title: 'Luna', authorName: 'Tre', license: 'arr', streamUrl: null }),
        audiocomTrack('cc', { title: 'Luna', authorName: 'Due' }),
        audiocomTrack('far', { title: 'Canto della luna piena', authorName: 'Quattro' }),
      ],
      youtubeVideos: [youtubeVideo('vvvvvvvvvvv', 'Luna', 'Canale')],
    });
    expect(results.map((item) => item.key)).toEqual([
      'audius:a1',
      'audiocom:cc',
      'youtube:vvvvvvvvvvv',
      'audiocom:emb',
      'audiocom:far',
    ]);
    expect(results.find((item) => item.key === 'audiocom:cc')?.score).toBe(100);
    expect(results.find((item) => item.key === 'audiocom:far')?.score).toBe(40);
  });

  it('senza audiocomTracks l’ordine delle fonti di prima non cambia', () => {
    const results = rankUnifiedResults({
      ...base,
      query: 'luna',
      audiusTracks: [audiusTrack('a1', 'Luna', 'Uno')],
      youtubeVideos: [youtubeVideo('vvvvvvvvvvv', 'Luna', 'Canale')],
    });
    expect(results.map((item) => item.kind)).toEqual(['audius', 'youtube']);
  });

  it('doppioni di audio.com (stesso id) compaiono una volta sola', () => {
    const results = rankUnifiedResults({
      ...base,
      query: 'luna',
      audiusTracks: [],
      audiocomTracks: [audiocomTrack('1'), audiocomTrack('1')],
    });
    expect(results).toHaveLength(1);
  });
});
