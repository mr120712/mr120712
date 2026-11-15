// @polsia:user-owned — copia offline dei brani in evidenza lato server: `offline` SOLO sui brani
// dichiarati (Home, sezione, artista; mai sui non dichiarati), verifica delle copie salvate
// (getFeaturedOfflineStatus) e risoluzione del download (resolveFeaturedOfflineDownload): l'id si
// risolve solo dall'indice dei dichiarati e il permesso si ricontrolla su diritti.json riletto
// dallo store, così una revoca vale subito anche prima che l'indice si ricostruisca.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  token: 'tok_test' as string | undefined,
}));
vi.mock('@vercel/blob', () => ({ list: mocks.list, get: mocks.get }));
vi.mock('@/lib/env', () => ({
  get env() {
    return { BLOB_READ_WRITE_TOKEN: mocks.token };
  },
}));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: vi.fn(async () => null),
  getRateLimitIdentity: vi.fn(() => 'ip:192.0.2.9'),
}));

import { GET as homeTracks } from '@/app/api/music/home-tracks/route';
import { HomeTracksResponseSchema } from '@/lib/contracts/home-tracks';
import {
  clearFeaturedSearchCacheForTests,
  getFeaturedArtist,
  getFeaturedOfflineStatus,
  getFeaturedSection,
  loadFeaturedHomeLinks,
  resolveFeaturedOfflineDownload,
} from '@/lib/music/featured-search.server';
import { featuredShareId } from '@/lib/music/featured-share.server';

const SECRET = 'segreto-di-prova-abbastanza-lungo';
const PRIVATE = 'https://store.private.blob.vercel-storage.com';

function blob(pathname: string, uploadedAt: string, size = 1000) {
  const url = `${PRIVATE}/${pathname.split('/').map(encodeURIComponent).join('/')}`;
  return { pathname, url, downloadUrl: url, size, uploadedAt: new Date(uploadedAt) };
}

const OWN = 'Cantautori/Autrice - Mia.mp3';
const LICENSED = 'Cantautori/Autrice - Su licenza.mp3';
const LICENSED_OPT_IN = 'Cantautori/Autrice - Con download.mp3';
const CC = 'Cantautori/Autrice - Aperta.mp3';
const UNDECLARED = 'Cantautori/Autrice - Copiata.mp3';
const STORE = [
  blob(OWN, '2026-10-05T00:00:00.000Z', 4000),
  blob(LICENSED, '2026-10-04T00:00:00.000Z'),
  blob(LICENSED_OPT_IN, '2026-10-03T00:00:00.000Z'),
  blob(CC, '2026-10-02T00:00:00.000Z'),
  blob(UNDECLARED, '2026-10-06T00:00:00.000Z'),
  blob('diritti.json', '2026-10-07T00:00:00.000Z', 300),
];

type Row = Record<string, unknown>;
const BASE_ROWS: Row[] = [
  { file: OWN, licenza: 'propria', titolare: 'Autrice' },
  { file: LICENSED, licenza: 'licenza', titolare: 'Etichetta Srl' },
  { file: LICENSED_OPT_IN, licenza: 'licenza', titolare: 'Etichetta Srl', offline: true },
  {
    file: CC,
    licenza: 'cc-by-sa',
    titolare: 'Autrice',
    prova: 'https://creativecommons.org/licenses/by-sa/3.0/',
  },
];

let manifestText = '';
function setManifest(rows: Row[]) {
  manifestText = JSON.stringify({ versione: 1, brani: rows });
}

function storedText(text: string) {
  return {
    statusCode: 200,
    stream: new Response(text).body,
    headers: new Headers(),
    blob: { pathname: 'diritti.json', contentType: 'application/json', size: text.length },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-15T10:00:00.000Z'));
  vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
  mocks.token = 'tok_test';
  mocks.list.mockReset();
  mocks.get.mockReset();
  mocks.list.mockImplementation(async () => ({ blobs: STORE, hasMore: false }));
  // Ogni lettura di diritti.json restituisce il contenuto ATTUALE (anche a elenco invariato).
  mocks.get.mockImplementation(async () => storedText(manifestText));
  setManifest(BASE_ROWS);
  clearFeaturedSearchCacheForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const id = (pathname: string) => featuredShareId(pathname, SECRET);

describe('`offline` nelle risposte: solo brani dichiarati', () => {
  it('Home: offline per i dichiarati (secondo la voce), assente per i non dichiarati', async () => {
    await loadFeaturedHomeLinks();
    const response = await homeTracks(new Request('https://solco.test/api/music/home-tracks'));
    const raw = (await response.json()) as { items: Array<Record<string, unknown>> };
    const byId = new Map(raw.items.map((item) => [item.id, item]));
    expect(byId.get(OWN)?.offline).toBe(true);
    expect(byId.get(LICENSED)?.offline).toBe(false);
    expect(byId.get(LICENSED_OPT_IN)?.offline).toBe(true);
    expect(byId.get(CC)?.offline).toBe(true);
    // Il brano non dichiarato resta in Home (com'era) ma senza il campo, né id per scaricarlo.
    expect(byId.get(UNDECLARED)).toBeDefined();
    expect('offline' in (byId.get(UNDECLARED) ?? {})).toBe(false);
    expect(byId.get(UNDECLARED)?.shareId).toBeNull();
    // Il contratto lo accetta (campo facoltativo).
    expect(HomeTracksResponseSchema.safeParse(raw).success).toBe(true);
  });

  it('senza diritti.json nessun brano porta offline', async () => {
    mocks.list.mockImplementation(async () => ({
      blobs: STORE.filter((item) => item.pathname !== 'diritti.json'),
      hasMore: false,
    }));
    await loadFeaturedHomeLinks();
    const response = await homeTracks(new Request('https://solco.test/api/music/home-tracks'));
    const raw = (await response.json()) as { items: Array<Record<string, unknown>> };
    expect(raw.items.length).toBeGreaterThan(0);
    expect(raw.items.some((item) => 'offline' in item)).toBe(false);
  });

  it('sezione e artista: soli dichiarati, ciascuno con il suo permesso', async () => {
    const links = await loadFeaturedHomeLinks();
    const sectionId = links?.sections.get('cantautori')?.id ?? '';
    const section = await getFeaturedSection(sectionId);
    expect(section.outcome).toBe('found');
    if (section.outcome !== 'found') return;
    expect(section.tracks.map((track) => [track.id, track.offline])).toEqual([
      [OWN, true],
      [LICENSED, false],
      [LICENSED_OPT_IN, true],
      [CC, true],
    ]);
    const artist = await getFeaturedArtist('autrice');
    expect(artist.outcome === 'found' && artist.tracks.every((t) => t.id !== UNDECLARED)).toBe(
      true,
    );
    expect(
      artist.outcome === 'found' && artist.tracks.find((t) => t.id === LICENSED)?.offline,
    ).toBe(false);
  });
});

describe('getFeaturedOfflineStatus: verifica delle copie salvate', () => {
  it('permesse le copie consentite; revocate le non consentite, le sconosciute e le non dichiarate', async () => {
    const guessed = 'A'.repeat(22);
    const status = await getFeaturedOfflineStatus([
      id(OWN),
      id(LICENSED),
      id(UNDECLARED),
      guessed,
      id(OWN),
    ]);
    expect(status).toEqual({
      outcome: 'ok',
      permitted: [id(OWN)],
      revoked: [id(LICENSED), id(UNDECLARED), guessed],
    });
  });

  it('manifest non valido = nessun brano dichiarato: tutte revocate (nel dubbio si esclude)', async () => {
    manifestText = '{ non è json';
    const status = await getFeaturedOfflineStatus([id(OWN)]);
    expect(status).toEqual({ outcome: 'ok', permitted: [], revoked: [id(OWN)] });
  });

  it('elenco fermo al tetto di pagine (riuscito ma incompleto): un brano oltre il tetto NON è revocato', async () => {
    const BEYOND = 'Zeta/Autrice - Oltre il tetto.mp3';
    setManifest([...BASE_ROWS, { file: BEYOND, licenza: 'cc0', titolare: 'Autrice' }]);
    // Elenco completo: il brano oltre la prima pagina c'è ed è permesso.
    mocks.list.mockImplementation(async ({ cursor }: { cursor?: string }) =>
      cursor
        ? { blobs: [blob(BEYOND, '2026-10-01T00:00:00.000Z')], hasMore: false }
        : { blobs: STORE, hasMore: true, cursor: 'pagina-2' },
    );
    expect(await getFeaturedOfflineStatus([id(OWN), id(BEYOND)])).toEqual({
      outcome: 'ok',
      permitted: [id(OWN), id(BEYOND)],
      revoked: [],
    });

    // Lo store cresce: il brano finisce oltre la ventesima pagina (nessun errore, elenco parziale).
    clearFeaturedSearchCacheForTests();
    let pages = 0;
    mocks.list.mockImplementation(async () => {
      pages += 1;
      return pages === 1
        ? { blobs: STORE, hasMore: true, cursor: `p${pages}` }
        : { blobs: [], hasMore: true, cursor: `p${pages}` };
    });
    const guessed = 'C'.repeat(22);
    const status = await getFeaturedOfflineStatus([
      id(OWN),
      id(BEYOND),
      id(LICENSED),
      id(UNDECLARED),
      guessed,
    ]);
    expect(pages).toBe(20);
    // Permesso quel che si vede; revocato SOLO ciò che l'indice conosce con la copia spenta; gli
    // assenti (oltre il tetto, sconosciuti) restano com'erano: l'assenza non è certa.
    expect(status).toEqual({ outcome: 'ok', permitted: [id(OWN)], revoked: [id(LICENSED)] });
  });

  it('store non configurato o non leggibile: non si sa, le copie restano', async () => {
    mocks.token = undefined;
    expect(await getFeaturedOfflineStatus([id(OWN)])).toEqual({ outcome: 'unavailable' });
    mocks.token = 'tok_test';
    clearFeaturedSearchCacheForTests();
    mocks.list.mockRejectedValue(new Error('rete'));
    expect(await getFeaturedOfflineStatus([id(OWN)])).toEqual({ outcome: 'unavailable' });
  });
});

describe('resolveFeaturedOfflineDownload: id dall’indice, permesso dal manifest ATTUALE', () => {
  it('consentito: brano, voce attuale e dove leggere l’audio (mai un percorso dal client)', async () => {
    const lookup = await resolveFeaturedOfflineDownload(id(OWN));
    expect(lookup.outcome).toBe('allowed');
    if (lookup.outcome !== 'allowed') return;
    expect(lookup.track.id).toBe(OWN);
    expect(lookup.entry).toMatchObject({ licenza: 'propria', titolare: 'Autrice' });
    expect(lookup.audio).toEqual({ pathname: OWN, public: false, size: 4000 });
  });

  it('dichiarato senza permesso → not_permitted con il perché', async () => {
    expect(await resolveFeaturedOfflineDownload(id(LICENSED))).toMatchObject({
      outcome: 'not_permitted',
      basis: 'licence_needs_opt_in',
    });
  });

  it('id malformato, inventato o di un brano NON dichiarato → not_found (stessa risposta)', async () => {
    expect(await resolveFeaturedOfflineDownload('../diritti.json')).toEqual({
      outcome: 'not_found',
    });
    expect(await resolveFeaturedOfflineDownload(UNDECLARED)).toEqual({ outcome: 'not_found' });
    expect(await resolveFeaturedOfflineDownload('B'.repeat(22))).toEqual({ outcome: 'not_found' });
    // Anche con l'id "giusto" (HMAC del percorso) di un file non dichiarato.
    expect(await resolveFeaturedOfflineDownload(id(UNDECLARED))).toEqual({
      outcome: 'not_found',
    });
  });

  it('revoca: vale subito per il download, anche con l’indice ancora in cache', async () => {
    expect((await resolveFeaturedOfflineDownload(id(OWN))).outcome).toBe('allowed');
    // L'amministratore aggiorna diritti.json ("offline": false): l'elenco dello store è lo stesso
    // (in cache), ma il download rilegge il manifest.
    setManifest([{ ...BASE_ROWS[0], offline: false }, ...BASE_ROWS.slice(1)]);
    expect(await resolveFeaturedOfflineDownload(id(OWN))).toMatchObject({
      outcome: 'not_permitted',
      basis: 'opt_out',
    });
    // Voce tolta del tutto → come un brano sconosciuto.
    setManifest(BASE_ROWS.slice(1));
    expect(await resolveFeaturedOfflineDownload(id(OWN))).toEqual({ outcome: 'not_found' });
    // Manifest rovinato → nessun brano dichiarato.
    manifestText = '[]';
    expect(await resolveFeaturedOfflineDownload(id(OWN))).toEqual({ outcome: 'not_found' });
  });

  it('diritti.json illeggibile in questo momento → unavailable (nessun download)', async () => {
    await resolveFeaturedOfflineDownload(id(OWN)); // indice costruito
    mocks.get.mockRejectedValue(new Error('rete'));
    expect(await resolveFeaturedOfflineDownload(id(OWN))).toEqual({ outcome: 'unavailable' });
  });

  it('senza segreto del server (condivisione spenta) nessun id esiste', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', '');
    clearFeaturedSearchCacheForTests();
    expect(await resolveFeaturedOfflineDownload(id(OWN))).toEqual({ outcome: 'not_found' });
  });
});
