// @polsia:user-owned — API di «Potrebbe piacerti»: lettura solo con l'accesso e sempre privata
// (private, no-store, Vary: Cookie: mai in una cache condivisa), limite per utente, query valida;
// «Non mi interessa» solo dalla stessa origine, con l'accesso, corpo zod rigoroso e limite.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/require-auth';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(async (): Promise<Response | null> => null),
  getRecommendations: vi.fn(),
  hide: vi.fn(async () => undefined),
  unhide: vi.fn(async () => undefined),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock('@/lib/music/recommendations.server', () => ({
  getRecommendations: mocks.getRecommendations,
  hideRecommendation: mocks.hide,
  unhideRecommendation: mocks.unhide,
}));

import { POST } from '@/app/api/music/recommendations/feedback/route';
import { GET } from '@/app/api/music/recommendations/route';

const account = { id: 'account-a' } as unknown as SessionUser;
const SONG = `song:${'a'.repeat(32)}`;

function get(query = '') {
  return GET(new Request(`https://solco.test/api/music/recommendations${query}`));
}

function post(body: unknown) {
  return POST(
    new Request('https://solco.test/api/music/recommendations/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://solco.test' },
      body: JSON.stringify(body),
    }),
  );
}

function expectPrivate(response: Response) {
  const cache = response.headers.get('cache-control') ?? '';
  expect(cache).toContain('private');
  expect(cache).toContain('no-store');
  expect(cache).not.toContain('s-maxage');
  expect(cache).not.toContain('public');
  expect(response.headers.get('vary')).toBe('Cookie');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue(account);
  mocks.sameOrigin.mockReturnValue(true);
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.getRecommendations.mockResolvedValue({
    mode: 'personal',
    items: [],
    page: 0,
    nextPage: null,
  });
});

describe('GET /api/music/recommendations', () => {
  it('richiede l’accesso (anche il 401 è privato)', async () => {
    mocks.requireAuth.mockRejectedValueOnce(new Response(null, { status: 401 }));
    const response = await get();
    expect(response.status).toBe(401);
    expectPrivate(response);
    expect(mocks.getRecommendations).not.toHaveBeenCalled();
  });

  it('risponde con i consigli dell’utente, mai in cache condivisa', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(await response.json()).toEqual({ mode: 'personal', items: [], page: 0, nextPage: null });
    expect(mocks.getRecommendations).toHaveBeenCalledWith('account-a', {
      page: 0,
      personal: true,
    });
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('music.recommendations', 'user:account-a');
  });

  it('pagina e consigli personalizzati spenti passano al motore', async () => {
    await get('?page=3&personal=0');
    expect(mocks.getRecommendations).toHaveBeenCalledWith('account-a', {
      page: 3,
      personal: false,
    });
  });

  it('query non valida: 400', async () => {
    for (const query of ['?page=-1', '?page=999', '?page=abc', '?personal=forse']) {
      const response = await get(query);
      expect(response.status).toBe(400);
      expectPrivate(response);
    }
    expect(mocks.getRecommendations).not.toHaveBeenCalled();
  });

  it('limite per utente superato: 429 senza calcolare nulla', async () => {
    mocks.enforceRateLimit.mockResolvedValueOnce(
      Response.json({ error: 'rate_limited' }, { status: 429 }),
    );
    const response = await get();
    expect(response.status).toBe(429);
    expect(response.headers.get('vary')).toBe('Cookie');
    expect(mocks.getRecommendations).not.toHaveBeenCalled();
  });

  it('errore del motore: 503 privato', async () => {
    mocks.getRecommendations.mockRejectedValueOnce(new Error('db down'));
    const response = await get();
    expect(response.status).toBe(503);
    expectPrivate(response);
  });
});

describe('POST /api/music/recommendations/feedback', () => {
  it('rifiuta un’altra origine prima di tutto', async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);
    const response = await post({ kind: 'hide', itemKey: 'audius:abc' });
    expect(response.status).toBe(403);
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(mocks.hide).not.toHaveBeenCalled();
  });

  it('richiede l’accesso', async () => {
    mocks.requireAuth.mockRejectedValueOnce(new Response(null, { status: 401 }));
    const response = await post({ kind: 'hide', itemKey: 'audius:abc' });
    expect(response.status).toBe(401);
    expect(mocks.hide).not.toHaveBeenCalled();
  });

  it('nasconde e annulla per l’utente autenticato', async () => {
    const hidden = await post({ kind: 'hide', itemKey: 'audius:abc' });
    expect(hidden.status).toBe(200);
    expectPrivate(hidden);
    expect(await hidden.json()).toEqual({ ok: true });
    expect(mocks.hide).toHaveBeenCalledWith('account-a', 'audius:abc');
    const undone = await post({ kind: 'unhide', itemKey: SONG });
    expect(undone.status).toBe(200);
    expect(mocks.unhide).toHaveBeenCalledWith('account-a', SONG);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith(
      'music.recommendations.feedback',
      'user:account-a',
    );
  });

  it('corpo non valido: 400 (chiavi di brani caricati, locali, YouTube o campi in più)', async () => {
    for (const body of [
      { kind: 'hide', itemKey: 'upload:clxfeaturedtrack0000001' },
      { kind: 'hide', itemKey: 'local:abc' },
      { kind: 'hide', itemKey: 'youtube:abcdefghijk' },
      { kind: 'hide', itemKey: 'song:XYZ' },
      { kind: 'delete', itemKey: 'audius:abc' },
      { kind: 'hide', itemKey: 'audius:abc', userId: 'someone-else' },
      'non json',
    ]) {
      const response = await post(body);
      expect(response.status).toBe(400);
    }
    expect(mocks.hide).not.toHaveBeenCalled();
    expect(mocks.unhide).not.toHaveBeenCalled();
  });

  it('limite superato: 429 senza scrivere', async () => {
    mocks.enforceRateLimit.mockResolvedValueOnce(
      Response.json({ error: 'rate_limited' }, { status: 429 }),
    );
    const response = await post({ kind: 'hide', itemKey: 'audius:abc' });
    expect(response.status).toBe(429);
    expect(mocks.hide).not.toHaveBeenCalled();
  });
});
