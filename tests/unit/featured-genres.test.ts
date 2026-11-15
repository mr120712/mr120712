// @polsia:user-owned — «Per genere» dei brani in evidenza, lato server: il campo facoltativo "genere" di
// diritti.json (valido o voce scartata, con il motivo per la pagina admin), il raggruppamento dei
// SOLI brani dichiarati per genere (maiuscole e spazi non contano, nome della voce più recente,
// prima i generi con più brani, id opachi stabili e mai uguali a quelli delle cartelle), la fila
// `genres` della Home (un brano non dichiarato non è mai contato, nessuna fila senza generi) e la
// pagina /cartella/<id> di un genere (solo brani dichiarati, `genre: true`, 404 per un id ignoto).
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  token: 'tok_test' as string | undefined,
  requireAuth: vi.fn(),
  enforceRateLimit: vi.fn(),
}));

vi.mock('@vercel/blob', () => ({ list: mocks.list, get: mocks.get }));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token };
  },
}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: (userId: string | null) => (userId ? `user:${userId}` : null),
}));

import { GET as sectionApi } from '@/app/api/music/featured/sections/[sectionId]/route';
import { GET as homeApi } from '@/app/api/music/home-tracks/route';
import { FeaturedSectionResponseSchema } from '@/lib/contracts/featured-sections';
import { type HomeTrack, HomeTracksResponseSchema } from '@/lib/contracts/home-tracks';
import {
  FEATURED_GENRE_NAME_MAX,
  featuredGenreCount,
  featuredGenreKey,
  featuredGenreLabel,
  isFeaturedGenreName,
} from '@/lib/music/featured-genres';
import {
  featuredGenreId,
  featuredHomeGenres,
  groupFeaturedGenres,
} from '@/lib/music/featured-genres.server';
import {
  declaredGenre,
  diagnoseRightsManifestText,
  parseRightsManifest,
} from '@/lib/music/featured-rights.server';
import {
  clearFeaturedSearchCacheForTests,
  getFeaturedSection,
  loadFeaturedHomeLinks,
} from '@/lib/music/featured-search.server';
import { FEATURED_SECTION_ID_PATTERN } from '@/lib/music/featured-sections';
import { featuredSectionId } from '@/lib/music/featured-sections.server';

const PRIVATE = 'https://store.private.blob.vercel-storage.com';

function blob(pathname: string, uploadedAt: string, size = 1000) {
  const url = `${PRIVATE}/${pathname.split('/').map(encodeURIComponent).join('/')}`;
  return { pathname, url, downloadUrl: url, size, uploadedAt: new Date(uploadedAt) };
}

// Tre brani dichiarati "Rap italiano" (scritto in tre modi), uno "Cantautorato", uno dichiarato
// SENZA genere e due rip NON dichiarati (uno nella stessa cartella dei brani rap): i rip non devono
// mai finire in un genere né essere contati.
const RAP_1 = 'Artista Uno - Primo.mp3';
const RAP_2 = 'Rap/Artista Due - Secondo.mp3';
const RAP_3 = 'Rap/Artista Tre - Terzo.mp3';
const SONG = 'Cantautori/Autrice - Canzone.mp3';
const NO_GENRE = 'Strumentale - Pioggia.mp3';
const RIP_ROOT = 'Artista Commerciale - Hit.mp3';
const RIP_RAP = 'Rap/Artista Commerciale - Rip.mp3';

const STORE = [
  blob(RAP_1, '2026-10-01T00:00:00.000Z'),
  blob(RAP_2, '2026-10-02T00:00:00.000Z'),
  blob(RAP_3, '2026-10-03T00:00:00.000Z'),
  blob(SONG, '2026-10-04T00:00:00.000Z'),
  blob(NO_GENRE, '2026-10-05T00:00:00.000Z'),
  blob(RIP_ROOT, '2026-10-06T00:00:00.000Z'),
  blob(RIP_RAP, '2026-10-07T00:00:00.000Z'),
  blob('diritti.json', '2026-10-08T00:00:00.000Z', 200),
];

const ENTRIES = [
  { file: RAP_1, licenza: 'propria', titolare: 'Uno', genere: '  rap   ITALIANO ' },
  { file: RAP_2, licenza: 'propria', titolare: 'Due', genere: 'Rap italiano' },
  { file: RAP_3, licenza: 'cc-by', titolare: 'Tre', genere: 'Rap Italiano' },
  { file: SONG, licenza: 'propria', titolare: 'Autrice', genere: 'Cantautorato' },
  { file: NO_GENRE, licenza: 'cc0', titolare: 'Strumentale' },
];

function manifest(entries: readonly unknown[] = ENTRIES) {
  return JSON.stringify({ versione: 1, brani: entries });
}

function storedText(text: string) {
  return {
    statusCode: 200,
    stream: new Response(text).body,
    headers: new Headers(),
    blob: { pathname: 'diritti.json', contentType: 'application/json', size: text.length },
  };
}

function serveStore(rights = manifest(), blobs = STORE): void {
  mocks.list.mockImplementation(async () => ({ blobs, hasMore: false }));
  mocks.get.mockImplementation(async () => storedText(rights));
}

const RAP_ID = featuredGenreId('rap italiano');
const SONG_ID = featuredGenreId('cantautorato');

async function home() {
  const response = await homeApi(new Request('https://solco.example/api/music/home-tracks'));
  return HomeTracksResponseSchema.parse(await response.json());
}

function sectionRequest(sectionId: string) {
  return sectionApi(new Request(`https://solco.example/api/music/featured/sections/${sectionId}`), {
    params: Promise.resolve({ sectionId }),
  });
}

function homeTrack(id: string, artworkUrl: string | null = null): HomeTrack {
  return {
    id,
    title: id,
    artist: null,
    streamUrl: `/api/music/home-tracks/stream?p=${encodeURIComponent(id)}`,
    durationSeconds: 0,
    artworkUrl,
  };
}

beforeEach(() => {
  mocks.list.mockReset();
  mocks.get.mockReset();
  mocks.token = 'tok_test';
  mocks.requireAuth.mockReset();
  mocks.requireAuth.mockResolvedValue({ id: 'user-1' });
  mocks.enforceRateLimit.mockReset();
  mocks.enforceRateLimit.mockResolvedValue(null);
  clearFeaturedSearchCacheForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('nomi dei generi', () => {
  it('maiuscole, spazi e forma Unicode non contano; il nome mostrato ha gli spazi sistemati', () => {
    expect(featuredGenreKey('  rap   ITALIANO ')).toBe('rap italiano');
    expect(featuredGenreKey('Rap italiano')).toBe(featuredGenreKey('RAP ITALIANO'));
    // "è" scomposto (NFD, da un Mac) e composto: stesso genere.
    expect(featuredGenreKey('Elettronica è')).toBe(featuredGenreKey('Elettronica è'));
    expect(featuredGenreLabel('  Rap   italiano ')).toBe('Rap italiano');
  });

  it('niente caratteri di controllo né nomi vuoti', () => {
    expect(isFeaturedGenreName('Rap italiano')).toBe(true);
    expect(isFeaturedGenreName('Rap\nitaliano')).toBe(false);
    expect(isFeaturedGenreName('Rap\titaliano')).toBe(false);
    expect(isFeaturedGenreName('   ')).toBe(false);
  });

  it('«1 brano» / «N brani»', () => {
    expect(featuredGenreCount(1)).toBe('1 brano');
    expect(featuredGenreCount(12)).toBe('12 brani');
  });
});

describe('"genere" in diritti.json', () => {
  it('facoltativo: senza, la voce vale come prima; con un testo valido lo si legge sistemato', () => {
    const parsed = parseRightsManifest(manifest());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skipped).toBe(0);
    expect(parsed.entries.map((entry) => declaredGenre(entry))).toEqual([
      'rap ITALIANO',
      'Rap italiano',
      'Rap Italiano',
      'Cantautorato',
      null,
    ]);
  });

  it('scritto male: la voce non vale (come per gli altri campi) e la pagina admin dice perché', () => {
    const bad = [
      { file: RAP_1, licenza: 'propria', titolare: 'Uno', genere: 42 },
      { file: RAP_2, licenza: 'propria', titolare: 'Due', genere: '   ' },
      { file: RAP_3, licenza: 'propria', titolare: 'Tre', genere: 'x'.repeat(41) },
      { file: SONG, licenza: 'propria', titolare: 'Autrice', genere: 'Canta\nutorato' },
      { file: NO_GENRE, licenza: 'cc0', titolare: 'Strumentale', genere: 'x'.repeat(40) },
    ];
    const parsed = parseRightsManifest(manifest(bad));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skipped).toBe(4);
    expect(parsed.entries.map((entry) => entry.file)).toEqual([NO_GENRE]);
    expect(FEATURED_GENRE_NAME_MAX).toBe(40);

    const diagnosis = diagnoseRightsManifestText(
      manifest(bad),
      STORE.map((file) => file.pathname),
    );
    expect(diagnosis.counts).toMatchObject({ entries: 5, valid: 1, invalid: 4 });
    const invalid = diagnosis.problems.filter((problem) => problem.kind === 'invalid');
    expect(invalid.map((problem) => problem.index)).toEqual([1, 2, 3, 4]);
    for (const problem of invalid) {
      expect(problem.reasons.join(' ')).toContain(
        '"genere" deve essere un testo da 1 a 40 caratteri',
      );
    }
  });

  it('con più voci per lo stesso file vale il genere della prima', () => {
    const parsed = parseRightsManifest(
      manifest([
        { file: RAP_1, licenza: 'propria', titolare: 'Uno', genere: 'Rap' },
        { file: RAP_1, licenza: 'propria', titolare: 'Uno', genere: 'Pop' },
      ]),
    );
    expect(parsed.ok && parsed.entries.map((entry) => declaredGenre(entry))).toEqual(['Rap']);
  });
});

describe('groupFeaturedGenres', () => {
  it('solo i brani con un genere; stesso genere comunque scritto; nome della voce più recente', () => {
    const genres = groupFeaturedGenres([
      { track: homeTrack('c.mp3'), genre: 'Rap Italiano' },
      { track: homeTrack('b.mp3'), genre: '  rap italiano' },
      { track: homeTrack('x.mp3'), genre: null },
      { track: homeTrack('y.mp3'), genre: '   ' },
      { track: homeTrack('a.mp3'), genre: 'Pop' },
    ]);
    expect(
      [...genres.values()].map((genre) => [genre.name, genre.tracks.map((t) => t.id)]),
    ).toEqual([
      ['Rap Italiano', ['c.mp3', 'b.mp3']],
      ['Pop', ['a.mp3']],
    ]);
    for (const [id, genre] of genres) {
      expect(id).toBe(genre.id);
      expect(id).toMatch(FEATURED_SECTION_ID_PATTERN);
      expect(id).toBe(featuredGenreId(genre.key));
    }
  });

  it('prima i generi con più brani, a parità in ordine alfabetico', () => {
    const genres = groupFeaturedGenres([
      { track: homeTrack('1.mp3'), genre: 'Rock' },
      { track: homeTrack('2.mp3'), genre: 'Jazz' },
      { track: homeTrack('3.mp3'), genre: 'Blues' },
      { track: homeTrack('4.mp3'), genre: 'Jazz' },
    ]);
    expect([...genres.values()].map((genre) => genre.name)).toEqual(['Jazz', 'Blues', 'Rock']);
  });

  it('id stabili e diversi da quelli di una cartella con lo stesso nome', () => {
    expect(featuredGenreId('rap')).toBe(featuredGenreId('rap'));
    expect(featuredGenreId('rap')).not.toBe(featuredSectionId('rap'));
  });

  it('un id uguale a quello di una cartella, o due generi con lo stesso id: nessuna pagina', () => {
    const tracks = [
      { track: homeTrack('1.mp3'), genre: 'Rock' },
      { track: homeTrack('2.mp3'), genre: 'Jazz' },
      { track: homeTrack('3.mp3'), genre: 'Blues' },
    ];
    const reserved = groupFeaturedGenres(tracks, new Set([featuredGenreId('jazz')]));
    expect([...reserved.values()].map((genre) => genre.name)).toEqual(['Blues', 'Rock']);
    const collide = groupFeaturedGenres(tracks, new Set(), undefined, (key) =>
      key === 'rock' || key === 'blues' ? 'S'.repeat(22) : featuredGenreId(key),
    );
    expect([...collide.values()].map((genre) => genre.name)).toEqual(['Jazz']);
  });

  it('tetto ai brani di un genere', () => {
    const tracks = Array.from({ length: 5 }, (_, index) => ({
      track: homeTrack(`${index}.mp3`),
      genre: 'Rap',
    }));
    const [genre] = groupFeaturedGenres(tracks, new Set(), 3).values();
    expect(genre?.tracks.map((track) => track.id)).toEqual(['0.mp3', '1.mp3', '2.mp3']);
  });

  it('riquadri della Home: copertine diverse (al massimo 4) e tetto ai riquadri', () => {
    const cover = (name: string) => `/api/music/home-tracks/cover?p=${name}`;
    const genres = groupFeaturedGenres([
      { track: homeTrack('1.mp3', cover('a.jpg')), genre: 'Rap' },
      { track: homeTrack('2.mp3', cover('a.jpg')), genre: 'Rap' },
      { track: homeTrack('3.mp3', null), genre: 'Rap' },
      { track: homeTrack('4.mp3', cover('b.jpg')), genre: 'Rap' },
      { track: homeTrack('5.mp3', cover('c.jpg')), genre: 'Rap' },
      { track: homeTrack('6.mp3', cover('d.jpg')), genre: 'Rap' },
      { track: homeTrack('7.mp3', cover('e.jpg')), genre: 'Rap' },
      { track: homeTrack('8.mp3', null), genre: 'Pop' },
    ]);
    const tiles = featuredHomeGenres(genres.values());
    expect(tiles).toEqual([
      {
        id: featuredGenreId('rap'),
        name: 'Rap',
        count: 7,
        artworkUrls: [cover('a.jpg'), cover('b.jpg'), cover('c.jpg'), cover('d.jpg')],
      },
      { id: featuredGenreId('pop'), name: 'Pop', count: 1, artworkUrls: [] },
    ]);
    expect(featuredHomeGenres(genres.values(), 1).map((tile) => tile.name)).toEqual(['Rap']);
  });
});

describe('Home: fila «Per genere» (solo brani dichiarati)', () => {
  it('un riquadro per genere con i soli brani dichiarati; i rip non sono mai contati', async () => {
    serveStore();
    const body = await home();
    expect(body.genres).toEqual([
      expect.objectContaining({ id: RAP_ID, name: 'Rap Italiano', count: 3 }),
      expect.objectContaining({ id: SONG_ID, name: 'Cantautorato', count: 1 }),
    ]);
    // La Home per il resto non cambia: i rip restano nelle loro sezioni come prima.
    expect(body.items.map((item) => item.id)).toContain(RIP_ROOT);
    expect(body.items.map((item) => item.id)).toContain(RIP_RAP);
  });

  it('il nome è quello della voce del brano più recente del genere', async () => {
    serveStore(
      manifest([
        { file: RAP_1, licenza: 'propria', titolare: 'Uno', genere: 'rap' },
        { file: RAP_3, licenza: 'propria', titolare: 'Tre', genere: 'Rap' },
      ]),
    );
    const body = await home();
    expect(body.genres.map((genre) => [genre.name, genre.count])).toEqual([['Rap', 2]]);
  });

  it('nessun brano dichiarato con un genere: nessuna fila', async () => {
    serveStore(
      manifest([
        { file: RAP_1, licenza: 'propria', titolare: 'Uno' },
        { file: SONG, licenza: 'propria', titolare: 'Autrice' },
      ]),
    );
    expect((await home()).genres).toEqual([]);
  });

  it('diritti.json assente o non valido: nessuna fila, anche se i file hanno nomi di generi', async () => {
    serveStore('{ non è json');
    expect((await home()).genres).toEqual([]);
    clearFeaturedSearchCacheForTests();
    serveStore(
      manifest(),
      STORE.filter((file) => file.pathname !== 'diritti.json'),
    );
    expect((await home()).genres).toEqual([]);
  });

  it('loadFeaturedHomeLinks: stessi riquadri, senza store nessun link', async () => {
    serveStore();
    const links = await loadFeaturedHomeLinks();
    expect(links?.genres.map((genre) => genre.count)).toEqual([3, 1]);
    mocks.token = undefined;
    expect(await loadFeaturedHomeLinks()).toBeNull();
  });
});

describe('pagina di un genere (/cartella/<id>)', () => {
  it('i soli brani dichiarati del genere, dal più recente, con genre: true', async () => {
    serveStore();
    const response = await sectionRequest(RAP_ID);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = FeaturedSectionResponseSchema.parse(await response.json());
    expect(body.section).toEqual({ id: RAP_ID, title: 'Rap Italiano', root: false, genre: true });
    expect(body.tracks.map((track) => track.id)).toEqual([RAP_3, RAP_2, RAP_1]);
    expect(body.tracks.map((track) => track.id)).not.toContain(RIP_RAP);
  });

  it('le cartelle restano cartelle (nessun genre)', async () => {
    serveStore();
    const lookup = await getFeaturedSection(featuredSectionId('rap'));
    expect(lookup.outcome).toBe('found');
    if (lookup.outcome !== 'found') return;
    expect(lookup.section.genre).toBeUndefined();
    expect(lookup.tracks.map((track) => track.id)).toEqual([RAP_3, RAP_2]);
  });

  it('un genere senza brani dichiarati o un id ignoto: 404', async () => {
    serveStore();
    expect((await sectionRequest(featuredGenreId('pop'))).status).toBe(404);
    expect((await sectionRequest('A'.repeat(22))).status).toBe(404);
  });

  it('serve la sessione', async () => {
    serveStore();
    mocks.requireAuth.mockRejectedValue(new Response(null, { status: 401 }));
    expect((await sectionRequest(RAP_ID)).status).toBe(401);
  });
});
