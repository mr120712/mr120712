// @polsia:user-owned — route /api/admin/legacy-users (GET, controllo) e /api/admin/legacy-users/import
// (POST, anteprima e trasferimento): stessa origine prima di tutto (403), solo admin con email
// verificata (401/403/503), corpo validato con zod (400), limite di frequenza su un bucket admin
// esistente (429), 409 per anteprime scadute o superate, 503 se il vecchio database non risponde,
// 500 generico senza dettagli, e intestazioni private non memorizzabili su ogni risposta.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  sameOrigin: vi.fn(),
  consumeRateLimit: vi.fn(),
  diagnose: vi.fn(),
  preview: vi.fn(),
  importBatch: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({ consumeRateLimit: mocks.consumeRateLimit }));
vi.mock('@/lib/admin/legacy-users.server', () => ({
  diagnoseLegacyUsers: mocks.diagnose,
  previewLegacyImport: mocks.preview,
  importLegacyBatch: mocks.importBatch,
}));

import { POST } from '@/app/api/admin/legacy-users/import/route';
import { GET } from '@/app/api/admin/legacy-users/route';
import { LegacyErrorBodySchema } from '@/lib/contracts/legacy-users';

const SOURCE = 'a'.repeat(32);
const TOKEN = 'eyJ2IjoxfQ.c2lnbmF0dXJlLXByb3Zh';
const admin = { id: 'admin-1', role: 'admin', emailVerified: true };

const STATS = {
  users: 6,
  verified: 6,
  banned: 1,
  withPhone: 1,
  legacyAdmins: 1,
  oldestAt: '2024-01-01T10:00:00.000Z',
  newestAt: '2024-06-01T10:00:00.000Z',
  alreadyImported: 0,
  alreadyPresent: 1,
  duplicateInSource: 0,
  invalidEmail: 1,
  importable: 4,
  passwordCompatible: 2,
  passwordIncompatible: 1,
  oauthOnly: 1,
  phoneOnly: 0,
  needsPasswordReset: 1,
  adminsToDemote: 1,
  phonesDropped: 0,
  oauthAccountsSkipped: 0,
  reservedAdmin: 0,
};

const DIAGNOSTIC = {
  generatedAt: '2026-11-15T10:00:00.000Z',
  batchSize: 200,
  currentDetected: true,
  groups: [
    {
      source: 'b'.repeat(32),
      current: true,
      status: 'current',
      providerHint: 'Neon · eu-central-1',
      envVars: ['DATABASE_URL'],
      incompleteVars: [],
      errorKind: null,
      currentUsers: 10,
      otherUsersTable: null,
      stats: null,
      otherTables: [],
      otherTablesApproximate: false,
    },
    {
      source: SOURCE,
      current: false,
      status: 'ready',
      providerHint: 'Neon · us-east-2',
      envVars: ['OLD_DATABASE_URL'],
      incompleteVars: [],
      errorKind: null,
      currentUsers: null,
      otherUsersTable: null,
      stats: STATS,
      otherTables: [{ name: 'Playlist', rows: 12 }],
      otherTablesApproximate: false,
    },
  ],
  skippedVars: [],
};

function getRequest() {
  return new Request('https://solco.test/api/admin/legacy-users', {
    headers: { cookie: 'better-auth.session_token=fake' },
  });
}

function postRequest(body: unknown, raw = false) {
  return new Request('https://solco.test/api/admin/legacy-users/import', {
    method: 'POST',
    headers: {
      origin: 'https://solco.test',
      cookie: 'better-auth.session_token=fake',
      'content-type': 'application/json',
    },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

function expectPrivate(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
}

let errors: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.resetAllMocks();
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.getSession.mockResolvedValue({ user: admin });
  mocks.sameOrigin.mockReturnValue(true);
  mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
  mocks.diagnose.mockResolvedValue({ ok: true, value: DIAGNOSTIC });
  mocks.preview.mockResolvedValue({
    ok: true,
    value: {
      action: 'preview',
      source: SOURCE,
      stats: STATS,
      previewToken: TOKEN,
      expiresAt: '2026-11-15T10:15:00.000Z',
      batchSize: 200,
    },
  });
  mocks.importBatch.mockResolvedValue({
    ok: true,
    value: {
      action: 'import',
      source: SOURCE,
      batch: {
        imported: 4,
        conflicts: 0,
        skippedExisting: 1,
        skippedInvalidEmail: 1,
        totalImported: 4,
        remaining: 0,
        done: true,
      },
    },
  });
});

afterEach(() => {
  errors.mockRestore();
});

describe('GET /api/admin/legacy-users', () => {
  it('401 senza sessione, senza controllare nulla', async () => {
    mocks.getSession.mockResolvedValue(null);
    const response = await GET(getRequest());
    expect(response.status).toBe(401);
    expectPrivate(response);
    expect(mocks.diagnose).not.toHaveBeenCalled();
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
  });

  it.each([[{ ...admin, role: 'user' }], [{ ...admin, emailVerified: false }]])(
    '403 per chi non è admin con email verificata',
    async (user) => {
      mocks.getSession.mockResolvedValue({ user });
      const response = await GET(getRequest());
      expect(response.status).toBe(403);
      expectPrivate(response);
      expect(mocks.diagnose).not.toHaveBeenCalled();
    },
  );

  it('503 se la sessione non si può verificare', async () => {
    mocks.getSession.mockRejectedValue(new Error('db giù'));
    const response = await GET(getRequest());
    expect(response.status).toBe(503);
    expectPrivate(response);
  });

  it('200: diagnosi del contratto, privata; limite sul bucket dei controlli manuali', async () => {
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(await response.json()).toEqual(DIAGNOSTIC);
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith(
      'monitor.run.admin',
      'legacy-users:user:admin-1',
    );
  });

  it('429 oltre il limite, con Retry-After, senza connessioni', async () => {
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: false,
      status: 429,
      retryAfterSeconds: 42,
      error: 'rate_limited',
      message: 'x',
    });
    const response = await GET(getRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    expectPrivate(response);
    expect(mocks.diagnose).not.toHaveBeenCalled();
  });

  it('503 senza BETTER_AUTH_SECRET', async () => {
    mocks.diagnose.mockResolvedValue({ ok: false, failure: { code: 'secret_missing' } });
    const response = await GET(getRequest());
    expect(response.status).toBe(503);
    expect(LegacyErrorBodySchema.parse(await response.json()).error).toBe('secret_missing');
  });

  it('500 generico: nessun dettaglio dell’errore nella risposta o nei log', async () => {
    mocks.diagnose.mockRejectedValue(
      new Error('connect ECONNREFUSED postgresql://u:pw@ep-x.neon.tech/db'),
    );
    const response = await GET(getRequest());
    expect(response.status).toBe(500);
    expectPrivate(response);
    const text = await response.text();
    expect(text).not.toContain('neon');
    expect(text).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('neon.tech');
  });

  it('una risposta fuori contratto (chiave in più) non esce', async () => {
    mocks.diagnose.mockResolvedValue({
      ok: true,
      value: { ...DIAGNOSTIC, databaseUrl: 'postgresql://u:pw@h/db' },
    });
    const response = await GET(getRequest());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('postgresql');
  });
});

describe('POST /api/admin/legacy-users/import', () => {
  it('origine diversa → 403 prima della sessione', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const response = await POST(postRequest({ action: 'preview', source: SOURCE }));
    expect(response.status).toBe(403);
    expectPrivate(response);
    expect(await response.json()).toMatchObject({ error: 'forbidden_origin' });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('401 senza sessione, 403 senza ruolo admin', async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await POST(postRequest({ action: 'preview', source: SOURCE }))).status).toBe(401);
    mocks.getSession.mockResolvedValueOnce({ user: { ...admin, role: 'user' } });
    const forbidden = await POST(postRequest({ action: 'preview', source: SOURCE }));
    expect(forbidden.status).toBe(403);
    expectPrivate(forbidden);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it.each([
    ['JSON non valido', '{non json', true],
    ['azione sconosciuta', { action: 'delete', source: SOURCE }, false],
    ['fonte non valida', { action: 'preview', source: 'OLD_DATABASE_URL' }, false],
    ['import senza gettone', { action: 'import', source: SOURCE }, false],
    ['gettone malformato', { action: 'import', source: SOURCE, previewToken: 'a b' }, false],
    ['chiave in più', { action: 'preview', source: SOURCE, url: 'postgresql://x' }, false],
  ])('400 per %s', async (_label, body, raw) => {
    const response = await POST(postRequest(body, raw));
    expect(response.status).toBe(400);
    expectPrivate(response);
    expect(await response.json()).toMatchObject({ error: 'invalid_body' });
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.importBatch).not.toHaveBeenCalled();
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('anteprima: 200 privata, limite su un bucket admin esistente con identità propria', async () => {
    const response = await POST(postRequest({ action: 'preview', source: SOURCE }));
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(await response.json()).toMatchObject({ action: 'preview', previewToken: TOKEN });
    expect(mocks.preview).toHaveBeenCalledWith(SOURCE);
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith(
      'admin.assistant',
      'legacy-users-import:user:admin-1',
    );
  });

  it('trasferimento: 200 col riepilogo del lotto', async () => {
    const response = await POST(
      postRequest({ action: 'import', source: SOURCE, previewToken: TOKEN }),
    );
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect((await response.json()).batch).toMatchObject({ imported: 4, remaining: 0, done: true });
    expect(mocks.importBatch).toHaveBeenCalledWith(SOURCE, TOKEN);
  });

  it.each([
    ['preview_expired', 409],
    ['preview_mismatch', 409],
    ['preview_invalid', 409],
    ['source_in_use', 400],
    ['unknown_source', 400],
    ['source_incomplete', 400],
    ['source_incompatible', 400],
    ['secret_missing', 503],
  ])('%s → %i', async (code, status) => {
    mocks.importBatch.mockResolvedValue({ ok: false, failure: { code } });
    const response = await POST(
      postRequest({ action: 'import', source: SOURCE, previewToken: TOKEN }),
    );
    expect(response.status).toBe(status);
    expectPrivate(response);
    const body = LegacyErrorBodySchema.parse(await response.json());
    expect(body.error).toBe(code);
    expect(body.message.length).toBeGreaterThan(10);
  });

  it('vecchio database irraggiungibile → 503 con la sola categoria', async () => {
    mocks.preview.mockResolvedValue({
      ok: false,
      failure: { code: 'source_unavailable', kind: 'timeout' },
    });
    const response = await POST(postRequest({ action: 'preview', source: SOURCE }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'source_unavailable', kind: 'timeout' });
  });

  it('429 oltre il limite, senza anteprima', async () => {
    mocks.consumeRateLimit.mockResolvedValue({
      allowed: false,
      status: 429,
      retryAfterSeconds: 30,
      error: 'rate_limited',
      message: 'x',
    });
    const response = await POST(postRequest({ action: 'preview', source: SOURCE }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('500 generico se il trasferimento si interrompe, senza dettagli', async () => {
    mocks.importBatch.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed on anna@example.com'), {
        name: 'PrismaClientKnownRequestError',
      }),
    );
    const response = await POST(
      postRequest({ action: 'import', source: SOURCE, previewToken: TOKEN }),
    );
    expect(response.status).toBe(500);
    expectPrivate(response);
    expect(await response.text()).not.toContain('anna');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('anna');
  });
});
