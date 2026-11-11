// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: vi.fn(async () => ({ id: 'u1' }) as { id: string } | null),
  limited: vi.fn(async () => null as Response | null),
  plan: vi.fn(),
  sameOrigin: vi.fn(() => true),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ getSessionUser: mocks.user }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.limited,
  getRateLimitIdentity: (id: string) => `user:${id}`,
}));
vi.mock('@/lib/business/ai-music-search.server', () => ({
  aiSearchConfigured: () => true,
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
});

describe('route /api/music/ai-search', () => {
  it('dice al client se il pulsante è attivo', async () => {
    expect(await (await GET()).json()).toEqual({ enabled: true });
  });

  it('restituisce il piano a un utente registrato', async () => {
    const response = await post({ prompt: 'jazz per cena' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ plan, cached: false });
    expect(mocks.plan).toHaveBeenCalledWith('jazz per cena');
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
  });
});
