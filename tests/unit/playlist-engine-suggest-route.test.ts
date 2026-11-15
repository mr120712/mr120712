// @polsia:user-owned — POST /api/music/playlist-engine/suggest: i tre modi, la parte senza AI per
// tutti, l'AI solo per Premium (con i suoi limiti), nessuna ricerca YouTube in fase di creazione e
// nessun brano in evidenza.
// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: vi.fn(async () => ({ id: 'u1' }) as { id: string } | null),
  sameOrigin: vi.fn(() => true),
  limited: vi.fn(async (_action: string, _identity: string | null) => null as Response | null),
  premium: vi.fn(async () => false),
  aiConfigured: vi.fn(() => true),
  aiAvailable: vi.fn(async () => true),
  access: vi.fn(async () => ({ signedIn: true, premium: false })),
  ai: vi.fn(),
  moodTracks: vi.fn(),
  searchAudius: vi.fn(),
  resolveSong: vi.fn(),
  youtubeSearch: vi.fn(),
  featured: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ getSessionUser: mocks.user }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.limited,
  getRateLimitIdentity: (id: string) => `user:${id}`,
}));
vi.mock('@/lib/business/premium-access.server', () => ({
  hasPremiumAccess: mocks.premium,
  currentAccess: mocks.access,
}));
vi.mock('@/lib/business/playlist-engine-ai.server', () => ({
  suggestSongsWithAi: mocks.ai,
  playlistAiConfigured: mocks.aiConfigured,
  playlistAiAvailable: mocks.aiAvailable,
}));
vi.mock('@/lib/music/audius-source.server', () => ({
  getAudiusMoodTracks: mocks.moodTracks,
  searchAudius: mocks.searchAudius,
  getAudiusActivation: () => ({ active: true, blockers: [], apiKey: 'k' }),
}));
vi.mock('@/lib/music/collections.server', () => ({
  MAX_PLAYLISTS_PER_USER: 100,
  MAX_ITEMS_PER_COLLECTION: 500,
  isFavoritesName: (name: string) => name.trim().toLowerCase() === 'preferiti',
}));
vi.mock('@/lib/db', () => ({ prisma: {} }));
// Il resolver YouTube e i brani in evidenza non devono mai essere toccati da questa route.
vi.mock('@/lib/music/song-resolve.server', () => ({
  searchSong: mocks.resolveSong,
  peekSongResolution: mocks.resolveSong,
}));
vi.mock('@/lib/music/youtube-search.server', () => ({ searchYouTube: mocks.youtubeSearch }));
vi.mock('@/lib/music/featured-search.server', () => ({ searchFeatured: mocks.featured }));

import { GET } from '@/app/api/music/playlist-engine/route';
import { POST } from '@/app/api/music/playlist-engine/suggest/route';
import { audiusToDraft, verifyAudiusTrack } from '@/lib/business/playlist-engine.server';
import { songSourceId } from '@/lib/business/track-list-import.server';
import { type DraftTrack, SuggestResponseSchema } from '@/lib/contracts/playlist-engine';

const fetchSpy = vi.fn(async () => {
  throw new Error('nessuna rete nei test');
});

beforeAll(() => {
  vi.stubEnv('BETTER_AUTH_SECRET', 'segreto-di-prova-per-le-firme');
  vi.stubGlobal('fetch', fetchSpy);
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function audius(id: string, artist: string, extra: Record<string, unknown> = {}) {
  return {
    provider: 'audius',
    id,
    qualifiedId: `audius:${id}`,
    title: `Brano ${id}`,
    artistName: artist,
    artistHandle: artist.toLowerCase(),
    artistId: `artist-${artist}`,
    artistQualifiedId: `audius:artist-${artist}`,
    artistUrl: `https://audius.co/${artist.toLowerCase()}`,
    trackUrl: `https://audius.co/${artist.toLowerCase()}/${id}`,
    artworkUrl: `https://audius.co/art/${id}.jpg`,
    durationSeconds: 200,
    genre: 'Jazz',
    mood: 'Peaceful',
    tags: null,
    releaseDate: null,
    license: null,
    licensorName: artist,
    copyrightNotice: null,
    producerCopyrightNotice: null,
    attributionRemovalRequested: false,
    attributionComplete: true,
    playbackEligible: true,
    playbackReason: 'ready',
    ...extra,
  };
}

const post = (body: unknown) =>
  POST(
    new Request('https://solco.test/api/music/playlist-engine/suggest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://solco.test' },
      body: JSON.stringify(body),
    }),
  );

async function okBody(response: Response) {
  expect(response.status).toBe(200);
  return SuggestResponseSchema.parse(await response.json());
}

const aiSongs = {
  ok: true,
  name: 'Cena d’estate',
  description: 'Brani solari.',
  songs: [
    { title: 'Azzurro', artist: 'Adriano Celentano' },
    { title: 'Sapore di sale', artist: 'Gino Paoli' },
    { title: 'Il cielo in una stanza', artist: 'Mina' },
  ],
};

beforeEach(() => {
  mocks.user.mockReset().mockResolvedValue({ id: 'u1' });
  mocks.sameOrigin.mockReset().mockReturnValue(true);
  mocks.limited.mockReset().mockResolvedValue(null);
  mocks.premium.mockReset().mockResolvedValue(false);
  mocks.aiConfigured.mockReset().mockReturnValue(true);
  mocks.ai.mockReset().mockResolvedValue(aiSongs);
  mocks.moodTracks.mockReset().mockResolvedValue({
    outcome: 'results',
    tracks: [
      audius('a1', 'Uno'),
      audius('a2', 'Uno'),
      audius('a3', 'Uno'),
      audius('b1', 'Due'),
      audius('x1', 'Chiuso', { playbackEligible: false, playbackReason: 'license_not_allowed' }),
      audius('x2', 'Riservato', { license: 'All rights reserved' }),
      audius('c1', 'Tre'),
    ],
  });
  mocks.searchAudius.mockReset().mockResolvedValue({ outcome: 'results', tracks: [], artists: [] });
  mocks.resolveSong.mockReset();
  mocks.youtubeSearch.mockReset();
  mocks.featured.mockReset();
  fetchSpy.mockClear();
});

function expectNoYouTubeNorFeatured() {
  expect(mocks.resolveSong).not.toHaveBeenCalled();
  expect(mocks.youtubeSearch).not.toHaveBeenCalled();
  expect(mocks.featured).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
}

describe('Scegli l’atmosfera (senza AI, per tutti)', () => {
  it('propone solo brani Audius riproducibili con licenza aperta, vari e firmati', async () => {
    const body = await okBody(await post({ mode: 'mood', mood: 'relax', count: 10 }));
    expect(body.tracks.map((track) => track.sourceId)).toEqual(['a1', 'a2', 'b1', 'c1', 'a3']);
    expect(body.tracks.every((track) => track.source === 'audius')).toBe(true);
    expect(body.name).toBe('Atmosfera Relax');
    expect(body.ai).toEqual({ status: 'not_requested', message: null });
    expect(mocks.moodTracks).toHaveBeenCalledWith({
      moods: ['Peaceful', 'Easygoing', 'Tender'],
      genres: ['Ambient', 'Lo-Fi', 'Downtempo', 'Acoustic'],
      limit: 100,
    });
    // L'AI non è stata chiesta: né Premium, né limiti AI, né Claude.
    expect(mocks.premium).not.toHaveBeenCalled();
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.limited).toHaveBeenCalledTimes(1);
    expect(mocks.limited).toHaveBeenCalledWith('playlist.engine.suggest', 'user:u1');
    const first = body.tracks[0] as Extract<DraftTrack, { source: 'audius' }>;
    expect(verifyAudiusTrack('u1', first)).toBe(true);
    expect(verifyAudiusTrack('altro', first)).toBe(false);
    expectNoYouTubeNorFeatured();
  });

  it('divide bozza e scorte ed esclude i brani già in bozza', async () => {
    const body = await okBody(
      await post({
        mode: 'mood',
        genre: 'Jazz',
        count: 2,
        exclude: [{ source: 'audius', sourceId: 'a1', title: 'Brano a1', artist: 'Uno' }],
      }),
    );
    // Escluso a1, l'artista Uno ha ancora due posti: a2 e a3, poi gli altri artisti.
    expect(body.tracks.map((track) => track.sourceId)).toEqual(['a2', 'a3']);
    expect(body.reserve.map((track) => track.sourceId)).toEqual(['b1', 'c1']);
    expect(mocks.moodTracks).toHaveBeenCalledWith({ moods: [], genres: ['Jazz'], limit: 100 });
  });

  it('un utente Free che chiede l’AI riceve comunque i brani Audius, con la spiegazione', async () => {
    const body = await okBody(await post({ mode: 'mood', mood: 'notte', useAi: true, count: 10 }));
    expect(body.tracks.length).toBeGreaterThan(0);
    expect(body.ai.status).toBe('premium_required');
    expect(body.ai.message).toContain('Premium');
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.limited).not.toHaveBeenCalledWith('playlist.engine.ai', 'user:u1');
  });

  it('con Premium l’AI arricchisce: prima il catalogo, poi alterna i "song"', async () => {
    mocks.premium.mockResolvedValue(true);
    const body = await okBody(await post({ mode: 'mood', mood: 'relax', useAi: true, count: 6 }));
    expect(body.tracks.map((track) => track.source)).toEqual([
      'audius',
      'song',
      'audius',
      'song',
      'audius',
      'song',
    ]);
    expect(body.ai.status).toBe('used');
    expect(body.name).toBe('Cena d’estate');
    expect(mocks.limited).toHaveBeenCalledWith('playlist.engine.ai', 'user:u1');
    expect(mocks.limited).toHaveBeenCalledWith('playlist.engine.ai.global', 'global');
    expectNoYouTubeNorFeatured();
  });

  it('catalogo irraggiungibile: nessun brano e una spiegazione', async () => {
    mocks.moodTracks.mockResolvedValueOnce({ outcome: 'unavailable', tracks: [] });
    const body = await okBody(await post({ mode: 'mood', mood: 'relax', count: 10 }));
    expect(body.tracks).toEqual([]);
    expect(body.notice).toContain('non risponde');
  });

  it('senza atmosfera né genere: errore sul campo', async () => {
    const response = await post({ mode: 'mood', count: 10 });
    expect(response.status).toBe(400);
    expect((await response.json()).errors.mood).toBe('Scegli un’atmosfera o un genere.');
  });
});

describe('Descrivila con parole tue (solo con l’AI)', () => {
  it('un utente Free riceve 402: Claude non viene chiamato e i limiti AI non si consumano', async () => {
    const response = await post({ mode: 'describe', prompt: 'cena d’estate', count: 10 });
    expect(response.status).toBe(402);
    expect((await response.json()).error).toBe('premium_required');
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.limited).not.toHaveBeenCalledWith('playlist.engine.ai', 'user:u1');
  });

  it('con Premium restituisce "song" come l’importazione di un elenco, senza YouTube', async () => {
    mocks.premium.mockResolvedValue(true);
    const body = await okBody(await post({ mode: 'describe', prompt: 'cena d’estate', count: 2 }));
    expect(body.tracks).toEqual([
      {
        source: 'song',
        sourceId: songSourceId('Azzurro', 'Adriano Celentano'),
        title: 'Azzurro',
        creatorName: 'Adriano Celentano',
        artworkUrl: null,
        sourceUrl: null,
        artistUrl: null,
        durationSeconds: null,
      },
      expect.objectContaining({ source: 'song', title: 'Sapore di sale' }),
    ]);
    expect(body.reserve.map((track) => track.title)).toEqual(['Il cielo in una stanza']);
    expect(mocks.ai).toHaveBeenCalledWith(
      { kind: 'describe', prompt: 'cena d’estate' },
      expect.objectContaining({ count: 2, spare: 2, exclude: [] }),
    );
    expect(mocks.moodTracks).not.toHaveBeenCalled();
    expectNoYouTubeNorFeatured();
  });

  it('traduce gli errori dell’AI e i limiti', async () => {
    mocks.premium.mockResolvedValue(true);
    mocks.ai.mockResolvedValueOnce({ ok: false, error: 'busy' });
    const busy = await post({ mode: 'describe', prompt: 'jazz', count: 10 });
    expect(busy.status).toBe(503);
    expect((await busy.json()).message).toContain('Riprova');
    mocks.ai.mockResolvedValueOnce({ ok: false, error: 'refused' });
    expect((await post({ mode: 'describe', prompt: 'jazz', count: 10 })).status).toBe(422);
    mocks.aiConfigured.mockReturnValueOnce(false);
    const off = await post({ mode: 'describe', prompt: 'jazz', count: 10 });
    expect(off.status).toBe(503);
    expect((await off.json()).error).toBe('not_configured');
    mocks.limited.mockImplementation(async (action) =>
      action === 'playlist.engine.ai'
        ? Response.json({ error: 'rate_limited', message: 'Troppe richieste.' }, { status: 429 })
        : null,
    );
    const limited = await post({ mode: 'describe', prompt: 'jazz', count: 10 });
    expect(limited.status).toBe(429);
  });

  it('valida la descrizione sul campo giusto', async () => {
    const response = await post({ mode: 'describe', prompt: 'x', count: 10 });
    expect(response.status).toBe(400);
    expect((await response.json()).errors.prompt).toContain('almeno 3');
  });
});

describe('Parti da un brano o da un artista', () => {
  it('senza AI: brani Audius dello stesso artista e dello stesso genere', async () => {
    mocks.searchAudius.mockResolvedValueOnce({
      outcome: 'results',
      artists: [],
      tracks: [audius('s1', 'Seme'), audius('s2', 'Sème'), audius('o1', 'Omonimo Falso')],
    });
    const body = await okBody(
      await post({
        mode: 'seed',
        seed: {
          artist: 'Seme',
          title: 'Brano s1',
          audius: { trackId: 's1', genre: 'Jazz', mood: 'Peaceful' },
        },
        count: 10,
      }),
    );
    expect(body.tracks.slice(0, 2).map((track) => track.sourceId)).toEqual(['s1', 's2']);
    expect(body.tracks.map((track) => track.sourceId)).not.toContain('o1');
    expect(mocks.moodTracks).toHaveBeenCalledWith({
      moods: ['Peaceful'],
      genres: ['Jazz'],
      limit: 100,
    });
    expect(body.ai.status).toBe('not_requested');
    expect(body.name).toBe('Simili a Brano s1');
  });

  it('con l’AI: i simili suggeriti come "song", alternati ai brani Audius', async () => {
    mocks.premium.mockResolvedValue(true);
    const body = await okBody(
      await post({ mode: 'seed', seed: { artist: 'Mina' }, useAi: true, count: 3 }),
    );
    expect(body.tracks.map((track) => track.source)).toEqual(['song', 'song', 'song']);
    expect(mocks.ai).toHaveBeenCalledWith(
      { kind: 'seed', artist: 'Mina', title: null },
      expect.anything(),
    );
    expectNoYouTubeNorFeatured();
  });

  it('artista scritto che non è su Audius: senza AI parte dal genere dei risultati, e lo dice', async () => {
    // Come la ricerca vera per «Vasco Rossi»: solo brani di altri utenti Audius.
    mocks.searchAudius.mockResolvedValueOnce({
      outcome: 'results',
      artists: [],
      tracks: [
        audius('m1', 'Mark', { genre: 'Rock senza elenco' }),
        audius('r1', 'Raf Marchesini', { genre: 'Pop', mood: 'Upbeat' }),
      ],
    });
    const body = await okBody(
      await post({
        mode: 'seed',
        seed: { artist: 'Vasco Rossi', title: 'Albachiara', audius: null },
        count: 10,
      }),
    );
    expect(mocks.moodTracks).toHaveBeenCalledTimes(1);
    expect(mocks.moodTracks).toHaveBeenCalledWith({ moods: [], genres: ['Pop'], limit: 100 });
    expect(body.tracks.length).toBeGreaterThan(0);
    expect(body.tracks.every((track) => track.source === 'audius')).toBe(true);
    expect(body.notice).toContain('Su Audius non ho trovato brani di «Vasco Rossi»');
    expect(body.notice).toContain('Pop');
    expect(body.ai.status).toBe('not_requested');
    expectNoYouTubeNorFeatured();
  });

  it('con l’AI non tira a indovinare il genere: niente richiesta Audius in più', async () => {
    mocks.premium.mockResolvedValue(true);
    mocks.searchAudius.mockResolvedValueOnce({
      outcome: 'results',
      artists: [],
      tracks: [audius('r1', 'Raf Marchesini', { genre: 'Pop' })],
    });
    const body = await okBody(
      await post({ mode: 'seed', seed: { artist: 'Vasco Rossi' }, useAi: true, count: 3 }),
    );
    expect(mocks.moodTracks).not.toHaveBeenCalled();
    expect(body.tracks.every((track) => track.source === 'song')).toBe(true);
    expect(body.notice).toBeNull();
  });

  it('un titolo lungo con emoji non fa fallire la proposta (nome entro 50 unità UTF-16)', async () => {
    const title = 'Lofi Hip Hop Beats to Study and Relax 🎧📚';
    mocks.searchAudius.mockResolvedValue({
      outcome: 'results',
      artists: [],
      tracks: [audius('c1', 'Chill', { title }), audius('c2', 'Chill')],
    });
    const free = await okBody(
      await post({
        mode: 'seed',
        seed: { artist: 'Chill', title, audius: { trackId: 'c1', genre: 'Jazz', mood: null } },
        count: 10,
      }),
    );
    expect(free.name.startsWith('Simili a Lofi Hip Hop')).toBe(true);
    expect(free.name.length).toBeLessThanOrEqual(50);
    expect(free.tracks[0]?.title).toBe(title);

    // Premium con l'AI rifiutata: la chiamata pagata non finisce in un 503.
    mocks.premium.mockResolvedValue(true);
    mocks.ai.mockResolvedValueOnce({ ok: false, error: 'refused' });
    const premium = await okBody(
      await post({
        mode: 'seed',
        seed: { artist: 'Chill', title: 'Summer Vibes 🌴 Original Mix feat. Someone' },
        useAi: true,
        count: 10,
      }),
    );
    expect(mocks.ai).toHaveBeenCalledTimes(1);
    expect(premium.ai.status).toBe('refused');
    expect(premium.name.length).toBeLessThanOrEqual(50);
  });

  it('un brano Audius con titolo lungo pieno di emoji resta nella proposta', () => {
    const title = `${'a'.repeat(150)}${'🎶'.repeat(40)}`;
    expect(title.length).toBe(230);
    const draft = audiusToDraft(
      audius('e1', 'Emoji', { title, artistName: `${'b'.repeat(190)}${'🎤'.repeat(10)}` }) as never,
      'u1',
    );
    expect(draft).not.toBeNull();
    expect(draft?.title.length).toBeLessThanOrEqual(200);
    expect(draft?.title).toBe(`${'a'.repeat(150)}${'🎶'.repeat(25)}`);
    expect(draft?.creatorName?.length).toBeLessThanOrEqual(200);
  });

  it('senza AI e senza brani Audius spiega cosa fare', async () => {
    const body = await okBody(await post({ mode: 'seed', seed: { artist: 'Nessuno' }, count: 10 }));
    expect(body.tracks).toEqual([]);
    expect(body.notice).toContain('Scegli l’atmosfera');
  });

  it('quantità o esclusioni non valide: errore generico in italiano, non un campo', async () => {
    const response = await post({ mode: 'seed', seed: { artist: 'Mina' }, count: 99 });
    expect(response.status).toBe(400);
    expect((await response.json()).errors).toEqual({
      request: 'Richiesta non valida: ricarica la pagina e riprova.',
    });
  });

  it('errore sul campo artista', async () => {
    const response = await post({ mode: 'seed', seed: { artist: '' }, count: 10 });
    expect(response.status).toBe(400);
    expect((await response.json()).errors.artist).toBe('Scrivi un artista o un brano.');
  });
});

describe('accesso e limiti', () => {
  it('altra origine 403, ospite 401, limite 429 prima di leggere il corpo', async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);
    expect((await post({ mode: 'mood', mood: 'relax', count: 10 })).status).toBe(403);
    mocks.user.mockResolvedValueOnce(null);
    expect((await post({ mode: 'mood', mood: 'relax', count: 10 })).status).toBe(401);
    mocks.limited.mockResolvedValueOnce(Response.json({ error: 'rate_limited' }, { status: 429 }));
    expect((await post({ mode: 'mood', mood: 'relax', count: 10 })).status).toBe(429);
    expect(mocks.moodTracks).not.toHaveBeenCalled();
  });

  it('nessuna sorgente diversa da Audius e "song" (niente brani in evidenza)', async () => {
    const response = await post({ mode: 'featured', count: 10 });
    expect(response.status).toBe(400);
    mocks.premium.mockResolvedValue(true);
    const body = await okBody(await post({ mode: 'mood', mood: 'relax', useAi: true, count: 30 }));
    for (const track of [...body.tracks, ...body.reserve]) {
      expect(['audius', 'song']).toContain(track.source);
    }
  });
});

describe('stato di «Crea playlist»', () => {
  it('dice alla pagina chi è collegato, se ha Premium, se l’AI e Audius funzionano', async () => {
    const response = await GET();
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({
      signedIn: true,
      premium: false,
      ai: true,
      audius: true,
    });
    mocks.aiAvailable.mockRejectedValueOnce(new Error('rete'));
    expect(await (await GET()).json()).toMatchObject({ ai: false });
  });
});
