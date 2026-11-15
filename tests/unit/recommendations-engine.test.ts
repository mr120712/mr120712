// @polsia:user-owned — motore di «Potrebbe piacerti» con database, Audius e AI simulati: legge solo i
// dati dell'utente (delle voci YouTube solo titolo e artista, per non riproporre un "song" già
// ascoltato), propone solo brani Audius riproducibili, mai brani caricati o «In evidenza», non cerca
// mai su YouTube, salva i candidati per 6 ore (senza i già ascoltati, con posti per community e
// tendenze), legge la community solo dalla classifica aggregata giornaliera, chiama l'AI solo per i
// Premium, al massimo una volta al giorno (in background) e solo con abbastanza tempo prima della
// fine della funzione, e senza AI risponde comunque.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudiusTrackSearchResult } from '@/lib/contracts/music';
import { RecommendationsResponseSchema } from '@/lib/contracts/recommendations';

const mocks = vi.hoisted(() => {
  const cache = new Map<string, { payload: unknown; generatedAt: Date }>();
  return {
    cache,
    imported: { songResolve: false, youtubeSearch: false, featured: false, publicUploads: false },
    background: [] as Promise<unknown>[],
    history: vi.fn(async (_query?: unknown): Promise<unknown[]> => []),
    items: vi.fn(async (_query?: unknown): Promise<unknown[]> => []),
    diary: vi.fn(async (): Promise<unknown[]> => []),
    hidden: vi.fn(async (): Promise<unknown[]> => []),
    hiddenUpsert: vi.fn(async () => ({})),
    hiddenDelete: vi.fn(async () => ({ count: 1 })),
    queryRaw: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
    communityRows: vi.fn(async (_query?: unknown): Promise<unknown[]> => []),
    communityDelete: vi.fn(async (_query?: unknown) => ({ count: 0 })),
    communityCreate: vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length })),
    transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
    searchAudius: vi.fn(),
    trending: vi.fn(),
    moodTracks: vi.fn(),
    getTrack: vi.fn(),
    premium: vi.fn(async () => false),
    consume: vi.fn(async () => ({ allowed: true })),
    release: vi.fn(async () => undefined),
    aiConfigured: vi.fn(() => true),
    suggest: vi.fn(),
  };
});

vi.mock('server-only', () => ({}));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (task: Promise<unknown>) => {
    mocks.background.push(task);
  },
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    userPlaybackHistory: { findMany: mocks.history },
    userMusicCollectionItem: { findMany: mocks.items },
    listeningEntry: { findMany: mocks.diary },
    recommendationHidden: {
      findMany: mocks.hidden,
      upsert: mocks.hiddenUpsert,
      deleteMany: mocks.hiddenDelete,
    },
    recommendationCache: {
      findUnique: async ({ where }: { where: { userId: string } }) => {
        const row = mocks.cache.get(where.userId);
        return row ? { userId: where.userId, ...row } : null;
      },
      upsert: async ({
        where,
        create,
      }: {
        where: { userId: string };
        create: { payload: unknown; generatedAt: Date };
      }) => {
        mocks.cache.set(where.userId, {
          payload: JSON.parse(JSON.stringify(create.payload)),
          generatedAt: create.generatedAt,
        });
        return {};
      },
      deleteMany: async () => ({ count: 0 }),
    },
    recommendationCommunity: {
      findMany: mocks.communityRows,
      deleteMany: mocks.communityDelete,
      createMany: mocks.communityCreate,
    },
    $queryRaw: mocks.queryRaw,
    $transaction: mocks.transaction,
  },
}));
vi.mock('@/lib/music/audius-source.server', () => ({
  getAudiusActivation: () => ({ active: true, blockers: [], apiKey: 'test-key' }),
  searchAudius: mocks.searchAudius,
  getAudiusTrending: mocks.trending,
  getAudiusMoodTracks: mocks.moodTracks,
}));
vi.mock('@/lib/music/audius-api.server', () => ({
  createAudiusApiClient: () => ({ getTrack: mocks.getTrack }),
}));
vi.mock('@/lib/music/audius', () => ({
  normalizeAudiusTracks: (payload: { data: AudiusTrackSearchResult[] }) => payload.data,
}));
vi.mock('@/lib/business/premium-access.server', () => ({ hasPremiumAccess: mocks.premium }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  consumeRateLimit: mocks.consume,
  releaseRateLimit: mocks.release,
}));
vi.mock('@/lib/music/recommendations-ai.server', () => ({
  aiRecommendationsConfigured: mocks.aiConfigured,
  suggestRecommendedSongs: mocks.suggest,
}));
// track-list-import.server (songSourceId) imports the collections module: not needed here.
vi.mock('@/lib/music/collections.server', () => ({ isFavoritesName: () => false }));
// Never part of the engine: no YouTube search, no featured or uploaded tracks.
vi.mock('@/lib/music/song-resolve.server', () => {
  mocks.imported.songResolve = true;
  return {};
});
vi.mock('@/lib/music/youtube-search.server', () => {
  mocks.imported.youtubeSearch = true;
  return {};
});
vi.mock('@/lib/music/featured-catalog.server', () => {
  mocks.imported.featured = true;
  return {};
});
vi.mock('@/lib/music/public-uploads.server', () => {
  mocks.imported.publicUploads = true;
  return {};
});

import { songSourceId } from '@/lib/business/track-list-import.server';
import {
  getRecommendations,
  hideRecommendation,
  resetRecommendationCommunityCacheForTests,
  unhideRecommendation,
} from '@/lib/music/recommendations.server';
import { refreshRecommendationCommunity } from '@/lib/music/recommendations-cache.server';

const NOW = new Date('2026-11-15T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function track(
  id: string,
  artistName: string,
  options: { playable?: boolean; genre?: string; mood?: string; handle?: string } = {},
): AudiusTrackSearchResult {
  const handle = options.handle ?? artistName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const playable = options.playable ?? true;
  return {
    provider: 'audius',
    id,
    qualifiedId: `audius:${id}`,
    title: `Brano ${id}`,
    artistName,
    artistHandle: handle,
    artistId: `artist-${handle}`,
    artistQualifiedId: `audius:artist-${handle}`,
    artistUrl: `https://audius.co/${handle}`,
    trackUrl: `https://audius.co/${handle}/brano-${id}`,
    artworkUrl: `https://audius.example/${id}.jpg`,
    durationSeconds: 200,
    genre: options.genre ?? 'Electronic',
    mood: options.mood ?? 'Upbeat',
    tags: null,
    releaseDate: null,
    license: null,
    licensorName: artistName,
    copyrightNotice: null,
    producerCopyrightNotice: null,
    attributionRemovalRequested: false,
    attributionComplete: true,
    playbackEligible: playable,
    playbackReason: playable ? 'ready' : 'license_not_allowed',
  };
}

const many = (prefix: string, count: number, artist = (index: number) => `${prefix} ${index}`) =>
  Array.from({ length: count }, (_, index) => track(`${prefix}${index}`, artist(index)));

function audiusHistory(id: string, artistName: string, handle: string, playCount = 3) {
  return {
    qualifiedId: `audius:${id}`,
    title: `Ascoltato ${id}`,
    artistName,
    sourceUrl: `https://audius.co/${handle}/ascoltato-${id}`,
    playCount,
    lastPlayedAt: new Date(NOW.getTime() - 2 * 24 * HOUR),
  };
}

async function flushBackground() {
  while (mocks.background.length > 0) await mocks.background.shift();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cache.clear();
  mocks.background.length = 0;
  resetRecommendationCommunityCacheForTests();
  mocks.history.mockResolvedValue([audiusHistory('h1', 'Alfa', 'alfa', 5)]);
  mocks.items.mockResolvedValue([]);
  mocks.diary.mockResolvedValue([]);
  mocks.hidden.mockResolvedValue([]);
  mocks.queryRaw.mockResolvedValue([]);
  mocks.communityRows.mockResolvedValue([]);
  mocks.searchAudius.mockResolvedValue({
    tracks: [
      track('h1', 'Alfa', { genre: 'Lo-Fi', mood: 'Peaceful' }),
      track('a2', 'Alfa', { genre: 'Lo-Fi', mood: 'Peaceful' }),
      track('a3', 'Alfa', { genre: 'Lo-Fi', mood: 'Peaceful' }),
      track('a4', 'Alfa', { genre: 'Lo-Fi', playable: false }),
      track('x1', 'Omonimo qualunque'),
    ],
    artists: [],
    outcome: 'results',
  });
  mocks.moodTracks.mockResolvedValue({
    tracks: [...many('g', 24), track('gb', 'Bloccato', { playable: false })],
    outcome: 'results',
  });
  mocks.trending.mockResolvedValue({ tracks: many('t', 6), outcome: 'results' });
  mocks.premium.mockResolvedValue(false);
  mocks.consume.mockResolvedValue({ allowed: true });
  mocks.aiConfigured.mockReturnValue(true);
  mocks.suggest.mockResolvedValue({ ok: true, songs: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('consigli personali', () => {
  it('dai propri ascolti: altri brani dell’artista, poi simili nel suo genere; solo riproducibili', async () => {
    const response = await getRecommendations('user-1', { page: 0, personal: true }, NOW);
    expect(RecommendationsResponseSchema.safeParse(response).success).toBe(true);
    expect(response.mode).toBe('personal');
    expect(response.items.length).toBeGreaterThanOrEqual(12);
    expect(response.items.length).toBeLessThanOrEqual(16);
    const ids = response.items.map((item) => item.qualifiedId);
    // Già ascoltato, non riproducibile, omonimo trovato per caso: mai.
    expect(ids).not.toContain('audius:h1');
    expect(ids).not.toContain('audius:a4');
    expect(ids).not.toContain('audius:gb');
    expect(ids.filter((id) => id === 'audius:a2' || id === 'audius:a3')).toHaveLength(2);
    const reasons = new Set(response.items.map((item) => item.reason.text));
    expect(reasons).toContain('Perché hai ascoltato Alfa');
    // Brani popolari nel genere di Alfa: il motivo non promette una somiglianza mai verificata.
    expect(reasons).toContain('Popolare nel genere di Alfa');
    expect([...reasons].some((text) => text.startsWith('Simile a'))).toBe(false);
    // Genere scoperto dai brani dell'artista: una sola ricerca canonica, riusabile dalla cache Audius.
    expect(mocks.moodTracks).toHaveBeenCalledWith({ moods: [], genres: ['Lo-Fi'], limit: 100 });
    expect(mocks.searchAudius).toHaveBeenCalledWith('Alfa');
    for (const item of response.items) {
      if (item.kind === 'audius') expect(item.playbackEligible).toBe(true);
    }
  });

  it('legge solo gli ascolti Audius/Jamendo dell’utente e solo brani Audius/"song" della sua Libreria', async () => {
    await getRecommendations('user-1', { page: 0, personal: true }, NOW);
    const historyQuery = mocks.history.mock.calls[0]?.[0] as unknown as {
      where: { userId: string; OR: unknown[] };
    };
    expect(historyQuery.where.userId).toBe('user-1');
    expect(historyQuery.where.OR).toEqual([
      { qualifiedId: { startsWith: 'audius:' } },
      { qualifiedId: { startsWith: 'jamendo:' } },
    ]);
    const itemsQuery = mocks.items.mock.calls[0]?.[0] as unknown as {
      where: { source: { in: string[] }; collection: { userId: string } };
    };
    expect(itemsQuery.where).toEqual({
      source: { in: ['audius', 'song'] },
      collection: { userId: 'user-1' },
    });
  });

  it('esclude i brani già in Libreria e quelli segnati «Non mi interessa»', async () => {
    mocks.items.mockResolvedValue([
      {
        source: 'audius',
        sourceId: 'a2',
        creatorName: 'Alfa',
        sourceUrl: null,
        collection: { kind: 'favorites', spotifySource: null },
      },
    ]);
    mocks.hidden.mockResolvedValue([{ itemKey: 'audius:a3' }]);
    const response = await getRecommendations('user-1', { page: 0, personal: true }, NOW);
    const ids = response.items.map((item) => item.qualifiedId);
    expect(ids).not.toContain('audius:a2');
    expect(ids).not.toContain('audius:a3');
  });

  it('community: solo la classifica aggregata giornaliera (mai tutta la cronologia), riverificata su Audius', async () => {
    mocks.communityRows.mockResolvedValue([
      { qualifiedId: 'audius:c1' },
      { qualifiedId: 'upload:clxfeaturedtrack0000001' },
    ]);
    mocks.getTrack.mockResolvedValue({ data: [track('c1', 'Comunità', { genre: 'Lo-Fi' })] });
    const before = Date.now();
    const response = await getRecommendations('user-1', { page: 0, personal: true }, NOW);
    // Nessuna lettura di tutta la cronologia durante la richiesta: solo la tabella piccola.
    expect(mocks.queryRaw).not.toHaveBeenCalled();
    const query = mocks.communityRows.mock.calls[0]?.[0] as {
      where: { computedAt: { gte: Date } };
      orderBy: unknown;
      take: number;
    };
    expect(query.take).toBe(8);
    expect(query.orderBy).toEqual([{ listeners: 'desc' }, { qualifiedId: 'asc' }]);
    // Classifica ferma da più di 3 giorni (pulizia non partita): non si usa.
    expect(query.where.computedAt.gte.getTime()).toBeGreaterThanOrEqual(before - 3 * 24 * HOUR);
    expect(query.where.computedAt.gte.getTime()).toBeLessThanOrEqual(Date.now() - 3 * 24 * HOUR);
    // Solo l'id Audius valido viene riverificato; mai un brano caricato.
    expect(mocks.getTrack).toHaveBeenCalledTimes(1);
    expect(mocks.getTrack).toHaveBeenCalledWith('c1');
    const community = response.items.find((item) => item.qualifiedId === 'audius:c1');
    expect(community?.reason.text).toBe('Piace alla community');
  });

  it('mai brani caricati o «In evidenza», mai ricerche YouTube', async () => {
    mocks.history.mockResolvedValue([
      audiusHistory('h1', 'Alfa', 'alfa'),
      // Anche se il database ne restituisse una, una voce caricata non diventa né seme né consiglio.
      {
        qualifiedId: 'upload:clxfeaturedtrack0000001',
        title: 'In evidenza',
        artistName: 'Admin',
        sourceUrl: null,
        playCount: 99,
        lastPlayedAt: NOW,
      },
    ]);
    const response = await getRecommendations('user-1', { page: 0, personal: true }, NOW);
    expect(response.items.every((item) => /^(audius|song):/.test(item.qualifiedId))).toBe(true);
    expect(mocks.searchAudius).not.toHaveBeenCalledWith('Admin');
    expect(mocks.imported).toEqual({
      songResolve: false,
      youtubeSearch: false,
      featured: false,
      publicUploads: false,
    });
  });

  it('candidati in cache per 6 ore: «Altri consigli» e ricariche non richiamano Audius', async () => {
    const first = await getRecommendations('user-1', { page: 0, personal: true }, NOW);
    const calls = mocks.moodTracks.mock.calls.length + mocks.searchAudius.mock.calls.length;
    const again = await getRecommendations(
      'user-1',
      { page: 0, personal: true },
      new Date(NOW.getTime() + HOUR),
    );
    expect(again.items.map((item) => item.qualifiedId)).toEqual(
      first.items.map((item) => item.qualifiedId),
    );
    const next = await getRecommendations(
      'user-1',
      { page: 1, personal: true },
      new Date(NOW.getTime() + 2 * HOUR),
    );
    expect(next.page).toBe(1);
    expect(mocks.moodTracks.mock.calls.length + mocks.searchAudius.mock.calls.length).toBe(calls);
    await getRecommendations(
      'user-1',
      { page: 0, personal: true },
      new Date(NOW.getTime() + 7 * HOUR),
    );
    expect(
      mocks.moodTracks.mock.calls.length + mocks.searchAudius.mock.calls.length,
    ).toBeGreaterThan(calls);
  });

  it('già ascoltati tolti prima del taglio: community e tendenze restano nei candidati', async () => {
    // Due artisti molto ascoltati, di generi diversi: 20 brani ciascuno su Audius, 15 già ascoltati.
    mocks.history.mockResolvedValue([
      ...Array.from({ length: 15 }, (_, index) => audiusHistory(`alfa${index}`, 'Alfa', 'alfa', 2)),
      ...Array.from({ length: 15 }, (_, index) => audiusHistory(`beta${index}`, 'Beta', 'beta', 2)),
    ]);
    mocks.searchAudius.mockImplementation(async (name: string) => ({
      tracks: Array.from({ length: 20 }, (_, index) =>
        track(`${name.toLowerCase()}${index}`, name, {
          genre: name === 'Alfa' ? 'Electronic' : 'Lo-Fi',
        }),
      ),
      artists: [],
      outcome: 'results',
    }));
    mocks.moodTracks.mockImplementation(async ({ genres }: { genres: string[] }) => ({
      tracks: many(`g${(genres[0] ?? 'x').slice(0, 2)}`, 100),
      outcome: 'results',
    }));
    mocks.communityRows.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => ({ qualifiedId: `audius:c${index}` })),
    );
    mocks.getTrack.mockImplementation(async (id: string) => ({
      data: [track(id, `Comunità ${id}`)],
    }));
    mocks.trending.mockResolvedValue({ tracks: many('t', 20), outcome: 'results' });

    await getRecommendations('user-1', { page: 0, personal: true }, NOW);
    const stored = mocks.cache.get('user-1')?.payload as {
      entries: { source: string; item: { qualifiedId: string } }[];
    };
    const count = (source: string) =>
      stored.entries.filter((entry) => entry.source === source).length;
    expect(count('community')).toBe(8);
    expect(count('trending')).toBe(20);
    expect(count('artist')).toBe(10);
    // Nessun posto sprecato per brani già ascoltati.
    const ids = new Set(stored.entries.map((entry) => entry.item.qualifiedId));
    for (let index = 0; index < 15; index += 1) {
      expect(ids.has(`audius:alfa${index}`)).toBe(false);
      expect(ids.has(`audius:beta${index}`)).toBe(false);
    }
  });

  it('Audius non raggiungibile: nessuna cache salvata, si riprova alla richiesta dopo', async () => {
    mocks.searchAudius.mockRejectedValue(new Error('down'));
    mocks.moodTracks.mockResolvedValue({ tracks: [], outcome: 'unavailable' });
    mocks.trending.mockResolvedValue({ tracks: [], outcome: 'unavailable' });
    const response = await getRecommendations('user-1', { page: 0, personal: true }, NOW);
    expect(response.items).toEqual([]);
    expect(mocks.cache.size).toBe(0);
  });
});

describe('gusti di nicchia', () => {
  it('pochi candidati: salvati lo stesso, ma rifatti dopo 30 minuti invece di 6 ore', async () => {
    mocks.moodTracks.mockResolvedValue({ tracks: [], outcome: 'no_results' });
    mocks.trending.mockResolvedValue({ tracks: many('t', 3), outcome: 'results' });
    const first = await getRecommendations('user-1', { page: 0, personal: true }, NOW);
    expect(first.items.length).toBeGreaterThan(0);
    expect(mocks.cache.size).toBe(1);
    const calls = mocks.searchAudius.mock.calls.length;
    await getRecommendations(
      'user-1',
      { page: 0, personal: true },
      new Date(NOW.getTime() + 10 * 60_000),
    );
    expect(mocks.searchAudius.mock.calls.length).toBe(calls);
    await getRecommendations(
      'user-1',
      { page: 0, personal: true },
      new Date(NOW.getTime() + 40 * 60_000),
    );
    expect(mocks.searchAudius.mock.calls.length).toBeGreaterThan(calls);
  });
});

describe('partenza a freddo e consigli spenti', () => {
  it('senza ascolti: «Per iniziare» con community e tendenze', async () => {
    mocks.history.mockResolvedValue([]);
    const response = await getRecommendations('user-new', { page: 0, personal: true }, NOW);
    expect(response.mode).toBe('starter');
    expect(response.items.length).toBeGreaterThan(0);
    expect(response.items.every((item) => item.reason.text === 'Di tendenza su Audius')).toBe(true);
    expect(mocks.searchAudius).not.toHaveBeenCalled();
    expect(mocks.cache.size).toBe(0);
  });

  it('consigli personalizzati spenti: «Popolari su Solco», senza leggere ascolti, Libreria o diario', async () => {
    mocks.hidden.mockResolvedValue([{ itemKey: 'audius:t0' }]);
    const response = await getRecommendations('user-1', { page: 0, personal: false }, NOW);
    expect(response.mode).toBe('popular');
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.items).not.toHaveBeenCalled();
    expect(mocks.diary).not.toHaveBeenCalled();
    expect(response.items.map((item) => item.qualifiedId)).not.toContain('audius:t0');
    expect(mocks.suggest).not.toHaveBeenCalled();
    expect(mocks.cache.size).toBe(0);
  });
});

describe('suggerimenti AI', () => {
  const songs = [
    {
      qualifiedId: `song:${'a'.repeat(32)}`,
      title: 'Canzone AI',
      artistName: 'Nuovo Artista',
      seedArtist: 'Alfa',
    },
  ];

  it('mai per un account Free', async () => {
    await getRecommendations('user-1', { page: 0, personal: true }, NOW);
    await flushBackground();
    expect(mocks.premium).toHaveBeenCalledWith('user-1');
    expect(mocks.suggest).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('Premium: una sola chiamata al giorno, in background, con i soli nomi degli artisti; poi dalla cache', async () => {
    mocks.premium.mockResolvedValue(true);
    mocks.suggest.mockResolvedValue({ ok: true, songs });
    mocks.items.mockResolvedValue([
      // Importato da Spotify: non va mai all'AI.
      {
        source: 'song',
        sourceId: 'b'.repeat(32),
        creatorName: 'Artista Spotify',
        sourceUrl: 'https://open.spotify.com/track/xyz',
        collection: { kind: 'playlist', spotifySource: 'saved' },
      },
    ]);
    const first = await getRecommendations('user-1', { page: 0, personal: true }, NOW);
    expect(first.items.some((item) => item.kind === 'song')).toBe(false);
    await flushBackground();
    expect(mocks.suggest).toHaveBeenCalledTimes(1);
    const input = mocks.suggest.mock.calls[0]?.[0] as { artists: string[]; genres: string[] };
    expect(input.artists).toEqual(['Alfa']);
    expect(input.genres).toEqual(['Lo-Fi']);
    expect(mocks.consume).toHaveBeenCalledWith('music.recommendations.ai', 'user:user-1');
    expect(mocks.consume).toHaveBeenCalledWith('music.recommendations.ai.global', 'global');
    // Solo il tempo che resta alla richiesta (entro 50 s dall'inizio, funzione da 60 s).
    const { timeoutMs } = mocks.suggest.mock.calls[0]?.[2] as { timeoutMs: number };
    expect(timeoutMs).toBeGreaterThanOrEqual(15_000);
    expect(timeoutMs).toBeLessThanOrEqual(50_000);

    const later = await getRecommendations(
      'user-1',
      { page: 0, personal: true },
      new Date(NOW.getTime() + HOUR),
    );
    const song = later.items.find((item) => item.kind === 'song');
    expect(song).toMatchObject({
      qualifiedId: `song:${'a'.repeat(32)}`,
      title: 'Canzone AI',
      artistName: 'Nuovo Artista',
      reason: { kind: 'ai', text: 'Suggerito dall’AI, simile a Alfa' },
    });

    // Candidati rifatti nello stesso giorno: nessuna nuova chiamata AI.
    await getRecommendations(
      'user-1',
      { page: 0, personal: true },
      new Date(NOW.getTime() + 7 * HOUR),
    );
    await flushBackground();
    expect(mocks.suggest).toHaveBeenCalledTimes(1);

    // Il giorno dopo: di nuovo una (se il limite di 24 ore lo consente).
    await getRecommendations(
      'user-1',
      { page: 0, personal: true },
      new Date(NOW.getTime() + 26 * HOUR),
    );
    await flushBackground();
    expect(mocks.suggest).toHaveBeenCalledTimes(2);
  });

  it('limite giornaliero già usato: nessuna chiamata', async () => {
    mocks.premium.mockResolvedValue(true);
    mocks.consume.mockResolvedValueOnce({ allowed: false });
    await getRecommendations('user-1', { page: 0, personal: true }, NOW);
    await flushBackground();
    expect(mocks.suggest).not.toHaveBeenCalled();
  });

  it('tetto dell’app raggiunto: restituisce il posto dell’utente e non chiama', async () => {
    mocks.premium.mockResolvedValue(true);
    mocks.consume
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false });
    await getRecommendations('user-1', { page: 0, personal: true }, NOW);
    await flushBackground();
    expect(mocks.suggest).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith('music.recommendations.ai', 'user:user-1');
  });

  it('AI occupata o non configurata: i consigli Audius arrivano comunque e il limite non si consuma', async () => {
    mocks.premium.mockResolvedValue(true);
    mocks.suggest.mockResolvedValue({ ok: false, error: 'busy' });
    const response = await getRecommendations('user-1', { page: 0, personal: true }, NOW);
    await flushBackground();
    expect(response.items.length).toBeGreaterThan(0);
    expect(mocks.release).toHaveBeenCalledWith('music.recommendations.ai', 'user:user-1');
    expect(mocks.release).toHaveBeenCalledWith('music.recommendations.ai.global', 'global');

    mocks.aiConfigured.mockReturnValue(false);
    mocks.cache.clear();
    mocks.suggest.mockClear();
    await getRecommendations('user-2', { page: 0, personal: true }, NOW);
    await flushBackground();
    expect(mocks.suggest).not.toHaveBeenCalled();
  });

  it('poco tempo rimasto alla richiesta (Audius lento): l’AI non parte e il limite non si consuma', async () => {
    mocks.premium.mockResolvedValue(true);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mocks.moodTracks.mockImplementation(async () => {
      // Le fonti Audius hanno già usato 40 s della funzione.
      vi.setSystemTime(new Date(Date.now() + 40_000));
      return { tracks: many('g', 24), outcome: 'results' };
    });
    const response = await getRecommendations('user-1', { page: 0, personal: true }, NOW);
    await flushBackground();
    expect(response.items.length).toBeGreaterThan(0);
    expect(mocks.suggest).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('tempo finito mentre si controllano i limiti: limiti restituiti, nessuna chiamata', async () => {
    mocks.premium.mockResolvedValue(true);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mocks.consume.mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + 20_000));
      return { allowed: true };
    });
    await getRecommendations('user-1', { page: 0, personal: true }, NOW);
    await flushBackground();
    expect(mocks.suggest).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith('music.recommendations.ai', 'user:user-1');
    expect(mocks.release).toHaveBeenCalledWith('music.recommendations.ai.global', 'global');
  });

  it('cache cancellata mentre l’AI lavora (es. «Cancella cronologia»): non viene ricreata', async () => {
    mocks.premium.mockResolvedValue(true);
    let finish: (value: unknown) => void = () => undefined;
    mocks.suggest.mockImplementation(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    await getRecommendations('user-1', { page: 0, personal: true }, NOW);
    expect(mocks.cache.has('user-1')).toBe(true);
    mocks.cache.delete('user-1');
    finish({ ok: true, songs });
    await flushBackground();
    expect(mocks.cache.has('user-1')).toBe(false);
  });

  it('un suggerimento AI ascoltato (nel player diventa un video YouTube) non viene riproposto', async () => {
    const real = {
      qualifiedId: `song:${songSourceId('Real Song', 'Gamma')}`,
      title: 'Real Song',
      artistName: 'Gamma',
      seedArtist: 'Alfa',
    };
    mocks.premium.mockResolvedValue(true);
    mocks.suggest.mockResolvedValue({ ok: true, songs: [real] });
    await getRecommendations('user-1', { page: 0, personal: true }, NOW);
    await flushBackground();
    const pages = async (at: Date) => {
      const ids: string[] = [];
      for (let page = 0; page < 6; page += 1) {
        const response = await getRecommendations('user-1', { page, personal: true }, at);
        ids.push(...response.items.map((item) => item.qualifiedId));
      }
      return ids;
    };
    expect(await pages(new Date(NOW.getTime() + HOUR / 2))).toContain(real.qualifiedId);

    // Il player lo ha risolto e registrato come youtube:<video> con titolo e artista del suggerimento.
    mocks.history.mockImplementation(async (query?: unknown) => {
      const where = (query as { where: { qualifiedId?: { startsWith?: string } } }).where;
      return where.qualifiedId?.startsWith === 'youtube:'
        ? [{ title: 'Real Song', artistName: 'Gamma' }]
        : [audiusHistory('h1', 'Alfa', 'alfa', 5)];
    });
    expect(await pages(new Date(NOW.getTime() + HOUR))).not.toContain(real.qualifiedId);

    // Delle voci YouTube si leggono solo titolo e artista, solo quelle ancora valide (28 giorni):
    // la prima lettura è quella della richiesta delle 10:00 (NOW).
    const youtubeQuery = mocks.history.mock.calls
      .map((call) => call[0] as { where: Record<string, unknown>; select: unknown })
      .find(
        (query) => (query.where.qualifiedId as { startsWith?: string })?.startsWith === 'youtube:',
      );
    expect(youtubeQuery?.select).toEqual({ title: true, artistName: true });
    expect((youtubeQuery?.where.lastPlayedAt as { gte: Date }).gte.getTime()).toBe(
      NOW.getTime() - 28 * 24 * HOUR,
    );
    // Mai nel gusto né all'AI: l'AI ha ricevuto solo gli artisti degli ascolti Audius.
    for (const call of mocks.suggest.mock.calls) {
      expect((call[0] as { artists: string[] }).artists).not.toContain('Gamma');
    }
  });

  it('un suggerimento AI già ascoltato o già in Libreria non viene riproposto', async () => {
    mocks.premium.mockResolvedValue(true);
    mocks.suggest.mockResolvedValue({ ok: true, songs });
    await getRecommendations('user-1', { page: 0, personal: true }, NOW);
    await flushBackground();
    mocks.items.mockResolvedValue([
      {
        source: 'song',
        sourceId: 'a'.repeat(32),
        creatorName: 'Nuovo Artista',
        sourceUrl: null,
        collection: { kind: 'playlist', spotifySource: null },
      },
    ]);
    const response = await getRecommendations(
      'user-1',
      { page: 0, personal: true },
      new Date(NOW.getTime() + HOUR),
    );
    expect(response.items.some((item) => item.kind === 'song')).toBe(false);
  });
});

describe('classifica della community (pulizia giornaliera)', () => {
  it('solo conteggi aggregati (almeno 3 persone), solo Audius; sostituisce la classifica di prima', async () => {
    mocks.queryRaw.mockResolvedValue([
      { qualifiedId: 'audius:c1', listeners: 5n },
      { qualifiedId: 'upload:clxfeaturedtrack0000001', listeners: 9 },
    ]);
    const result = await refreshRecommendationCommunity(NOW);
    const sql = (mocks.queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join('?');
    // Nessun utente nel risultato: solo il brano e quante persone diverse.
    expect(sql).toMatch(
      /SELECT "qualifiedId", COUNT\(DISTINCT "userId"\)::int AS listeners\s+FROM/,
    );
    expect(sql).toContain(`LIKE 'audius:%'`);
    expect(mocks.queryRaw.mock.calls[0]).toContain(3);
    expect(mocks.communityDelete).toHaveBeenCalledWith({});
    expect(mocks.communityCreate).toHaveBeenCalledWith({
      data: [{ qualifiedId: 'audius:c1', listeners: 5, computedAt: NOW }],
    });
    expect(result).toEqual({ count: 1 });
  });

  it('errore del database: nessun throw, la classifica di prima resta', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.queryRaw.mockRejectedValueOnce(new Error('db down'));
    await expect(refreshRecommendationCommunity(NOW)).resolves.toEqual({ count: 0 });
    expect(mocks.communityDelete).not.toHaveBeenCalled();
  });
});

describe('«Non mi interessa»', () => {
  it('salva il brano e dimentica i più vecchi oltre i 300', async () => {
    mocks.hidden.mockResolvedValueOnce([{ id: 'old-1' }, { id: 'old-2' }]);
    await hideRecommendation('user-1', 'audius:x1');
    expect(mocks.hiddenUpsert).toHaveBeenCalledWith({
      where: { userId_itemKey: { userId: 'user-1', itemKey: 'audius:x1' } },
      create: { userId: 'user-1', itemKey: 'audius:x1' },
      update: {},
    });
    expect(mocks.hidden).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' }, skip: 300 }),
    );
    expect(mocks.hiddenDelete).toHaveBeenCalledWith({
      where: { userId: 'user-1', id: { in: ['old-1', 'old-2'] } },
    });
  });

  it('«Annulla» toglie solo quel brano di quell’utente', async () => {
    await unhideRecommendation('user-1', `song:${'c'.repeat(32)}`);
    expect(mocks.hiddenDelete).toHaveBeenCalledWith({
      where: { userId: 'user-1', itemKey: `song:${'c'.repeat(32)}` },
    });
  });
});
