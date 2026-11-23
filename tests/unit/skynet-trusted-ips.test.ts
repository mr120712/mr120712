// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  sameOrigin: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/skynet/sentinel.server', () => ({ SKYNET_STATE_ID: 'main' }));
vi.mock('@/lib/db', () => ({
  prisma: { skynetState: { findUnique: mocks.findUnique, upsert: mocks.upsert } },
}));

import { POST } from '@/app/api/admin/skynet/trust-me/route';
import { MAX_TRUSTED, parseTrusted, trustIp } from '@/lib/skynet/trusted-ips';

const NOW = new Date('2026-11-23T10:00:00.000Z');
const DAY = 86_400_000;
const admin = { id: 'a1', role: 'admin', email: 'bestmr12@icloud.com', emailVerified: true };
const req = (ip: string | null) =>
  new Request('https://solco.test/api/admin/skynet/trust-me', {
    method: 'POST',
    headers: { origin: 'https://solco.test', ...(ip ? { 'x-real-ip': ip } : {}) },
  });

describe('indirizzi fidati: logica', () => {
  it('scarta scaduti e valori strani', () => {
    expect(
      parseTrusted(
        { '1.2.3.4': new Date(NOW.getTime() + DAY).toISOString(), '5.6.7.8': '2020-01-01', x: 3 },
        NOW,
      ),
    ).toEqual({ '1.2.3.4': new Date(NOW.getTime() + DAY).toISOString() });
    expect(parseTrusted(null, NOW)).toEqual({});
  });

  it('aggiunge per 7 giorni, rinnova al più una volta al giorno, tiene i più recenti', () => {
    const first = trustIp({}, '101.56.194.93', NOW);
    expect(first.changed).toBe(true);
    expect(first.map['101.56.194.93']).toBe(new Date(NOW.getTime() + 7 * DAY).toISOString());
    expect(trustIp(first.map, '101.56.194.93', new Date(NOW.getTime() + 3_600_000)).changed).toBe(
      false,
    );
    let map = {};
    for (let i = 0; i < MAX_TRUSTED + 3; i += 1) {
      map = trustIp(map, `203.0.113.${i}`, new Date(NOW.getTime() + i * 1000)).map;
    }
    expect(Object.keys(map)).toHaveLength(MAX_TRUSTED);
    expect(map).toHaveProperty(`203.0.113.${MAX_TRUSTED + 2}`);
    expect(map).not.toHaveProperty('203.0.113.0');
  });
});

describe('POST /api/admin/skynet/trust-me', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    mocks.sameOrigin.mockReturnValue(true);
    mocks.getSession.mockResolvedValue({ user: admin });
    mocks.findUnique.mockResolvedValue({ trustedIps: null });
  });

  it('solo admin verificati, stessa origine', async () => {
    mocks.sameOrigin.mockReturnValueOnce(false);
    expect((await POST(req('101.56.194.93'))).status).toBe(403);
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await POST(req('101.56.194.93'))).status).toBe(401);
    mocks.getSession.mockResolvedValueOnce({ user: { ...admin, role: 'user' } });
    expect((await POST(req('101.56.194.93'))).status).toBe(403);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('salva l’IP scritto da Vercel; ignora IP privati o mancanti', async () => {
    const res = await POST(req('101.56.194.93'));
    expect(await res.json()).toMatchObject({ trusted: true });
    expect(mocks.upsert.mock.calls[0]?.[0].update.trustedIps).toHaveProperty('101.56.194.93');
    mocks.upsert.mockClear();
    expect(await (await POST(req('192.168.1.2'))).json()).toEqual({ trusted: false });
    expect(await (await POST(req(null))).json()).toEqual({ trusted: false });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
