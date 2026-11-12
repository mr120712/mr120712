// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: vi.fn(async () => ({ id: 'u1' }) as { id: string } | null),
  limited: vi.fn(async () => null as Response | null),
  plan: vi.fn(),
  sameOrigin: vi.fn(() => true),
  premium: vi.fn(async () => true),
  access: vi.fn(),
  available: vi.fn(async () => true),
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
vi.mock('@/lib/business/ai-music-search.server', () => ({
  aiSearchAvailable: mocks.available,
  planMusicSearch: mocks.plan,
}));

import { GET, POST } from '@/app/api/music/ai-search/route';

const post = (body: unknown) =>
  POST(
    new Request('https://solco.test/api/music/ai-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://solco.test' },
      body: JSON.stringify(body),
    }),
  );

const plan = {
  intro: 'Ecco.',
  youtubeQueries: ['a'],
  audioQueries: [],
  radioTags: [],
  podcastQuery: null,
  genres: [],
};

beforeEach(() => {
  mocks.user.mockReset().mockResolvedValue({ id: 'u1' });
  mocks.limited.mockReset().mockResolvedValue(null);
  mocks.plan.mockReset().mockResolvedValue({ ok: true, plan, cached: false });
  mocks.sameOrigin.mockReset().mockReturnValue(true);
  mocks.premium.mockReset().mockResolvedValue(true);
  mocks.access
    .mockReset()
    .mockImplementation(async () => ({ signedIn: true, premium: await mocks.premium() }));
  mocks.available.mockReset().mockResolvedValue(true);
});

describe('route /api/music/ai-search', () => {
  it('dice al client se il pulsante è attivo e se l’utente può usarlo', async () => {
    expect(await (await GET()).json()).toEqual({ enabled: true, signedIn: true, premium: true });
    mocks.premium.mockResolvedValueOnce(false);
    expect(await (await GET()).json()).toMatchObject({ premium: false });
  });

  it('con una chiave mancante, sbagliata o rifiutata il pulsante non viene offerto', async () => {
    mocks.available.mockResolvedValueOnce(false);
    expect(await (await GET()).json()).toEqual({ enabled: false, signedIn: false, premium: false });
    expect(mocks.access).not.toHaveBeenCalled();
  });

  it('è inclusa nei piani a pagamento: un utente Free riceve 402 e Claude non viene chiamato', async () => {
    mocks.premium.mockResolvedValueOnce(false);
    const response = await post({ prompt: 'jazz per cena' });
    expect(response.status).toBe(402);
    expect((await response.json()).error).toBe('premium_required');
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.limited).not.toHaveBeenCalled();
  });

  it('restituisce il piano a un utente registrato', async () => {
    const response = await post({ prompt: 'jazz per cena' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ plan, cached: false });
    expect(mocks.plan).toHaveBeenCalledWith('jazz per cena', 'u1');
    expect(mocks.limited).toHaveBeenCalledWith('music.ai_search', 'user:u1');
    expect(mocks.limited).toHaveBeenCalledWith('music.ai_search.global', 'global');
  });

  it('rifiuta ospiti, altre origini, testi non validi e richieste oltre il limite', async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);
    expect((await post({ prompt: 'jazz' })).status).toBe(403);

    mocks.user.mockResolvedValueOnce(null);
    expect((await post({ prompt: 'jazz' })).status).toBe(401);

    const invalid = await post({ prompt: 'x' });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).errors.prompt).toContain('almeno 3');

    mocks.limited.mockResolvedValueOnce(Response.json({ error: 'rate_limited' }, { status: 429 }));
    expect((await post({ prompt: 'jazz per cena' })).status).toBe(429);
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it('traduce gli errori dell’AI in messaggi chiari', async () => {
    mocks.plan.mockResolvedValueOnce({ ok: false, error: 'busy' });
    const response = await post({ prompt: 'jazz per cena' });
    expect(response.status).toBe(503);
    expect((await response.json()).message).toContain('Riprova');

    mocks.plan.mockResolvedValueOnce({ ok: false, error: 'not_configured' });
    const off = await post({ prompt: 'jazz per cena' });
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({
      error: 'not_configured',
      message: 'La ricerca con l’AI non è ancora attiva.',
    });
  });
});
