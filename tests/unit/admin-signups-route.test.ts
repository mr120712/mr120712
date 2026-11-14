// @polsia:user-owned — GET /api/admin/signups: accesso solo per admin con email verificata
// (401/403/503), risposta privata non memorizzabile, forma del contratto con Prisma finto (Free e
// Pro compresi), 500 con messaggio generico sugli errori del database, `plans` null (totali e
// grafico intatti) se una tabella del Premium non risponde e nessun campo personale o id utente
// nel JSON.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  queryRaw: vi.fn(),
  stripe: vi.fn(),
  paypal: vi.fn(),
  inApp: vi.fn(),
  solcoPro: vi.fn(),
  rewards: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/db', () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    solcoSubscription: { findMany: mocks.stripe },
    payPalSubscription: { findMany: mocks.paypal },
    solcoIapSubscription: { findMany: mocks.inApp },
    solcoProStripeEntitlement: { findMany: mocks.solcoPro },
    premiumGrant: { findMany: mocks.rewards },
  },
}));

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
// Righe delle fonti del Premium: gli id servono solo a unire le fonti e non devono uscire.
const FUTURE = new Date('2026-12-14T00:00:00.000Z');
const PAST = new Date('2026-11-01T00:00:00.000Z');
const stripeRows = [
  { userId: 'pro-stripe-77', status: 'active', currentPeriodEnd: FUTURE },
  { userId: 'pro-both-88', status: 'trialing', currentPeriodEnd: FUTURE },
  { userId: 'lapsed-99', status: 'active', currentPeriodEnd: PAST },
  { userId: 'banned-pro-55', status: 'active', currentPeriodEnd: FUTURE },
];
const paypalRows = [{ userId: 'pro-paypal-66', status: 'ACTIVE' }];
const iapRows = [{ userId: 'pro-both-88', state: 'active', validUntil: FUTURE }];
const ineligibleRows = [{ userId: 'banned-pro-55' }];
const premiumDown = new Error('relation "SolcoIapSubscription" does not exist password=segreta');

/** Risponde come Postgres in base al testo della query. */
function rawRows(totals: unknown[], daily: unknown[], ineligible: unknown[] = ineligibleRows) {
  return async (strings: TemplateStringsArray) => {
    const sql = strings.join('');
    if (sql.includes('"source"')) return ineligible;
    return sql.includes('GROUP BY') ? daily : totals;
  };
}

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
  mocks.queryRaw.mockImplementation(rawRows([totalsRow], dailyRows));
  mocks.stripe.mockResolvedValue(stripeRows);
  mocks.paypal.mockResolvedValue(paypalRows);
  mocks.inApp.mockResolvedValue(iapRows);
  mocks.solcoPro.mockResolvedValue([]);
  mocks.rewards.mockResolvedValue([]);
});

function expectNoDatabase() {
  expect(mocks.queryRaw).not.toHaveBeenCalled();
  for (const source of [mocks.stripe, mocks.paypal, mocks.inApp, mocks.solcoPro, mocks.rewards]) {
    expect(source).not.toHaveBeenCalled();
  }
}

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
    expectNoDatabase();
  });

  it('403 per un utente che non è admin', async () => {
    mocks.getSession.mockResolvedValue({ user: { ...admin, role: 'user' } });
    const response = await GET(request());
    expect(response.status).toBe(403);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expectNoDatabase();
  });

  it('403 per un admin con email non verificata', async () => {
    mocks.getSession.mockResolvedValue({ user: { ...admin, emailVerified: false } });
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expectNoDatabase();
  });

  it('503 quando la sessione non è verificabile', async () => {
    mocks.getSession.mockRejectedValue(new Error('auth down'));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: 'session_unavailable' });
    expectNoDatabase();
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
    // 1247 utenti attivi; Pro distinti: pro-stripe-77, pro-both-88 (Stripe e App Store),
    // pro-paypal-66. Scaduto e bloccato non contano.
    expect(body.plans).toEqual({
      free: 1244,
      pro: 3,
      proShare: 0.2,
      proBySource: { stripe: 2, paypal: 1, inApp: 1, solcoPro: 0, rewards: 0 },
    });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(3);
    for (const source of [mocks.stripe, mocks.paypal, mocks.inApp, mocks.solcoPro, mocks.rewards]) {
      expect(source).toHaveBeenCalledTimes(1);
    }
  });

  it('non contiene mai campi personali: solo le chiavi aggregate previste', async () => {
    const response = await GET(request());
    const raw = await response.text();
    const body = JSON.parse(raw) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      'daily',
      'generatedAt',
      'plans',
      'timeZone',
      'totals',
    ]);
    expect(Object.keys(body.plans as object).sort()).toEqual([
      'free',
      'pro',
      'proBySource',
      'proShare',
    ]);
    expect(Object.keys((body.plans as { proBySource: object }).proBySource).sort()).toEqual([
      'inApp',
      'paypal',
      'rewards',
      'solcoPro',
      'stripe',
    ]);
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
    expect(raw).not.toMatch(/pro-stripe|pro-both|pro-paypal|lapsed|banned-pro|userId/);
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

  it.each([
    ['una fonte del Premium', () => mocks.inApp.mockRejectedValue(premiumDown)],
    [
      'la query degli esclusi',
      () =>
        mocks.queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
          if (strings.join('').includes('"source"')) throw premiumDown;
          return rawRows([totalsRow], dailyRows)(strings);
        }),
    ],
  ])('200 con plans null quando %s non risponde: totali e grafico restano', async (_, breakIt) => {
    breakIt();
    const response = await GET(request());
    expect(response.status).toBe(200);
    expectPrivate(response);
    const raw = await response.text();
    const body = AdminSignupsSchema.parse(JSON.parse(raw));
    expect(body.plans).toBeNull();
    expect(body.totals.total).toBe(1250);
    expect(body.totals.banned).toBe(3);
    expect(body.daily).toHaveLength(30);
    expect(body.daily.at(-1)).toEqual({ day: '2026-11-14', count: 4 });
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      'daily',
      'generatedAt',
      'plans',
      'timeZone',
      'totals',
    ]);
    expect(raw).not.toMatch(/SolcoIapSubscription|segreta|pro-stripe|userId/);
    // Nei log solo il nome dell'errore.
    expect(errors).toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/SolcoIapSubscription|segreta/);
  });

  it('500 quando la query degli esclusi restituisce un id non valido', async () => {
    mocks.queryRaw.mockImplementation(rawRows([totalsRow], dailyRows, [{ userId: null }]));
    const response = await GET(request());
    expect(response.status).toBe(500);
  });

  it('500 quando il database restituisce un conteggio impossibile', async () => {
    mocks.queryRaw.mockImplementation(rawRows([{ ...totalsRow, total: -1n }], []));
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
