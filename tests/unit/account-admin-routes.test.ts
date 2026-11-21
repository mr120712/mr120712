// @polsia:user-owned — rotte della «Gestione account» e dell'UID: solo amministratori con email
// verificata (401/403/503), le modifiche partono dal sito stesso prima di ogni altro controllo
// (403), validazione con errori di campo (400), 404 per una concessione inesistente, risposte mai in
// cache e nei log solo il nome dell'errore. L'elenco degli account (listAdminAccounts) dice UID,
// accesso, verifica, ruolo, blocco e fonti del Premium con le regole delle statistiche, e cerca anche
// per UID scritto come capita. GET /api/account/uid restituisce l'UID del proprio account.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  sameOrigin: vi.fn(() => true),
  enforceRateLimit: vi.fn(async () => null as Response | null),
  listAdminAccounts: vi.fn(),
  listPremiumGrants: vi.fn(),
  grantPremiumToEmail: vi.fn(),
  revokePremiumGrant: vi.fn(),
  requireAuth: vi.fn(),
  ensureAccountUid: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({ enforceRateLimit: mocks.enforceRateLimit }));
vi.mock('@/lib/admin/account-admin.server', () => ({ listAdminAccounts: mocks.listAdminAccounts }));
vi.mock('@/lib/business/premium-grants.server', () => ({
  listPremiumGrants: mocks.listPremiumGrants,
  grantPremiumToEmail: mocks.grantPremiumToEmail,
  revokePremiumGrant: mocks.revokePremiumGrant,
}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/account/uid.server', () => ({ ensureAccountUid: mocks.ensureAccountUid }));

import { GET as uidRoute } from '@/app/api/account/uid/route';
import { GET as accountsRoute } from '@/app/api/admin/accounts/route';
import {
  POST as grantRoute,
  GET as grantsRoute,
  DELETE as revokeRoute,
} from '@/app/api/admin/premium-grants/route';

const BASE = 'https://solco.example';
const admin = {
  user: { id: 'admin-1', role: 'admin', email: 'bestmr12@icloud.com', emailVerified: true },
};
const grant = {
  id: 'grant-1',
  email: 'amico@example.com',
  note: null,
  createdAt: '2026-11-15T10:00:00.000Z',
  revokedAt: null,
  status: 'pending' as const,
  account: null,
  seeded: false,
};
const account = {
  id: 'user-1',
  uid: 'SOL-7K2M-9QXD',
  name: 'Mario',
  email: 'mario@example.com',
  emailVerified: true,
  role: 'user' as const,
  providers: ['google' as const],
  banned: false,
  premium: ['unlimited' as const],
  createdAt: '2026-11-01T10:00:00.000Z',
};

function post(body: unknown) {
  return new Request(`${BASE}/api/admin/premium-grants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.getSession.mockResolvedValue(admin);
  mocks.sameOrigin.mockReturnValue(true);
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.listAdminAccounts.mockResolvedValue({
    items: [account],
    total: 1,
    page: 0,
    hasMore: false,
  });
  mocks.listPremiumGrants.mockResolvedValue([grant]);
  mocks.grantPremiumToEmail.mockResolvedValue(grant);
  mocks.revokePremiumGrant.mockResolvedValue({
    ...grant,
    status: 'revoked',
    revokedAt: '2026-11-15T11:00:00.000Z',
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('accesso: solo amministratori con email verificata', () => {
  it.each([
    ['nessuna sessione', null, 401],
    ['utente normale', { user: { id: 'u', role: 'user', emailVerified: true } }, 403],
    [
      'admin con email non verificata',
      { user: { id: 'a', role: 'admin', emailVerified: false } },
      403,
    ],
  ])('%s → %i su ogni rotta admin', async (_, session, status) => {
    mocks.getSession.mockResolvedValue(session);
    const responses = await Promise.all([
      accountsRoute(new Request(`${BASE}/api/admin/accounts`)),
      grantsRoute(new Request(`${BASE}/api/admin/premium-grants`)),
      grantRoute(post({ email: 'amico@example.com' })),
      revokeRoute(new Request(`${BASE}/api/admin/premium-grants?id=grant-1`, { method: 'DELETE' })),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
    expect(mocks.listAdminAccounts).not.toHaveBeenCalled();
    expect(mocks.grantPremiumToEmail).not.toHaveBeenCalled();
    expect(mocks.revokePremiumGrant).not.toHaveBeenCalled();
  });

  it('ruolo admin in un elenco di ruoli: ammesso', async () => {
    mocks.getSession.mockResolvedValue({
      user: { id: 'a', role: 'user, admin', email: 'bestmr12@icloud.com', emailVerified: true },
    });
    expect((await accountsRoute(new Request(`${BASE}/api/admin/accounts`))).status).toBe(200);
  });

  it('sessione non verificabile → 503', async () => {
    mocks.getSession.mockRejectedValue(new Error('down'));
    expect((await accountsRoute(new Request(`${BASE}/api/admin/accounts`))).status).toBe(503);
  });
});

describe('GET /api/admin/accounts', () => {
  it('elenco nel formato del contratto, con ricerca e pagina', async () => {
    const response = await accountsRoute(
      new Request(`${BASE}/api/admin/accounts?q=SOL-7K2M-9QXD&page=2`),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [account], total: 1, page: 0, hasMore: false });
    expect(mocks.listAdminAccounts).toHaveBeenCalledWith({ q: 'SOL-7K2M-9QXD', page: 2 });
    expect(mocks.enforceRateLimit).toHaveBeenCalledWith(
      'admin.assistant',
      'account-admin:user:admin-1',
    );
  });

  it('ricerca troppo lunga → 400 prima di leggere', async () => {
    const response = await accountsRoute(
      new Request(`${BASE}/api/admin/accounts?q=${'x'.repeat(121)}`),
    );
    expect(response.status).toBe(400);
    expect(mocks.listAdminAccounts).not.toHaveBeenCalled();
  });

  it('limite raggiunto: la risposta del limite, mai in cache', async () => {
    mocks.enforceRateLimit.mockResolvedValue(new Response('{}', { status: 429 }));
    const response = await accountsRoute(new Request(`${BASE}/api/admin/accounts`));
    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('errore: 500 generico, nei log solo il nome', async () => {
    mocks.listAdminAccounts.mockRejectedValue(new TypeError('select email from user password=x'));
    const response = await accountsRoute(new Request(`${BASE}/api/admin/accounts`));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('password');
    expect(console.error).toHaveBeenCalledWith('[admin/account] elenco non riuscito:', 'TypeError');
  });

  it('una forma inattesa non esce', async () => {
    mocks.listAdminAccounts.mockResolvedValue({
      items: [{ ...account, passwordHash: 'x' }],
      total: 1,
      page: 0,
      hasMore: false,
    });
    expect((await accountsRoute(new Request(`${BASE}/api/admin/accounts`))).status).toBe(500);
  });
});

describe('/api/admin/premium-grants', () => {
  it('GET: le concessioni', async () => {
    const response = await grantsRoute(new Request(`${BASE}/api/admin/premium-grants`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [grant] });
  });

  it('POST da un altro sito → 403 prima della sessione', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const response = await grantRoute(post({ email: 'amico@example.com' }));
    expect(response.status).toBe(403);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it('POST: email in minuscole e nota passate così, 201', async () => {
    const response = await grantRoute(post({ email: '  Amico@Example.com ', note: ' Amico ' }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ grant });
    expect(mocks.grantPremiumToEmail).toHaveBeenCalledWith({
      email: 'amico@example.com',
      note: 'Amico',
      adminId: 'admin-1',
    });
  });

  it.each([
    [{ email: 'non-una-email' }, 'email'],
    [{ email: 'a@b.it', note: 'x'.repeat(201) }, 'note'],
    [{ email: 'a@b.it', extra: true }, 'extra'],
  ])('POST non valido → 400 con l’errore del campo (%j)', async (body, field) => {
    const response = await grantRoute(post(body));
    expect(response.status).toBe(400);
    const json = (await response.json()) as { errors: Record<string, string> };
    expect(Object.keys(json.errors)).toContain(field === 'extra' ? 'email' : field);
    expect(mocks.grantPremiumToEmail).not.toHaveBeenCalled();
  });

  it('POST con un corpo che non è JSON → 400', async () => {
    expect((await grantRoute(post('{ non json'))).status).toBe(400);
  });

  it('DELETE: revoca; id malformato 400; inesistente 404; altro sito 403', async () => {
    const ok = await revokeRoute(
      new Request(`${BASE}/api/admin/premium-grants?id=grant-1`, { method: 'DELETE' }),
    );
    expect(ok.status).toBe(200);
    expect(mocks.revokePremiumGrant).toHaveBeenCalledWith('grant-1');

    const bad = await revokeRoute(
      new Request(`${BASE}/api/admin/premium-grants?id=a%20b`, { method: 'DELETE' }),
    );
    expect(bad.status).toBe(400);

    mocks.revokePremiumGrant.mockResolvedValue(null);
    const missing = await revokeRoute(
      new Request(`${BASE}/api/admin/premium-grants?id=nope`, { method: 'DELETE' }),
    );
    expect(missing.status).toBe(404);

    mocks.sameOrigin.mockReturnValue(false);
    const foreign = await revokeRoute(
      new Request(`${BASE}/api/admin/premium-grants?id=grant-1`, { method: 'DELETE' }),
    );
    expect(foreign.status).toBe(403);
  });
});

describe('GET /api/account/uid', () => {
  it('l’UID del proprio account, mai in cache', async () => {
    mocks.requireAuth.mockResolvedValue({ id: 'user-1' });
    mocks.ensureAccountUid.mockResolvedValue('SOL-7K2M-9QXD');
    const response = await uidRoute(new Request(`${BASE}/api/account/uid`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ uid: 'SOL-7K2M-9QXD' });
    expect(mocks.ensureAccountUid).toHaveBeenCalledWith('user-1');
  });

  it('senza sessione 401; UID non assegnabile o errore 503', async () => {
    mocks.requireAuth.mockRejectedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    expect((await uidRoute(new Request(`${BASE}/api/account/uid`))).status).toBe(401);
    mocks.requireAuth.mockResolvedValue({ id: 'user-1' });
    mocks.ensureAccountUid.mockResolvedValue(null);
    expect((await uidRoute(new Request(`${BASE}/api/account/uid`))).status).toBe(503);
    mocks.ensureAccountUid.mockRejectedValue(new Error('db'));
    expect((await uidRoute(new Request(`${BASE}/api/account/uid`))).status).toBe(503);
  });
});
