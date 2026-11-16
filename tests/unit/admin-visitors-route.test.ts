// @polsia:user-owned — GET /api/admin/visitors: accesso solo per admin con email verificata
// (401/403/503), risposta privata non memorizzabile, forma del contratto con Prisma finto, 500 con
// messaggio generico sugli errori del database e nessuna impronta, IP o colonna in più nel JSON.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/db', () => ({ prisma: { $queryRaw: mocks.queryRaw } }));
vi.mock('@/lib/site', () => ({ siteUrl: 'https://www.solcomusic.online' }));

import { GET } from '@/app/api/admin/visitors/route';
import { AdminVisitorsSchema } from '@/lib/contracts/admin-visitors';

const admin = { id: 'admin-1', role: 'admin', emailVerified: true };

/** Risponde come Postgres in base al testo della query; le colonne in più non devono mai uscire. */
function rawRows() {
  mocks.queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('"referrerHost" AS "host"')) {
      return [{ host: 'www.google.com', visitors: 4n, visitorHash: 'abc' }];
    }
    if (text.includes('"device"')) return [{ device: 'mobile', visitors: 6n }];
    if (text.includes('"country"')) return [{ country: 'IT', visitors: 7n, ip: '203.0.113.7' }];
    if (text.includes('"path"')) return [{ path: '/', visitors: 7n, views: 12n }];
    return [{ day: new Date().toISOString().slice(0, 10), visitors: 7n, views: 12n }];
  });
}

function request() {
  return new Request('https://www.solcomusic.online/api/admin/visitors', {
    headers: { cookie: 'better-auth.session_token=abc' },
  });
}

let consoleError: MockInstance;

beforeEach(() => {
  mocks.getSession.mockReset();
  mocks.queryRaw.mockReset();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('GET /api/admin/visitors', () => {
  it('401 senza sessione, 403 senza ruolo admin o senza email verificata, 503 se la sessione non si legge', async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(401);
    mocks.getSession.mockResolvedValueOnce({ user: { ...admin, role: 'user' } });
    expect((await GET(request())).status).toBe(403);
    mocks.getSession.mockResolvedValueOnce({ user: { ...admin, emailVerified: false } });
    expect((await GET(request())).status).toBe(403);
    mocks.getSession.mockRejectedValueOnce(new Error('auth down'));
    const unavailable = await GET(request());
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it('200 con il contratto, solo numeri aggregati, risposta privata', async () => {
    mocks.getSession.mockResolvedValue({ user: admin });
    rawRows();
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
    const text = await response.text();
    const body = AdminVisitorsSchema.parse(JSON.parse(text));
    expect(body.today).toEqual({ visitors: 7, views: 12 });
    expect(body.pages).toEqual([{ path: '/', visitors: 7, views: 12 }]);
    expect(body.countries).toEqual([{ country: 'IT', visitors: 7 }]);
    expect(body.referrers).toEqual([{ host: 'www.google.com', visitors: 4 }]);
    expect(body.devices).toEqual([{ device: 'mobile', visitors: 6 }]);
    expect(body.daily).toHaveLength(30);
    expect(text).not.toContain('203.0.113.7');
    expect(text).not.toContain('visitorHash');
    expect(mocks.queryRaw).toHaveBeenCalledTimes(5);
  });

  it('500 con messaggio generico se il database non risponde; nei log solo il nome dell’errore', async () => {
    mocks.getSession.mockResolvedValue({ user: admin });
    mocks.queryRaw.mockRejectedValue(
      new Error('relation "SiteVisit" does not exist password=segreta'),
    );
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'visitors_unavailable',
      message: 'I dati sui visitatori non sono disponibili in questo momento. Riprova tra poco.',
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('segreta');
  });
});
