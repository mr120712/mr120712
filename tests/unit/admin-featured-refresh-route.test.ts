// @polsia:user-owned — POST /api/admin/featured-rights/refresh («Aggiorna ora»): stessa origine,
// solo admin con email verificata (401/403/503 senza toccare database o store), limite
// 'monitor.run.admin' con un'identità propria (429 con messaggio), incremento del contatore
// condiviso, cache di questa istanza svuotate (elenco nuovo, indice ricostruito) e risposta privata
// con la versione nuova; 503 se il database non accetta l'incremento.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  sameOrigin: vi.fn(),
  consumeRateLimit: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  consumeRateLimit: mocks.consumeRateLimit,
  enforceRateLimit: vi.fn(async () => null),
  getRateLimitIdentity: vi.fn(() => 'ip:192.0.2.9'),
}));
vi.mock('@vercel/blob', () => ({ list: mocks.list, get: mocks.get, head: vi.fn() }));
vi.mock('@/lib/env', () => ({
  env: { BLOB_READ_WRITE_TOKEN: 'tok_test', DATABASE_URL: 'postgresql://test' },
}));
vi.mock('@/lib/db', () => ({
  prisma: { featuredCatalogState: { findUnique: mocks.findUnique, upsert: mocks.upsert } },
}));

import { POST } from '@/app/api/admin/featured-rights/refresh/route';
import { AdminFeaturedRefreshResponseSchema } from '@/lib/contracts/admin-featured-rights';
import { loadFeaturedCatalogState } from '@/lib/music/featured-catalog.server';
import {
  clearFeaturedSearchCacheForTests,
  searchFeaturedTracks,
} from '@/lib/music/featured-search.server';

const PRIVATE = 'https://store.private.blob.vercel-storage.com';
const DECLARED = 'Cantautori/Lucio Dalla - Caruso.mp3';
const admin = { id: 'admin-1', role: 'admin', emailVerified: true };

function blob(pathname: string, uploadedAt = '2026-10-01T00:00:00.000Z', size = 1000) {
  const url = `${PRIVATE}/${pathname.split('/').map(encodeURIComponent).join('/')}`;
  return { pathname, url, downloadUrl: url, size, uploadedAt: new Date(uploadedAt) };
}

function storedText(text: string) {
  return {
    statusCode: 200,
    stream: new Response(text).body,
    headers: new Headers(),
    blob: { pathname: 'diritti.json', contentType: 'application/json', size: text.length },
  };
}

const STORE = [blob(DECLARED), blob('diritti.json', '2026-10-04T00:00:00.000Z', 200)];
const MANIFEST = JSON.stringify({
  versione: 1,
  brani: [{ file: DECLARED, licenza: 'propria', titolare: 'Solco' }],
});

function request() {
  return new Request('https://solco.test/api/admin/featured-rights/refresh', {
    method: 'POST',
    headers: { origin: 'https://solco.test' },
  });
}

let generation = 0;
const T0 = new Date('2026-11-15T10:00:00.000Z').getTime();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  for (const mock of Object.values(mocks)) mock.mockReset();
  generation = 0;
  mocks.sameOrigin.mockReturnValue(true);
  mocks.getSession.mockResolvedValue({ user: admin });
  mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
  mocks.findUnique.mockImplementation(async () => ({ generation }));
  mocks.upsert.mockImplementation(async () => {
    generation += 1;
    return { generation };
  });
  mocks.list.mockImplementation(async () => ({ blobs: STORE, hasMore: false }));
  mocks.get.mockImplementation(async () => storedText(MANIFEST));
  clearFeaturedSearchCacheForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('POST /api/admin/featured-rights/refresh: accesso', () => {
  it('origine diversa → 403 senza sessione, database o store', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'forbidden_origin' });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['senza sessione', null, 401, 'unauthorized'],
    ['utente non admin', { user: { ...admin, role: 'user' } }, 403, 'forbidden'],
    [
      'admin con email non verificata',
      { user: { ...admin, emailVerified: false } },
      403,
      'forbidden',
    ],
  ])('%s → %i', async (_label, session, status, error) => {
    mocks.getSession.mockResolvedValue(session);
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('sessione non verificabile → 503', async () => {
    mocks.getSession.mockRejectedValue(new Error('db'));
    expect((await POST(request())).status).toBe(503);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('limite raggiunto → 429 con messaggio e Retry-After, nessun incremento', async () => {
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: false,
      status: 429,
      error: 'rate_limited',
      message: 'limite',
      retryAfterSeconds: 240,
    });
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('240');
    expect((await response.json()).message).toBe(
      'Hai già aggiornato i brani in evidenza più volte di recente. Riprova tra 4 minuti.',
    );
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith(
      'monitor.run.admin',
      'featured-refresh:user:admin-1',
    );
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/featured-rights/refresh: aggiornamento', () => {
  it('incrementa il contatore, rielenca subito lo store e risponde con la versione nuova', async () => {
    const before = await loadFeaturedCatalogState();
    expect((await searchFeaturedTracks('caruso')).tracks).toHaveLength(1);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledTimes(1);

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = AdminFeaturedRefreshResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ generation: 1, stale: false });
    expect(body.version).not.toBe(before.version);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    // Cache di questa istanza svuotate: elenco nuovo (dentro la finestra di 30 s)…
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect((await loadFeaturedCatalogState()).version).toBe(body.version);
    // …e indice ricostruito (diritti.json riletto).
    expect((await searchFeaturedTracks('caruso')).tracks).toHaveLength(1);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('ogni pressione incrementa ancora (mai all’indietro)', async () => {
    const first = AdminFeaturedRefreshResponseSchema.parse(await (await POST(request())).json());
    const second = AdminFeaturedRefreshResponseSchema.parse(await (await POST(request())).json());
    expect([first.generation, second.generation]).toEqual([1, 2]);
    expect(second.version).not.toBe(first.version);
  });

  it('store in errore durante l’aggiornamento: resta l’ultima versione buona, `stale: true`', async () => {
    const before = await loadFeaturedCatalogState();
    mocks.list.mockRejectedValue(new Error('blob down'));
    const body = AdminFeaturedRefreshResponseSchema.parse(await (await POST(request())).json());
    expect(body).toMatchObject({ generation: 1, stale: true, version: before.version });
  });

  it('database che non accetta l’incremento → 503 generico, niente cambiato', async () => {
    const before = await loadFeaturedCatalogState();
    mocks.upsert.mockRejectedValue(new Error('db down'));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'featured_refresh_failed' });
    expect((await loadFeaturedCatalogState()).version).toBe(before.version);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });
});
