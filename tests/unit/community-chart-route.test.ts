// @polsia:user-owned — POST /api/music/public-uploads/[id]/play: resta same-origin e limitata per
// rete (IPv6: per /64, letto SOLO da x-real-ip, mai da header inventabili dal client); conta solo
// chi può davvero ascoltare (account Premium; ospiti e account gratuiti no); la risposta non rivela
// se l'ascolto è stato contato.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// Logica della libreria pubblica con l'interruttore ACCESO (src/lib/features.ts): così resta
// verificata e pronta per la riattivazione. Lo stato spento ha i suoi test (public-uploads-disabled).
vi.mock('@/lib/features', () => ({ publicUploadsEnabled: () => true }));

const mocks = vi.hoisted(() => ({
  sameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
  getSessionUser: vi.fn(),
  premium: vi.fn(),
  record: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/require-auth', () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock('@/lib/business/premium-access.server', () => ({ hasPremiumAccess: mocks.premium }));
// getRateLimitIdentity e networkIdentity restano quelli veri: la rete deve venire dalla stessa
// fonte dei limiti, e un IPv6 deve diventare il suo /64.
vi.mock('@/lib/business/rate-limit.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/business/rate-limit.server')>()),
  enforceRateLimit: mocks.enforceRateLimit,
}));
vi.mock('@/lib/music/public-uploads.server', () => ({ recordPublicUploadPlay: mocks.record }));

import { POST } from '@/app/api/music/public-uploads/[uploadId]/play/route';

const ID = 'c'.repeat(25);

function request(headers: Record<string, string> = {}) {
  return new Request(`https://solco.example/api/music/public-uploads/${ID}/play`, {
    method: 'POST',
    headers: { origin: 'https://solco.example', ...headers },
  });
}

function play(headers?: Record<string, string>, uploadId = ID) {
  return POST(request(headers), { params: Promise.resolve({ uploadId }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  // Il sito non dichiara Cloudflare: vale solo x-real-ip (impostato da Vercel).
  vi.stubEnv('TRUST_CLOUDFLARE_IP', '');
  mocks.sameOrigin.mockReturnValue(true);
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.getSessionUser.mockResolvedValue(null);
  mocks.premium.mockResolvedValue(false);
  mocks.record.mockResolvedValue(true);
});

describe('POST /api/music/public-uploads/[id]/play', () => {
  it('403 da un’altra origine: nessun limite consumato, nessun ascolto', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const response = await play({ 'x-real-ip': '203.0.113.7' });
    expect(response.status).toBe(403);
    expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('404 per un id non valido', async () => {
    expect((await play({}, 'NON-VALIDO')).status).toBe(404);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('resta limitata per rete: oltre il limite risponde 429 e non conta', async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 'user-1' });
    mocks.premium.mockResolvedValue(true);
    mocks.enforceRateLimit.mockResolvedValue(
      Response.json({ error: 'rate_limited' }, { status: 429 }),
    );
    const response = await play({ 'x-real-ip': '203.0.113.7' });
    expect(response.status).toBe(429);
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('listening.write', 'play:ip:203.0.113.7');
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('IPv6: indirizzi diversi dello stesso /64 condividono lo stesso limite', async () => {
    await play({ 'x-real-ip': '2001:db8:1234:5678::1' });
    await play({ 'x-real-ip': '2001:DB8:1234:5678:ffff:ffff:ffff:64' });
    expect(mocks.enforceRateLimit.mock.calls).toEqual([
      ['listening.write', 'play:ip6:2001:db8:1234:5678::/64'],
      ['listening.write', 'play:ip6:2001:db8:1234:5678::/64'],
    ]);
    // Un IPv4 mappato in IPv6 torna IPv4.
    await play({ 'x-real-ip': '::ffff:203.0.113.7' });
    expect(mocks.enforceRateLimit).toHaveBeenLastCalledWith(
      'listening.write',
      'play:ip:203.0.113.7',
    );
  });

  it('account Premium: passa id utente e rete; il server decide se contare', async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 'user-1' });
    mocks.premium.mockResolvedValue(true);
    const response = await play({ 'x-real-ip': '2001:db8:1234:5678::9' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.premium).toHaveBeenCalledWith('user-1');
    expect(mocks.record).toHaveBeenCalledWith(ID, {
      userId: 'user-1',
      network: 'ip6:2001:db8:1234:5678::/64',
    });
  });

  it('ospite (anche l’autore senza cookie): non può ascoltare, quindi non conta', async () => {
    const response = await play({ 'x-real-ip': '203.0.113.7' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.premium).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('account gratuito: non riceve lo streamUrl, quindi il suo “ascolto” non conta', async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 'free-user' });
    mocks.premium.mockResolvedValue(false);
    const response = await play({ 'x-real-ip': '203.0.113.7' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.premium).toHaveBeenCalledWith('free-user');
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('ignora gli header inventabili dal client (x-forwarded-for, cf-connecting-ip)', async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 'user-1' });
    mocks.premium.mockResolvedValue(true);
    await play({ 'x-forwarded-for': '198.51.100.1', 'cf-connecting-ip': '198.51.100.2' });
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith('listening.write', 'play:anon');
    expect(mocks.record).toHaveBeenCalledWith(ID, { userId: 'user-1', network: null });
  });

  it('la risposta è la stessa anche quando l’ascolto non viene contato', async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 'user-1' });
    mocks.premium.mockResolvedValue(true);
    mocks.record.mockResolvedValue(false);
    const response = await play({ 'x-real-ip': '203.0.113.7' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
