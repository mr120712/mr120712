// @polsia:user-owned — «Mostra tutti» delle sezioni dei brani in evidenza, lato server: l'indice
// raggruppa per cartella SOLO i brani dichiarati in diritti.json (un brano non dichiarato non è mai
// elencato né contato), con id opachi stabili e senza collisioni e i titoli della Home; la Home
// porta sectionId/declaredCount SOLO per le cartelle con brani dichiarati e per il resto non cambia
// (sezioni di al massimo 24 brani); la route GET /api/music/featured/sections/<id> chiede la
// sessione, valida l'id prima del limite, dà 404 senza brani dichiarati, 503 se lo store non
// risponde, e i brani con gli stessi dati della Home, mai in cache.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  token: 'tok_test' as string | undefined,
  requireAuth: vi.fn(),
  enforceRateLimit: vi.fn(),
  hasPremiumAccess: vi.fn(),
}));

vi.mock('@vercel/blob', () => ({ list: mocks.list, get: mocks.get }));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token };
  },
}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/business/premium-access.server', () => ({
  hasPremiumAccess: mocks.hasPremiumAccess,
}));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: (userId: string | null) => (userId ? `user:${userId}` : null),
}));

import { GET } from '@/app/api/music/featured/sections/[sectionId]/route';
import { GET as homeApi } from '@/app/api/music/home-tracks/route';
import { FeaturedSectionResponseSchema } from '@/lib/contracts/featured-sections';
import { type HomeTrack, HomeTracksResponseSchema } from '@/lib/contracts/home-tracks';
import { CATALOG_TTL_MS } from '@/lib/music/featured-catalog.server';
import {
  clearFeaturedSearchCacheForTests,
  getFeaturedArtist,
  getFeaturedSection,
  loadFeaturedHomeLinks,
  searchFeaturedTracks,
} from '@/lib/music/featured-search.server';
import {
  FEATURED_SECTION_ID_PATTERN,
  featuredSectionApiPath,
  featuredSectionPath,
  isFeaturedSectionId,
} from '@/lib/music/featured-sections';
import { featuredSectionId, groupFeaturedSections } from '@/lib/music/featured-sections.server';
import { type HomeFolder, listHomeTrackSections } from '@/lib/music/home-tracks.server';

const PRIVATE = 'https://store.private.blob.vercel-storage.com';

function blob(pathname: string, uploadedAt = '2026-10-01T00:00:00.000Z', size = 1000) {
  const url = `${PRIVATE}/${pathname.split('/').map(encodeURIComponent).join('/')}`;
  return { pathname, url, downloadUrl: url, size, uploadedAt: new Date(uploadedAt) };
}

// Radice: un brano dichiarato e uno no. "Cantautori": due dichiarati e un rip NON dichiarato (il più
// recente, caricato in "cantautori/" minuscolo: per la Home è la stessa sezione). "Download": solo
// brani non dichiarati. Due cartelle "Novità" (titoli con il percorso completo, come in Home).
const ROOT_DECLARED = 'Mina - Grande grande grande.mp3';
const ROOT_UNDECLARED = 'Strumentale.mp3';
const CANT_1 = 'Cantautori/Lucio Dalla - Caruso.mp3';
const CANT_2 = 'Cantautori/Lucio Dalla - Anna e Marco.mp3';
const CANT_RIP = 'cantautori/Artista Commerciale - Rip.mp3';
const DOWNLOAD_ONLY = 'Download/Artista Commerciale - Hit.mp3';
const POP_NEW = 'Pop/Novità/Band - Singolo.mp3';
const ROCK_NEW = 'Rock/Novità/Gruppo - Brano.mp3';
const UNDECLARED = [ROOT_UNDECLARED, CANT_RIP, DOWNLOAD_ONLY];
const DECLARED = [ROOT_DECLARED, CANT_1, CANT_2, POP_NEW, ROCK_NEW];

const STORE = [
  blob(ROOT_DECLARED, '2026-10-01T00:00:00.000Z'),
  blob(ROOT_UNDECLARED, '2026-10-02T00:00:00.000Z'),
  blob(CANT_1, '2026-10-04T00:00:00.000Z'),
  blob(CANT_2, '2026-10-03T00:00:00.000Z'),
  blob(CANT_RIP, '2026-10-05T00:00:00.000Z'),
  blob('Cantautori/cover.jpg', '2026-10-01T00:00:00.000Z'),
  blob(DOWNLOAD_ONLY, '2026-10-06T00:00:00.000Z'),
  blob(POP_NEW, '2026-10-07T00:00:00.000Z'),
  blob(ROCK_NEW, '2026-10-08T00:00:00.000Z'),
  blob('diritti.json', '2026-10-09T00:00:00.000Z', 200),
];

function manifest(files: readonly string[]) {
  return JSON.stringify({
    versione: 1,
    brani: files.map((file) => ({ file, licenza: 'propria', titolare: 'Solco' })),
  });
}

function storedText(text: string) {
  return {
    statusCode: 200,
    stream: new Response(text).body,
    headers: new Headers(),
    blob: { pathname: 'diritti.json', contentType: 'application/json', size: text.length },
  };
}

function serveStore(blobs = STORE, rights = manifest(DECLARED)): void {
  mocks.list.mockImplementation(async () => ({ blobs, hasMore: false }));
  mocks.get.mockImplementation(async () => storedText(rights));
}

const CANT_ID = featuredSectionId('cantautori');
const ROOT_ID = featuredSectionId('');
const DOWNLOAD_ID = featuredSectionId('download');
const UNKNOWN_ID = 'A'.repeat(22);

function request(sectionId: string) {
  return GET(new Request(`https://solco.example/api/music/featured/sections/${sectionId}`), {
    params: Promise.resolve({ sectionId }),
  });
}

async function home() {
  const response = await homeApi(new Request('https://solco.example/api/music/home-tracks'));
  return HomeTracksResponseSchema.parse(await response.json());
}

beforeEach(() => {
  mocks.list.mockReset();
  mocks.get.mockReset();
  mocks.token = 'tok_test';
  mocks.requireAuth.mockReset();
  mocks.requireAuth.mockResolvedValue({ id: 'user-1' });
  mocks.enforceRateLimit.mockReset();
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.hasPremiumAccess.mockReset();
  mocks.hasPremiumAccess.mockResolvedValue(false);
  clearFeaturedSearchCacheForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('id e percorsi delle sezioni', () => {
  it('id opaco base64url di 22 caratteri, stabile, senza il percorso della cartella', () => {
    expect(CANT_ID).toMatch(FEATURED_SECTION_ID_PATTERN);
    expect(isFeaturedSectionId(CANT_ID)).toBe(true);
    expect(featuredSectionId('cantautori')).toBe(CANT_ID);
    expect(CANT_ID.toLowerCase()).not.toContain('cantautori');
    // Cartelle diverse (anche la radice), id diversi.
    const ids = ['', 'cantautori', 'download', 'pop/novità', 'rock/novità'].map(featuredSectionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(featuredSectionPath(CANT_ID)).toBe(`/cartella/${CANT_ID}`);
    expect(featuredSectionApiPath(CANT_ID)).toBe(`/api/music/featured/sections/${CANT_ID}`);
  });

  it.each([
    '',
    'a'.repeat(21),
    'a'.repeat(23),
    'Cantautori',
    '../diritti.json',
    `${'a'.repeat(21)}!`,
  ])('forma non valida: %s', (value) => {
    expect(isFeaturedSectionId(value)).toBe(false);
  });
});

describe('indice delle sezioni: solo brani dichiarati', () => {
  it('una sezione elenca SOLO i brani dichiarati della cartella, dal più recente', async () => {
    serveStore();
    const result = await getFeaturedSection(CANT_ID);
    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    expect(result.section).toEqual({ id: CANT_ID, title: 'Cantautori', root: false });
    // Il rip non dichiarato (più recente, stessa cartella per la Home) non c'è.
    expect(result.tracks.map((track) => track.id)).toEqual([CANT_1, CANT_2]);
  });

  it('la radice ha la sua sezione «In evidenza» con i soli brani dichiarati', async () => {
    serveStore();
    const result = await getFeaturedSection(ROOT_ID);
    expect(result.outcome === 'found' && result.section.title).toBe('In evidenza');
    // La radice è segnata: la pagina mostra la stessa intestazione della Home («Ascolta ora»).
    expect(result.outcome === 'found' && result.section.root).toBe(true);
    expect(result.outcome === 'found' && result.tracks.map((track) => track.id)).toEqual([
      ROOT_DECLARED,
    ]);
  });

  it('una cartella con soli brani non dichiarati non ha pagina; nessun non dichiarato altrove', async () => {
    serveStore();
    expect(await getFeaturedSection(DOWNLOAD_ID)).toEqual({ outcome: 'not_found' });
    expect(await getFeaturedSection(UNKNOWN_ID)).toEqual({ outcome: 'not_found' });
    const links = await loadFeaturedHomeLinks();
    expect(links).not.toBeNull();
    const listed: string[] = [];
    let counted = 0;
    for (const link of links?.sections.values() ?? []) {
      const result = await getFeaturedSection(link.id);
      if (result.outcome !== 'found') throw new Error('sezione attesa');
      expect(result.tracks).toHaveLength(link.count);
      listed.push(...result.tracks.map((track) => track.id));
      counted += link.count;
    }
    expect(listed.sort()).toEqual([...DECLARED].sort());
    expect(counted).toBe(DECLARED.length);
    for (const id of UNDECLARED) expect(listed).not.toContain(id);
    expect([...(links?.sections.keys() ?? [])].sort()).toEqual(
      ['', 'cantautori', 'pop/novità', 'rock/novità'].sort(),
    );
  });

  it('titoli come in Home: due cartelle con lo stesso nome mostrano il percorso completo', async () => {
    serveStore();
    const titles = new Map((await listHomeTrackSections()).sections.map((s) => [s.id, s.title]));
    const pop = await getFeaturedSection(featuredSectionId('pop/novità'));
    const rock = await getFeaturedSection(featuredSectionId('rock/novità'));
    expect(pop.outcome === 'found' && pop.section.title).toBe('Pop › Novità');
    expect(rock.outcome === 'found' && rock.section.title).toBe('Rock › Novità');
    expect(titles.get('Pop/Novità')).toBe('Pop › Novità');
    expect(titles.get('Rock/Novità')).toBe('Rock › Novità');
  });

  it('id stabili: stessa cartella, stesso id anche dopo una ricostruzione o con altre maiuscole', async () => {
    serveStore();
    const first = await loadFeaturedHomeLinks();
    clearFeaturedSearchCacheForTests();
    // Il brano più recente della cartella ora è in "CANTAUTORI/": per la Home è la stessa sezione.
    serveStore([...STORE, blob('CANTAUTORI/Altro - Nuovo.mp3', '2026-10-10T00:00:00.000Z')]);
    const second = await loadFeaturedHomeLinks();
    expect(second?.sections.get('cantautori')?.id).toBe(first?.sections.get('cantautori')?.id);
    expect(second?.sections.get('cantautori')).toEqual({ id: CANT_ID, count: 2 });
  });

  it('revoca: una voce tolta da diritti.json esce dalla sezione e dal conteggio', async () => {
    serveStore(STORE, manifest(DECLARED.filter((file) => file !== CANT_2)));
    const result = await getFeaturedSection(CANT_ID);
    expect(result.outcome === 'found' && result.tracks.map((track) => track.id)).toEqual([CANT_1]);
    expect((await loadFeaturedHomeLinks())?.sections.get('cantautori')?.count).toBe(1);
  });

  it('revoca con indice già costruito: alla nuova versione la voce esce da sezione e conteggio', async () => {
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    const ids = (result: Awaited<ReturnType<typeof getFeaturedSection>>) =>
      result.outcome === 'found' ? result.tracks.map((track) => track.id) : [];
    const cantautori = async () => (await home()).sections.find((s) => s.id === 'cantautori');

    // Indice costruito con il manifest completo.
    serveStore();
    expect(ids(await getFeaturedSection(CANT_ID))).toEqual([CANT_1, CANT_2]);
    expect((await cantautori())?.declaredCount).toBe(2);

    // diritti.json cambia (nuovo uploadedAt e nuova dimensione): la voce di CANT_2 è tolta.
    serveStore(
      [
        ...STORE.filter((item) => item.pathname !== 'diritti.json'),
        blob('diritti.json', '2026-10-10T00:00:00.000Z', 180),
      ],
      manifest(DECLARED.filter((file) => file !== CANT_2)),
    );
    // Dentro la finestra della versione (~30 s) vale ancora l'indice già costruito.
    clock.mockReturnValue(start + 1_000);
    expect(ids(await getFeaturedSection(CANT_ID))).toEqual([CANT_1, CANT_2]);

    // Scaduta la finestra: il primo accesso può servire ancora l'indice precedente mentre arriva il
    // nuovo elenco (come la pagina d'artista), poi solo i brani ancora dichiarati.
    clock.mockReturnValue(start + CATALOG_TTL_MS + 1_000);
    let after: string[] = [];
    for (let attempt = 0; attempt < 3 && after.length !== 1; attempt += 1) {
      after = ids(await getFeaturedSection(CANT_ID));
      if (after.length !== 1) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(after).toEqual([CANT_1]);
    expect(ids(await getFeaturedSection(CANT_ID))).toEqual([CANT_1]);
    // La Home conta il solo dichiarato rimasto; la sua sezione resta com'è (anche il rip e CANT_2).
    const section = await cantautori();
    expect(section?.declaredCount).toBe(1);
    expect(section?.sectionId).toBe(CANT_ID);
    expect(section?.items).toHaveLength(3);
    expect((await loadFeaturedHomeLinks())?.sections.get('cantautori')).toEqual({
      id: CANT_ID,
      count: 1,
    });
  });

  it('manifest assente: nessuna sezione; Blob non configurato o non leggibile: unavailable', async () => {
    serveStore(STORE.filter((item) => item.pathname !== 'diritti.json'));
    expect(await getFeaturedSection(CANT_ID)).toEqual({ outcome: 'not_found' });
    expect((await loadFeaturedHomeLinks())?.sections.size).toBe(0);

    clearFeaturedSearchCacheForTests();
    mocks.token = undefined;
    expect(await getFeaturedSection(CANT_ID)).toEqual({ outcome: 'unavailable' });

    clearFeaturedSearchCacheForTests();
    mocks.token = 'tok_test';
    mocks.list.mockRejectedValue(new Error('down'));
    expect(await getFeaturedSection(CANT_ID)).toEqual({ outcome: 'unavailable' });
  });

  it('id malformato: not_found senza leggere lo store', async () => {
    serveStore();
    expect(await getFeaturedSection('Cantautori')).toEqual({ outcome: 'not_found' });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('ricerca, artista, link della Home e sezioni condividono UNA sola scansione dello store', async () => {
    serveStore();
    await Promise.all([
      searchFeaturedTracks('caruso'),
      getFeaturedArtist('lucio-dalla'),
      getFeaturedSection(CANT_ID),
      loadFeaturedHomeLinks(),
    ]);
    await getFeaturedSection(ROOT_ID);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
});

describe('groupFeaturedSections', () => {
  function track(id: string): HomeTrack {
    return {
      id,
      title: id,
      artist: null,
      streamUrl: `/api/music/home-tracks/stream?p=${encodeURIComponent(id)}`,
      durationSeconds: 0,
      artworkUrl: null,
    };
  }
  const FOLDERS: HomeFolder[] = [
    { key: '', directory: '', title: 'In evidenza' },
    { key: 'a', directory: 'A', title: 'A' },
    { key: 'b', directory: 'B', title: 'B' },
  ];

  it('tetto per sezione (dal più recente) e ordine della Home', () => {
    const sections = groupFeaturedSections(
      [track('B/1.mp3'), track('A/1.mp3'), track('A/2.mp3'), track('A/3.mp3'), track('r.mp3')],
      FOLDERS,
      2,
    );
    expect([...sections.values()].map((s) => [s.key, s.title, s.tracks.map((t) => t.id)])).toEqual([
      ['', 'In evidenza', ['r.mp3']],
      ['a', 'A', ['A/1.mp3', 'A/2.mp3']],
      ['b', 'B', ['B/1.mp3']],
    ]);
  });

  it('nessun brano dichiarato: nessuna sezione', () => {
    expect(groupFeaturedSections([], FOLDERS).size).toBe(0);
  });

  it('collisione di id: entrambe le cartelle restano senza pagina, le altre no', () => {
    const sections = groupFeaturedSections(
      [track('A/1.mp3'), track('B/1.mp3'), track('r.mp3')],
      FOLDERS,
      500,
      (key) => (key === '' ? featuredSectionId('') : 'X'.repeat(22)),
    );
    expect([...sections.keys()]).toEqual([featuredSectionId('')]);
  });
});

describe('Home: «Mostra tutti» solo con brani dichiarati', () => {
  it('sectionId/declaredCount solo per le cartelle con brani dichiarati (N = dichiarati)', async () => {
    serveStore();
    const body = await home();
    const byId = Object.fromEntries(
      body.sections.map((section) => [
        section.id,
        [section.sectionId, section.declaredCount, section.items.length],
      ]),
    );
    expect(byId).toEqual({
      '': [ROOT_ID, 1, 2],
      // La Home mostra anche il rip non dichiarato (3 brani), ma N conta solo i 2 dichiarati.
      cantautori: [CANT_ID, 2, 3],
      Download: [null, null, 1],
      'Pop/Novità': [featuredSectionId('pop/novità'), 1, 1],
      'Rock/Novità': [featuredSectionId('rock/novità'), 1, 1],
    });
  });

  it('senza diritti.json nessun «Mostra tutti»', async () => {
    serveStore(STORE.filter((item) => item.pathname !== 'diritti.json'));
    const body = await home();
    expect(body.sections.length).toBeGreaterThan(0);
    expect(body.sections.every((s) => s.sectionId === null && s.declaredCount === null)).toBe(true);
  });

  it('la sezione in Home resta di al massimo 24 brani; la pagina elenca tutti i dichiarati', async () => {
    const many = Array.from({ length: 30 }, (_, index) => {
      const day = String(index + 1).padStart(2, '0');
      return blob(`Tanti/Artista - Brano ${day}.mp3`, `2026-09-${day}T00:00:00.000Z`);
    });
    const declared = many.slice(0, 26).map((item) => item.pathname);
    serveStore(
      [...many, blob('diritti.json', '2026-10-09T00:00:00.000Z', 200)],
      manifest(declared),
    );
    const section = (await home()).sections.find((s) => s.id === 'Tanti');
    expect(section?.items).toHaveLength(24);
    expect(section?.declaredCount).toBe(26);
    const page = await getFeaturedSection(featuredSectionId('tanti'));
    expect(page.outcome === 'found' && page.tracks.length).toBe(26);
    expect(page.outcome === 'found' && page.tracks.map((track) => track.id).sort()).toEqual(
      [...declared].sort(),
    );
  });
});

describe('GET /api/music/featured/sections/<id>', () => {
  it('senza sessione: 401, nessun limite consumato e nessuna lettura dello store', async () => {
    serveStore();
    mocks.requireAuth.mockRejectedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    const response = await request(CANT_ID);
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('sessione non verificabile (errore): 503, non 401', async () => {
    mocks.requireAuth.mockRejectedValue(new Error('db down'));
    expect((await request(CANT_ID)).status).toBe(503);
  });

  it.each(['Cantautori', 'a'.repeat(21), 'a'.repeat(23), '..', '%2E%2E', `${'a'.repeat(21)}.`])(
    'id non valido %s: 400 prima del limite e dello store',
    async (sectionId) => {
      serveStore();
      const response = await request(sectionId);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ errors: { sectionId: 'Sezione non valida.' } });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
      expect(mocks.list).not.toHaveBeenCalled();
    },
  );

  it('200: sezione e soli brani dichiarati, stessi dati della Home, mai in cache', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'segreto-di-prova');
    serveStore();
    const response = await request(CANT_ID);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = FeaturedSectionResponseSchema.parse(await response.json());
    expect(Object.keys(body).sort()).toEqual(['section', 'total', 'tracks']);
    expect(body.total).toBe(2);
    expect(body.section).toEqual({ id: CANT_ID, title: 'Cantautori', root: false });
    expect(body.tracks.map((track) => track.id)).toEqual([CANT_1, CANT_2]);

    // Stessi dati della Home (copertina, streamUrl, link all'artista e «Condividi»).
    const homeItems = (await home()).sections.flatMap((section) => section.items);
    for (const track of body.tracks) {
      expect(track).toEqual(homeItems.find((item) => item.id === track.id));
      expect(track.shareId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
    expect(body.tracks[0]).toMatchObject({
      streamUrl: `/api/music/home-tracks/stream?p=${encodeURIComponent(CANT_1)}`,
      // La copertina versiona l'URL (&v=<data di caricamento>): basta il percorso + pathname.
      artworkUrl: expect.stringContaining(
        `/api/music/home-tracks/cover?p=${encodeURIComponent('Cantautori/cover.jpg')}`,
      ),
      artistSlug: 'lucio-dalla',
    });
    expect(JSON.stringify(body)).not.toContain('Rip');
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('music.search', 'user:user-1');
  });

  it('radice: la sezione è segnata come radice (in Home «Ascolta ora»)', async () => {
    serveStore();
    const response = await request(ROOT_ID);
    expect(response.status).toBe(200);
    const body = FeaturedSectionResponseSchema.parse(await response.json());
    expect(body.section).toEqual({ id: ROOT_ID, title: 'In evidenza', root: true });
    expect(body.tracks.map((track) => track.id)).toEqual([ROOT_DECLARED]);
  });

  it('contratto: una risposta senza `root` vale come sezione normale', () => {
    const body = FeaturedSectionResponseSchema.parse({
      section: { id: CANT_ID, title: 'Cantautori' },
      tracks: [],
    });
    expect(body.section.root).toBeUndefined();
  });

  it('404 per una cartella senza brani dichiarati (anche se ha brani nello store) e per un id sconosciuto', async () => {
    serveStore();
    for (const sectionId of [DOWNLOAD_ID, UNKNOWN_ID]) {
      const response = await request(sectionId);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
  });

  it('503 quando lo store non è configurato', async () => {
    mocks.token = undefined;
    const response = await request(CANT_ID);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'unavailable' });
  });

  it('limite raggiunto: la risposta 429 del limite, mai in cache', async () => {
    serveStore();
    mocks.enforceRateLimit.mockResolvedValue(
      Response.json({ error: 'rate_limited' }, { status: 429 }),
    );
    const response = await request(CANT_ID);
    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

describe('piano: Premium tutti i brani dichiarati, Free i 30 più recenti', () => {
  function manyDeclared(count: number) {
    const files = Array.from({ length: count }, (_, index) => {
      const day = String((index % 28) + 1).padStart(2, '0');
      const month = index < 28 ? '08' : '09';
      return blob(`Tanti/Artista - Brano ${index + 1}.mp3`, `2026-${month}-${day}T00:00:00.000Z`);
    });
    // Un rip non dichiarato nella stessa cartella: mai elencato né contato, per nessun piano.
    const rip = blob('Tanti/Commerciale - Rip.mp3', '2026-10-01T00:00:00.000Z');
    serveStore(
      [...files, rip, blob('diritti.json', '2026-10-09T00:00:00.000Z', 200)],
      manifest(files.map((file) => file.pathname)),
    );
    return files;
  }
  const TANTI_ID = featuredSectionId('tanti');

  it('Free: i 30 brani più recenti e il totale dei dichiarati', async () => {
    manyDeclared(45);
    const response = await request(TANTI_ID);
    expect(response.status).toBe(200);
    const body = FeaturedSectionResponseSchema.parse(await response.json());
    expect(body.tracks).toHaveLength(30);
    expect(body.total).toBe(45);
    // Dal più recente: i primi 30 dell'elenco completo.
    const all = await getFeaturedSection(TANTI_ID);
    const allIds = all.outcome === 'found' ? all.tracks.map((track) => track.id) : [];
    expect(body.tracks.map((track) => track.id)).toEqual(allIds.slice(0, 30));
    expect(allIds).not.toContain('Tanti/Commerciale - Rip.mp3');
    expect(mocks.hasPremiumAccess).toHaveBeenCalledWith('user-1');
  });

  it('Premium: tutti i brani dichiarati', async () => {
    manyDeclared(45);
    mocks.hasPremiumAccess.mockResolvedValue(true);
    const body = FeaturedSectionResponseSchema.parse(await (await request(TANTI_ID)).json());
    expect(body.tracks).toHaveLength(45);
    expect(body.total).toBe(45);
  });

  it('fino a 30 brani: tutti per tutti, senza controllare il Premium', async () => {
    manyDeclared(30);
    const body = FeaturedSectionResponseSchema.parse(await (await request(TANTI_ID)).json());
    expect(body.tracks).toHaveLength(30);
    expect(body.total).toBe(30);
    expect(mocks.hasPremiumAccess).not.toHaveBeenCalled();
  });

  it('contratto: il totale non può essere minore dei brani; senza totale vale come prima', () => {
    const tracks = [{ ...homeTrackStub() }];
    expect(
      FeaturedSectionResponseSchema.safeParse({
        section: { id: CANT_ID, title: 'Cantautori' },
        tracks,
        total: 0,
      }).success,
    ).toBe(false);
    expect(
      FeaturedSectionResponseSchema.safeParse({
        section: { id: CANT_ID, title: 'Cantautori' },
        tracks,
      }).success,
    ).toBe(true);
  });
});

function homeTrackStub() {
  return {
    id: 'Cantautori/Lucio Dalla - Caruso.mp3',
    title: 'Caruso',
    artist: 'Lucio Dalla',
    streamUrl: '/api/music/home-tracks/stream?p=x',
    durationSeconds: 0,
    artworkUrl: null,
  };
}
