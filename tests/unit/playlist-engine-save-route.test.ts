// @polsia:user-owned — POST /api/music/playlist-engine/save: una sola scrittura con tutti i brani,
// "song" identici all'importazione di un elenco, brani Audius solo con la firma del server, limiti
// delle raccolte uguali per Free e Pro, errori di campo per il nome, nessuna ricerca YouTube.
// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null,
  sameOrigin: vi.fn(() => true),
  limited: vi.fn(async () => null as Response | null),
  create: vi.fn(),
  findFirst: vi.fn(async () => null as { id: string } | null),
  count: vi.fn(async () => 0),
  premium: vi.fn(async () => false),
  resolveSong: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/require-auth', () => ({
  requireAuth: async () => {
    if (!mocks.user) throw Response.json({ error: 'unauthorized' }, { status: 401 });
    return mocks.user;
  },
}));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.limited }));
vi.mock('@/lib/business/premium-access.server', () => ({ hasPremiumAccess: mocks.premium }));
vi.mock('@/lib/business/playlist-engine-ai.server', () => ({ suggestSongsWithAi: vi.fn() }));
vi.mock('@/lib/music/audius-source.server', () => ({
  getAudiusMoodTracks: vi.fn(),
  searchAudius: vi.fn(),
}));
vi.mock('@/lib/music/collections.server', () => ({
  MAX_PLAYLISTS_PER_USER: 100,
  MAX_ITEMS_PER_COLLECTION: 500,
  isFavoritesName: (name: string) => name.trim().toLocaleLowerCase('it-IT') === 'preferiti',
}));
vi.mock('@/lib/music/song-resolve.server', () => ({ searchSong: mocks.resolveSong }));
vi.mock('@/lib/db', () => ({
  prisma: {
    userMusicCollection: { findFirst: mocks.findFirst, create: mocks.create, count: mocks.count },
  },
}));

import { POST } from '@/app/api/music/playlist-engine/save/route';
import { AUDIUS_TOKEN_TTL_MS, signAudiusTrack } from '@/lib/business/playlist-engine.server';
import { songSourceId } from '@/lib/business/track-list-import.server';
import type { DraftTrack } from '@/lib/contracts/playlist-engine';

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

const song = (title: string, artist: string | null): DraftTrack => ({
  source: 'song',
  sourceId: songSourceId(title, artist),
  title,
  creatorName: artist,
  artworkUrl: null,
  sourceUrl: null,
  artistUrl: null,
  durationSeconds: null,
});

function audius(id: string, userId = 'u1', now = Date.now()): DraftTrack {
  const fields = {
    source: 'audius' as const,
    sourceId: id,
    title: `Brano ${id}`,
    creatorName: 'Artista Audius',
    artworkUrl: `https://audius.co/art/${id}.jpg`,
    sourceUrl: `https://audius.co/artista/${id}`,
    artistUrl: 'https://audius.co/artista',
    durationSeconds: 180,
  };
  return { ...fields, token: signAudiusTrack(userId, fields, now) ?? '' };
}

const post = (body: unknown) =>
  POST(
    new Request('https://solco.test/api/music/playlist-engine/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://solco.test' },
      body: JSON.stringify(body),
    }),
  );

const createdItems = () =>
  mocks.create.mock.calls[0]?.[0].data.items.create as Array<Record<string, unknown>>;

beforeEach(() => {
  mocks.user = { id: 'u1' };
  mocks.sameOrigin.mockReset().mockReturnValue(true);
  mocks.limited.mockReset().mockResolvedValue(null);
  mocks.create.mockReset().mockResolvedValue({ id: 'c1' });
  mocks.findFirst.mockReset().mockResolvedValue(null);
  mocks.count.mockReset().mockResolvedValue(0);
  mocks.premium.mockReset().mockResolvedValue(false);
  mocks.resolveSong.mockReset();
  fetchSpy.mockClear();
});

describe('Salva nella Libreria', () => {
  it('crea playlist e brani in una sola scrittura, nell’ordine della bozza', async () => {
    const response = await post({
      name: 'Cena d’estate',
      description: '  Brani solari  ',
      tracks: [
        song('Azzurro', 'Adriano Celentano'),
        audius('a1'),
        song('Sapore di sale', 'Gino Paoli'),
      ],
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      collectionId: 'c1',
      name: 'Cena d’estate',
      saved: 3,
      skipped: 0,
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const data = mocks.create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({
      userId: 'u1',
      name: 'Cena d’estate',
      kind: 'playlist',
      description: 'Brani solari',
    });
    const items = createdItems();
    expect(items.map((item) => item.source)).toEqual(['song', 'audius', 'song']);
    // "song" esattamente come l'importazione di un elenco: da cercare su YouTube all'ascolto.
    expect(items[0]).toEqual({
      source: 'song',
      sourceId: songSourceId('Azzurro', 'Adriano Celentano'),
      title: 'Azzurro',
      creatorName: 'Adriano Celentano',
      artworkUrl: null,
      sourceUrl: null,
      artistUrl: null,
      durationSeconds: null,
      createdAt: expect.any(Date),
      expiresAt: null,
    });
    expect(items[1]).toMatchObject({
      source: 'audius',
      sourceId: 'a1',
      title: 'Brano a1',
      creatorName: 'Artista Audius',
      artworkUrl: 'https://audius.co/art/a1.jpg',
      sourceUrl: 'https://audius.co/artista/a1',
      artistUrl: 'https://audius.co/artista',
      durationSeconds: 180,
      expiresAt: null,
    });
    expect(items[1]).not.toHaveProperty('token');
    const times = items.map((item) => (item.createdAt as Date).getTime());
    expect(times[0]).toBeGreaterThan(times[1] ?? 0);
    expect(times[1]).toBeGreaterThan(times[2] ?? 0);
    // Nessuna ricerca YouTube e nessuna lettura di Audius al salvataggio.
    expect(mocks.resolveSong).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('scarta doppioni e brani Audius con firma alterata, scaduta o di un altro account', async () => {
    const tampered = { ...audius('a2'), title: 'Titolo cambiato' };
    const expired = audius('a3', 'u1', Date.now() - AUDIUS_TOKEN_TTL_MS - 1000);
    const foreign = audius('a4', 'altro');
    const response = await post({
      name: 'Mista',
      tracks: [
        song('Azzurro', 'Adriano Celentano'),
        song('AZZURRO!', 'adriano celentàno'),
        audius('a1'),
        audius('a1'),
        tampered,
        expired,
        foreign,
      ],
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ saved: 2, skipped: 5 });
    expect(createdItems().map((item) => item.sourceId)).toEqual([
      songSourceId('Azzurro', 'Adriano Celentano'),
      'a1',
    ]);
  });

  it('se nessun brano è valido non scrive niente e lo dice sul campo dei brani', async () => {
    const response = await post({
      name: 'Vuota',
      tracks: [{ ...audius('a1'), token: 'zz.firma' }],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).errors.tracks).toContain('non sono più validi');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('stesso limite di 100 playlist per Free e Pro', async () => {
    for (const premium of [false, true]) {
      mocks.premium.mockResolvedValue(premium);
      mocks.count.mockResolvedValueOnce(100);
      const response = await post({ name: 'Una in più', tracks: [song('A', 'B')] });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: 'limit_reached',
        message: expect.stringContaining('100 playlist'),
      });
    }
    expect(mocks.create).not.toHaveBeenCalled();
    // Il piano non cambia i limiti delle raccolte: non viene nemmeno controllato.
    expect(mocks.premium).not.toHaveBeenCalled();
    mocks.count.mockResolvedValueOnce(99);
    expect((await post({ name: 'Ultima', tracks: [song('A', 'B')] })).status).toBe(201);
  });

  it('un nome già usato diventa "(2)", una collisione intanto viene ritentata', async () => {
    const taken = new Set(['Relax']);
    mocks.findFirst.mockImplementation((async (query: { where: { name: string } }) =>
      taken.has(query.where.name) ? { id: 'esiste' } : null) as never);
    mocks.create
      .mockImplementationOnce(async () => {
        // Un'altra scheda ha appena preso "Relax (2)".
        taken.add('Relax (2)');
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      })
      .mockResolvedValueOnce({ id: 'c2' });
    const response = await post({ name: 'Relax', tracks: [song('A', 'B')] });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ collectionId: 'c2', name: 'Relax (3)' });
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it('errori di campo: nome vuoto, troppo lungo o riservato, descrizione troppo lunga', async () => {
    const empty = await post({ name: '   ', tracks: [song('A', 'B')] });
    expect(empty.status).toBe(400);
    expect((await empty.json()).errors.name).toBe('Dai un nome alla playlist.');
    const long = await post({ name: 'x'.repeat(51), tracks: [song('A', 'B')] });
    expect((await long.json()).errors.name).toContain('50 caratteri');
    const reserved = await post({ name: 'Preferiti', tracks: [song('A', 'B')] });
    expect((await reserved.json()).errors.name).toContain('riservato');
    const description = await post({
      name: 'Ok',
      description: 'x'.repeat(301),
      tracks: [song('A', 'B')],
    });
    expect((await description.json()).errors.description).toContain('300 caratteri');
    const none = await post({ name: 'Ok', tracks: [] });
    expect((await none.json()).errors.tracks).toContain('vuota');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('solo "song" e Audius: un brano in evidenza o caricato viene rifiutato', async () => {
    const response = await post({
      name: 'Ok',
      tracks: [{ source: 'upload', sourceId: 'brano-in-evidenza', title: 'X', creatorName: 'Y' }],
    });
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('altra origine 403, ospite 401, limite 429, database giù 503', async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);
    expect((await post({ name: 'Ok', tracks: [song('A', 'B')] })).status).toBe(403);
    mocks.user = null;
    expect((await post({ name: 'Ok', tracks: [song('A', 'B')] })).status).toBe(401);
    mocks.user = { id: 'u1' };
    mocks.limited.mockResolvedValueOnce(Response.json({ error: 'rate_limited' }, { status: 429 }));
    expect((await post({ name: 'Ok', tracks: [song('A', 'B')] })).status).toBe(429);
    mocks.create.mockRejectedValueOnce(new Error('db down'));
    const down = await post({ name: 'Ok', tracks: [song('A', 'B')] });
    expect(down.status).toBe(503);
    expect((await down.json()).message).toContain('la bozza resta qui');
  });
});
