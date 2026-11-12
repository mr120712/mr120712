// @polsia:user-owned — la route /api/music/ai-organize: guardie (origine, login, Premium, limiti),
// tetto del corpo, forma della risposta e traduzione degli errori. Il motore è simulato.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: vi.fn(async () => ({ id: 'u1' }) as { id: string } | null),
  limited: vi.fn(async () => null as Response | null),
  organize: vi.fn(),
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
vi.mock('@/lib/business/ai-long-organize.server', () => ({
  organizeAvailable: mocks.available,
  organizeLongText: mocks.organize,
}));

import { GET, POST } from '@/app/api/music/ai-organize/route';

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request('https://solco.test/api/music/ai-organize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://solco.test', ...headers },
      body: JSON.stringify(body),
    }),
  );

const okResult = {
  ok: true,
  tracks: [
    { title: 'Song A', artist: 'Artist X' },
    { title: 'Song B', artist: '' },
  ],
  trackListText: 'Artist X - Song A\nSong B',
  note: 'Trovati 2 brani.',
  inputTokens: 1234,
  approxUsd: 0.0123,
  truncated: 0,
};
const longText = 'Una scaletta lunghissima con tante canzoni.';

beforeEach(() => {
  mocks.user.mockReset().mockResolvedValue({ id: 'u1' });
  mocks.limited.mockReset().mockResolvedValue(null);
  mocks.organize.mockReset().mockResolvedValue(okResult);
  mocks.sameOrigin.mockReset().mockReturnValue(true);
  mocks.premium.mockReset().mockResolvedValue(true);
  mocks.access
    .mockReset()
    .mockImplementation(async () => ({ signedIn: true, premium: await mocks.premium() }));
  mocks.available.mockReset().mockResolvedValue(true);
});

describe('route /api/music/ai-organize', () => {
  it('GET dice se il pulsante è attivo e se l’utente può usarlo', async () => {
    expect(await (await GET()).json()).toEqual({ enabled: true, signedIn: true, premium: true });
    mocks.available.mockResolvedValueOnce(false);
    expect(await (await GET()).json()).toEqual({ enabled: false, signedIn: false, premium: false });
    // Con la funzione spenta non si interroga nemmeno l’accesso.
    expect(mocks.access).toHaveBeenCalledTimes(1);
  });

  it('restituisce i brani e le righe pronte per l’importazione', async () => {
    const response = await post({ text: longText, name: 'Concerto' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tracks: okResult.tracks,
      trackListText: okResult.trackListText,
      note: okResult.note,
      inputTokens: okResult.inputTokens,
      approxUsd: okResult.approxUsd,
      truncated: okResult.truncated,
    });
    expect(mocks.organize).toHaveBeenCalledWith(longText, 'u1');
    expect(mocks.limited).toHaveBeenCalledWith('ai.organize', 'user:u1');
    expect(mocks.limited).toHaveBeenCalledWith('ai.organize.global', 'global');
  });

  it('è Premium: un utente Free riceve 402 e l’AI non viene chiamata', async () => {
    mocks.premium.mockResolvedValueOnce(false);
    const response = await post({ text: longText });
    expect(response.status).toBe(402);
    expect((await response.json()).error).toBe('premium_required');
    expect(mocks.organize).not.toHaveBeenCalled();
    expect(mocks.limited).not.toHaveBeenCalled();
  });

  it('rifiuta altre origini, ospiti, testi non validi e richieste oltre il limite', async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);
    expect((await post({ text: longText })).status).toBe(403);

    mocks.user.mockResolvedValueOnce(null);
    expect((await post({ text: longText })).status).toBe(401);

    const invalid = await post({ text: 'corto' });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).errors.text).toContain('almeno');

    mocks.limited.mockResolvedValueOnce(Response.json({ error: 'rate_limited' }, { status: 429 }));
    expect((await post({ text: longText })).status).toBe(429);
    expect(mocks.organize).not.toHaveBeenCalled();
  });

  it('rifiuta un corpo troppo grande (413) senza chiamare l’AI', async () => {
    const response = await post({ text: longText }, { 'content-length': String(5_000_000) });
    expect(response.status).toBe(413);
    expect(mocks.organize).not.toHaveBeenCalled();
  });

  it('traduce gli errori dell’AI in messaggi chiari', async () => {
    mocks.organize.mockResolvedValueOnce({ ok: false, error: 'busy' });
    const busy = await post({ text: longText });
    expect(busy.status).toBe(503);
    expect((await busy.json()).message).toContain('Riprova');

    mocks.organize.mockResolvedValueOnce({ ok: false, error: 'empty' });
    const empty = await post({ text: longText });
    expect(empty.status).toBe(422);
    expect((await empty.json()).error).toBe('empty');

    mocks.organize.mockResolvedValueOnce({ ok: false, error: 'not_configured' });
    const off = await post({ text: longText });
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({
      error: 'not_configured',
      message: 'L’organizzazione con l’AI non è ancora attiva.',
    });
  });

  it('un testo troppo lungo (oltre il tetto di token) torna 413 con il conteggio', async () => {
    mocks.organize.mockResolvedValueOnce({
      ok: false,
      error: 'too_large',
      inputTokens: 500_000,
      maxInputTokens: 400_000,
    });
    const response = await post({ text: longText });
    expect(response.status).toBe(413);
    const json = await response.json();
    expect(json).toMatchObject({
      error: 'too_large',
      inputTokens: 500_000,
      maxInputTokens: 400_000,
    });
    expect(json.message).toContain('token');
  });
});
