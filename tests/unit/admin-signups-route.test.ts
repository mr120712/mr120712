// @polsia:user-owned — GET /api/admin/signups: accesso solo per admin con email verificata
// (401/403/503), risposta privata non memorizzabile, forma del contratto con Prisma finto, 500 con
// messaggio generico sugli errori del database e nessun campo personale nel JSON.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/db', () => ({ prisma: { $queryRaw: mocks.queryRaw } }));

import { GET } from '@/app/api/admin/signups/route';
import { AdminSignupsSchema } from '@/lib/contracts/admin-signups';

// 14:30 UTC = 15:30 a Roma (ora solare a novembre).
const NOW = new Date('2026-11-14T14:30:00.000Z');
const admin = { id: 'admin-1', role: 'admin', emailVerified: true };

// Righe grezze come le restituirebbe Postgres, più colonne personali che non devono mai uscire.
const totalsRow = {
  total: 1250n,
  last24h: 4n,
  last7d: 31n,
  last30d: 118n,
  verified: 980n,
  banned: 3n,
  admins: 1n,
  email: 'mario.rossi@example.com',
  name: 'Mario Rossi',
};
const dailyRows = [
  { day: '2026-10-16', count: 5n, id: 'user-123' },
  { day: '2026-10-25', count: 2n, phoneNumber: '+393331234567' },
  { day: '2026-11-14', count: 4n },
];

function request() {
  return new Request('https://solco.test/api/admin/signups', {
    headers: { cookie: 'better-auth.session_token=fake' },
  });
}

function expectPrivate(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
}

let errors: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.getSession.mockResolvedValue({ user: admin });
  mocks.queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
    strings.join('').includes('GROUP BY') ? dailyRows : [totalsRow],
  );
});

afterEach(() => {
  errors.mockRestore();
  vi.useRealTimers();
});

describe('GET /api/admin/signups: accesso', () => {
  it('401 senza sessione, senza toccare il database', async () => {
    mocks.getSession.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it('403 per un utente che non è admin', async () => {
    mocks.getSession.mockResolvedValue({ user: { ...admin, role: 'user' } });
    const response = await GET(request());
    expect(response.status).toBe(403);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it('403 per un admin con email non verificata', async () => {
    mocks.getSession.mockResolvedValue({ user: { ...admin, emailVerified: false } });
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it('503 quando la sessione non è verificabile', async () => {
    mocks.getSession.mockRejectedValue(new Error('auth down'));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'session_unavailable' });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it('passa i cookie della richiesta a better-auth', async () => {
    await GET(request());
    const [{ headers }] = mocks.getSession.mock.calls[0] as [{ headers: Headers }];
    expect(headers.get('cookie')).toBe('better-auth.session_token=fake');
  });
});

describe('GET /api/admin/signups: risposta', () => {
  it('200 con i numeri aggregati nel formato del contratto', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expectPrivate(response);
    const body = AdminSignupsSchema.parse(await response.json());

    expect(body.generatedAt).toBe(NOW.toISOString());
    expect(body.timeZone).toBe('Europe/Rome');
    expect(body.totals).toEqual({
      total: 1250,
      last24h: 4,
      last7d: 31,
      last30d: 118,
      verified: 980,
      banned: 3,
      admins: 1,
    });
    expect(body.daily).toHaveLength(30);
    expect(body.daily[0]).toEqual({ day: '2026-10-16', count: 5 });
    expect(body.daily.at(-1)).toEqual({ day: '2026-11-14', count: 4 });
    expect(body.daily.filter((entry) => entry.count === 0)).toHaveLength(27);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
  });

  it('non contiene mai campi personali: solo le chiavi aggregate previste', async () => {
    const response = await GET(request());
    const raw = await response.text();
    const body = JSON.parse(raw) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(['daily', 'generatedAt', 'timeZone', 'totals']);
    expect(Object.keys(body.totals as object).sort()).toEqual([
      'admins',
      'banned',
      'last24h',
      'last30d',
      'last7d',
      'total',
      'verified',
    ]);
    for (const entry of body.daily as object[]) {
      expect(Object.keys(entry).sort()).toEqual(['count', 'day']);
    }
    expect(raw).not.toMatch(/mario|rossi|example\.com|@|user-123|\+39|3331234567/i);
  });
});

describe('GET /api/admin/signups: errori del database', () => {
  it('500 con un messaggio generico, senza dettagli del database nella risposta o nei log', async () => {
    mocks.queryRaw.mockRejectedValue(
      new Error('connect ECONNREFUSED db.internal:5432 user=solco password=segreta'),
    );
    const response = await GET(request());
    expect(response.status).toBe(500);
    expectPrivate(response);
    const body = await response.json();
    expect(body).toEqual({
      error: 'signups_unavailable',
      message: 'I dati sugli iscritti non sono disponibili in questo momento. Riprova tra poco.',
    });
    expect(JSON.stringify(body)).not.toMatch(/db\.internal|segreta|5432/);
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/db\.internal|segreta|5432/);
    expect(errors).toHaveBeenCalled();
  });

  it('500 quando il database restituisce un conteggio impossibile', async () => {
    mocks.queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join('').includes('GROUP BY') ? [] : [{ ...totalsRow, total: -1n }],
    );
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe('signups_unavailable');
  });

  it('500 quando manca la riga dei totali', async () => {
    mocks.queryRaw.mockResolvedValue([]);
    const response = await GET(request());
    expect(response.status).toBe(500);
  });
});
