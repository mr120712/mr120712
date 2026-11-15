// @polsia:user-owned — copia offline dei brani in evidenza lato client e verifica dei permessi:
// piano (solo `offline` true con id scaricabili, gli altri «solo streaming» con il motivo),
// salvataggio con registro delle copie (fail closed se il registro non si scrive), endpoint di
// verifica (same-origin, zod, sessione facoltativa, 503 = copie tenute) e sincronizzazione (toglie
// SOLO le copie revocate, tiene tutto con errori di rete, manda solo gli id delle copie in evidenza).
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  sameOrigin: vi.fn(() => true),
  getSession: vi.fn(),
  enforce: vi.fn(),
  status: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforce,
  getRateLimitIdentity: (userId: string | null) => (userId ? `user:${userId}` : 'ip:192.0.2.1'),
}));
vi.mock('@/lib/music/featured-search.server', () => ({ getFeaturedOfflineStatus: mocks.status }));
vi.mock('@/lib/local-music', () => ({
  addDownloadedTrack: vi.fn(),
  removeTrack: vi.fn(),
  listTracks: vi.fn(async () => []),
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));

import { POST as offlineStatus } from '@/app/api/music/featured/offline-status/route';
import {
  type CopyStorage,
  canRememberFeaturedCopies,
  FEATURED_OFFLINE_COPIES_KEY,
  featuredCopiesByLocalId,
  forgetFeaturedCopies,
  readFeaturedCopies,
  rememberFeaturedCopy,
} from '@/components/custom/music/featured-offline-copies';
import {
  featuredRevokedNotice,
  syncFeaturedOfflineCopies,
} from '@/components/custom/music/featured-offline-sync';
import {
  downloadOne,
  featuredDownloadPlan,
  featuredDownloadTarget,
  offlineDownloadPath,
} from '@/components/custom/music/offline-download';
import type { OfflineDownloadMeta } from '@/lib/contracts/offline';
import type { LocalTrack } from '@/lib/local-music';

const ID_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const ID_B = 'BBBBBBBBBBBBBBBBBBBBBB';
const ID_C = 'CCCCCCCCCCCCCCCCCCCCCC';

function memoryStorage(): CopyStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function brokenStorage(): CopyStorage {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => undefined,
  };
}

const featuredMeta = (shareId: string): OfflineDownloadMeta => ({
  source: 'featured-download',
  downloadKey: `featured:${shareId}`,
  title: 'Aperta',
  artist: 'Band',
  album: null,
  durationSeconds: null,
  mimeType: 'audio/mpeg',
  attribution: {
    sourceName: 'Solco · In evidenza',
    sourceUrl: null,
    licenseName: 'Creative Commons Attribuzione (CC BY)',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/deed.it',
    creditLine: '© Band',
  },
});

function okResponse(meta: OfflineDownloadMeta) {
  const header = Buffer.from(JSON.stringify(meta), 'utf8').toString('base64');
  return new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { 'content-type': 'audio/mpeg', 'x-solco-download': header },
  });
}

function localTrack(id: string): LocalTrack {
  return {
    id,
    title: `Brano ${id}`,
    artist: null,
    album: null,
    durationSeconds: 100,
    mimeType: 'audio/mpeg',
    size: 3,
    addedAt: 1,
    hasArtwork: false,
  };
}

beforeEach(() => {
  mocks.sameOrigin.mockReset().mockReturnValue(true);
  mocks.getSession.mockReset().mockResolvedValue(null);
  mocks.enforce.mockReset().mockResolvedValue(null);
  mocks.status.mockReset();
  mocks.toast.mockReset();
});

describe('piano e bersagli dei brani in evidenza', () => {
  const tracks = [
    { id: 'a.mp3', title: 'Concesso', shareId: ID_A, offline: true },
    { id: 'b.mp3', title: 'Solo streaming', shareId: ID_B, offline: false },
    { id: 'c.mp3', title: 'Senza id', shareId: null, offline: true },
    { id: 'd.mp3', title: 'Senza campo', shareId: ID_C },
  ];

  it('scarica SOLO i brani con offline true e un id; gli altri restano online con il motivo', () => {
    const plan = featuredDownloadPlan(tracks);
    expect(plan.downloadable).toEqual([
      { id: 'a.mp3', title: 'Concesso', endpoint: { kind: 'featured', shareId: ID_A } },
    ]);
    expect(plan.resolvable).toEqual([]);
    expect(plan.onlineOnly.map((item) => [item.id, item.reason])).toEqual([
      [
        'b.mp3',
        'Il titolare non ha concesso la copia offline: questo brano si ascolta solo in streaming.',
      ],
      ['c.mp3', 'Questo brano in evidenza non è disponibile per la copia offline.'],
      ['d.mp3', 'Questo brano in evidenza non è disponibile per la copia offline.'],
    ]);
    expect(featuredDownloadTarget(tracks[1] as (typeof tracks)[number])).toBeNull();
  });

  it('la rotta usa l’id opaco, mai il percorso nello store', () => {
    expect(offlineDownloadPath({ kind: 'featured', shareId: ID_A })).toBe(
      `/api/music/featured/tracks/${ID_A}/download`,
    );
  });
});

describe('downloadOne: copia di un brano in evidenza', () => {
  const target = {
    id: 'a.mp3',
    title: 'Aperta',
    endpoint: { kind: 'featured', shareId: ID_A },
  } as const;

  it('salva con la fonte e la chiave del brano e registra la copia con l’attribuzione', async () => {
    const storage = memoryStorage();
    const addDownloaded = vi.fn(async () => ({ ok: true as const, track: localTrack('local-1') }));
    const fetcher = vi.fn(async () => okResponse(featuredMeta(ID_A)));
    const outcome = await downloadOne(target, { fetcher, addDownloaded, copyStorage: storage });
    expect(outcome.status).toBe('saved');
    expect(fetcher).toHaveBeenCalledWith(
      `/api/music/featured/tracks/${ID_A}/download`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(addDownloaded).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'featured-download', downloadKey: `featured:${ID_A}` }),
    );
    expect(readFeaturedCopies(storage)).toEqual([
      expect.objectContaining({
        localId: 'local-1',
        featuredId: ID_A,
        attribution: featuredMeta(ID_A).attribution,
      }),
    ]);
  });

  it('registro non scrivibile: nessuna richiesta (nessun download consumato), errore leggibile', async () => {
    const fetcher = vi.fn();
    const outcome = await downloadOne(target, { fetcher, copyStorage: brokenStorage() });
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await downloadOne(target, { fetcher, copyStorage: null })).toMatchObject({
      status: 'failed',
    });
  });

  it('registrazione fallita dopo il salvataggio: la copia si toglie dal dispositivo', async () => {
    const storage = memoryStorage();
    // Scrivibile per la prova iniziale, poi pieno.
    let writes = 0;
    const flaky: CopyStorage = {
      ...storage,
      setItem: (key, value) => {
        writes += 1;
        if (writes > 1) throw new Error('QuotaExceededError');
        storage.setItem(key, value);
      },
    };
    const removeDownloaded = vi.fn(async () => undefined);
    const outcome = await downloadOne(target, {
      fetcher: vi.fn(async () => okResponse(featuredMeta(ID_A))),
      addDownloaded: vi.fn(async () => ({ ok: true as const, track: localTrack('local-9') })),
      removeDownloaded,
      copyStorage: flaky,
    });
    expect(outcome.status).toBe('failed');
    expect(removeDownloaded).toHaveBeenCalledWith('local-9');
  });

  it('header di un altro brano o di un’altra fonte: non si salva nulla', async () => {
    const addDownloaded = vi.fn();
    for (const meta of [
      featuredMeta(ID_B),
      { ...featuredMeta(ID_A), source: 'audius-download' as const },
    ]) {
      const outcome = await downloadOne(target, {
        fetcher: vi.fn(async () => okResponse(meta)),
        addDownloaded,
        copyStorage: memoryStorage(),
      });
      expect(outcome.status).toBe('failed');
    }
    // Nemmeno una rotta Audius può salvare una copia "in evidenza" (sfuggirebbe alla revoca).
    const outcome = await downloadOne(
      { id: 'x', title: 'X', endpoint: { kind: 'audius', trackId: 'trk' } },
      { fetcher: vi.fn(async () => okResponse(featuredMeta(ID_A))), addDownloaded },
    );
    expect(outcome.status).toBe('failed');
    expect(addDownloaded).not.toHaveBeenCalled();
  });

  it('403 dalla rotta (permesso revocato nel frattempo): resta solo in streaming', async () => {
    const outcome = await downloadOne(target, {
      fetcher: vi.fn(async () =>
        Response.json(
          {
            error: 'offline_not_allowed',
            message: 'Il titolare non ha concesso la copia offline.',
          },
          { status: 403 },
        ),
      ),
      copyStorage: memoryStorage(),
    });
    expect(outcome).toEqual({
      status: 'online-only',
      target,
      reason: 'Il titolare non ha concesso la copia offline.',
    });
  });
});

describe('registro delle copie', () => {
  it('ricorda, dimentica e scarta voci rovinate', () => {
    const storage = memoryStorage();
    expect(canRememberFeaturedCopies(storage)).toBe(true);
    expect(canRememberFeaturedCopies(brokenStorage())).toBe(false);
    expect(
      rememberFeaturedCopy(
        { localId: 'l1', featuredId: ID_A, attribution: null, savedAt: 1 },
        storage,
      ),
    ).toBe(true);
    expect(
      rememberFeaturedCopy(
        { localId: 'l2', featuredId: 'non valido', attribution: null, savedAt: 1 },
        storage,
      ),
    ).toBe(false);
    expect([...featuredCopiesByLocalId(storage).keys()]).toEqual(['l1']);
    forgetFeaturedCopies(['l1'], storage);
    expect(storage.data.has(FEATURED_OFFLINE_COPIES_KEY)).toBe(false);
    storage.setItem(FEATURED_OFFLINE_COPIES_KEY, '{"copies":[{"localId":"x"},"rotto"]}');
    expect(readFeaturedCopies(storage)).toEqual([]);
    storage.setItem(FEATURED_OFFLINE_COPIES_KEY, 'non json');
    expect(readFeaturedCopies(storage)).toEqual([]);
  });
});

describe('POST /api/music/featured/offline-status', () => {
  const request = (body: unknown) =>
    new Request('https://solco.test/api/music/featured/offline-status', {
      method: 'POST',
      headers: { origin: 'https://solco.test', 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('rifiuta una richiesta non same-origin', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    expect((await offlineStatus(request({ ids: [ID_A] }))).status).toBe(403);
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it('400 per un corpo non valido (id malformati, troppi, campi in più)', async () => {
    for (const body of [
      'non json',
      { ids: [] },
      { ids: ['../diritti.json'] },
      { ids: Array.from({ length: 101 }, () => ID_A) },
      { ids: [ID_A], file: 'Rock/x.mp3' },
    ]) {
      const response = await offlineStatus(request(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        errors: { ids: 'Elenco dei brani non valido (da 1 a 100 id).' },
      });
    }
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it('200: permessi e revocati, mai in cache; sessione facoltativa, limite per identità', async () => {
    mocks.status.mockResolvedValue({ outcome: 'ok', permitted: [ID_A], revoked: [ID_B] });
    const response = await offlineStatus(request({ ids: [ID_A, ID_B] }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ permitted: [ID_A], revoked: [ID_B] });
    expect(mocks.enforce).toHaveBeenCalledWith('music.catalog', 'ip:192.0.2.1');
    mocks.getSession.mockResolvedValue({ user: { id: 'u1' } });
    await offlineStatus(request({ ids: [ID_A] }));
    expect(mocks.enforce).toHaveBeenLastCalledWith('music.catalog', 'user:u1');
  });

  it('503 se non si può verificare (le copie restano); 429 inoltrato', async () => {
    mocks.status.mockResolvedValue({ outcome: 'unavailable' });
    expect((await offlineStatus(request({ ids: [ID_A] }))).status).toBe(503);
    mocks.enforce.mockResolvedValue(Response.json({ error: 'rate_limited' }, { status: 429 }));
    expect((await offlineStatus(request({ ids: [ID_A] }))).status).toBe(429);
  });
});

describe('syncFeaturedOfflineCopies: revoca delle copie salvate', () => {
  function setup(copies: Array<[string, string]>, present: string[]) {
    const storage = memoryStorage();
    for (const [localId, featuredId] of copies) {
      rememberFeaturedCopy({ localId, featuredId, attribution: null, savedAt: 1 }, storage);
    }
    const removeTrack = vi.fn(async () => undefined);
    const listTracks = vi.fn(async () => present.map(localTrack));
    return { storage, removeTrack, listTracks };
  }

  it('toglie SOLO le copie revocate e le dimentica; manda solo gli id delle copie in evidenza', async () => {
    const { storage, removeTrack, listTracks } = setup(
      [
        ['l1', ID_A],
        ['l2', ID_B],
      ],
      ['l1', 'l2', 'file-mio'],
    );
    const fetcher = vi.fn(async () => Response.json({ permitted: [ID_A], revoked: [ID_B] }));
    const result = await syncFeaturedOfflineCopies({ fetcher, listTracks, removeTrack, storage });
    expect(result).toEqual({ status: 'ok', removed: 1 });
    expect(removeTrack).toHaveBeenCalledTimes(1);
    expect(removeTrack).toHaveBeenCalledWith('l2');
    expect(readFeaturedCopies(storage).map((copy) => copy.localId)).toEqual(['l1']);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/music/featured/offline-status');
    expect(JSON.parse(String(init.body))).toEqual({ ids: [ID_A, ID_B] });
    expect(String(init.body)).not.toContain('file-mio');
    expect(featuredRevokedNotice(1)).toContain('non è più disponibile offline');
  });

  it('errore di rete, 503 o risposta non valida: tiene tutte le copie e chiede di riprovare', async () => {
    for (const fetcher of [
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
      vi.fn(async () => Response.json({ error: 'unavailable' }, { status: 503 })),
      vi.fn(async () => Response.json({ tutto: 'revocato' })),
    ]) {
      const { storage, removeTrack, listTracks } = setup([['l1', ID_A]], ['l1']);
      const result = await syncFeaturedOfflineCopies({
        fetcher: fetcher as unknown as typeof fetch,
        listTracks,
        removeTrack,
        storage,
      });
      expect(result).toEqual({ status: 'retry', removed: 0 });
      expect(removeTrack).not.toHaveBeenCalled();
      expect(readFeaturedCopies(storage)).toHaveLength(1);
    }
  });

  it('copie tolte a mano: dimenticate senza chiedere nulla al server', async () => {
    const { storage, removeTrack, listTracks } = setup([['l1', ID_A]], []);
    const fetcher = vi.fn();
    expect(await syncFeaturedOfflineCopies({ fetcher, listTracks, removeTrack, storage })).toEqual({
      status: 'skipped',
      removed: 0,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(readFeaturedCopies(storage)).toEqual([]);
  });

  it('a lotti di al massimo 100 id', async () => {
    const copies = Array.from({ length: 150 }, (_, index): [string, string] => [
      `l${index}`,
      `${String(index).padStart(3, '0')}${'X'.repeat(19)}`,
    ]);
    const { storage, removeTrack, listTracks } = setup(
      copies,
      copies.map(([localId]) => localId),
    );
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const { ids } = JSON.parse(String(init?.body)) as { ids: string[] };
      expect(ids.length).toBeLessThanOrEqual(100);
      return Response.json({ permitted: ids, revoked: [] });
    });
    const result = await syncFeaturedOfflineCopies({
      fetcher: fetcher as unknown as typeof fetch,
      listTracks,
      removeTrack,
      storage,
    });
    expect(result).toEqual({ status: 'ok', removed: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
