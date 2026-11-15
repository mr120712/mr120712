// @polsia:user-owned — modulo server di «Utenti del vecchio sito» con PrismaClient e database
// attuale finti (nessun database vero): controllo dei gruppi («in uso» mai aperto, incompleti mai
// aperti, sola lettura con statement_timeout, $disconnect sempre), nessun URL/host/email/hash nel
// JSON, categorie di errore e scadenza, tabelle diverse, anteprima, trasferimento a lotti
// idempotente, email senza maiuscole, ruolo mai admin, telefono, password, OAuth senza token,
// gettone scaduto o superato da utenti nuovi, iscrizione concorrente durante un lotto.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

type JsonRow = Record<string, unknown>;
type Scenario = {
  tables: string[];
  users: JsonRow[];
  accounts: JsonRow[];
  otherTables: Array<{ name: string; rows: bigint }>;
  failCounts?: boolean;
  fail?: unknown;
  hang?: boolean;
  tooMany?: boolean;
};

const legacy = vi.hoisted(() => {
  type Client = { url: string; executed: string[][]; disconnected: boolean };
  return {
    clients: [] as Client[],
    scenarios: new Map<string, unknown>(),
    holder: { db: null as unknown },
  };
});

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  prisma: new Proxy(
    {},
    { get: (_target, key) => (legacy.holder.db as Record<string | symbol, unknown>)[key] },
  ),
}));
vi.mock('@prisma/client', () => {
  const TOKEN_KEYS = ['accessToken', 'refreshToken', 'idToken'];
  class PrismaClient {
    url: string;
    executed: string[][] = [];
    disconnected = false;
    constructor(options: { datasourceUrl: string }) {
      this.url = options.datasourceUrl;
      legacy.clients.push(this);
    }
    scenario(): Scenario {
      for (const [host, scenario] of legacy.scenarios) {
        if (this.url.includes(host)) return scenario as Scenario;
      }
      throw new Error('scenario mancante');
    }
    async $transaction<T>(run: (tx: unknown) => Promise<T>) {
      const scenario = this.scenario();
      if (scenario.fail) throw scenario.fail;
      if (scenario.hang) return new Promise<T>(() => {});
      const statements: string[] = [];
      this.executed.push(statements);
      const tx = {
        $executeRaw: async (strings: TemplateStringsArray) => {
          statements.push(strings.join('?').trim());
          return 0;
        },
        $queryRaw: async (strings: TemplateStringsArray) => {
          const sql = strings.join('?');
          statements.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
          if (sql.includes('query_to_xml')) {
            if (scenario.failCounts) {
              throw Object.assign(new Error('canceling statement due to statement timeout'), {
                code: 'P2010',
                meta: { code: '57014' },
              });
            }
            return scenario.otherTables;
          }
          if (sql.includes('pg_class')) {
            return scenario.otherTables.map((t) => ({ name: t.name, rows: t.rows + 1n }));
          }
          if (sql.includes('information_schema.tables')) {
            return scenario.tables.map((name) => ({ name }));
          }
          if (sql.includes('information_schema.columns')) {
            const user = Object.keys(
              scenario.users[0] ?? { id: 1, email: 1, emailVerified: 1, createdAt: 1 },
            );
            const account = ['userId', 'providerId', 'accountId', 'password'];
            return [
              ...user.map((column) => ({ table: 'user', column })),
              ...account.map((column) => ({ table: 'account', column })),
            ];
          }
          if (sql.includes('FROM "user"')) {
            if (scenario.tooMany) {
              return Array.from({ length: 20_001 }, (_, i) => ({ data: { id: `x${i}` } }));
            }
            return scenario.users.map((data) => ({ data }));
          }
          if (sql.includes('FROM "account"')) {
            // Come Postgres: la query toglie i token dal JSON prima che escano dal database.
            const strips = TOKEN_KEYS.every((key) => sql.includes(`- '${key}'`));
            return scenario.accounts.map((row) => ({
              data: strips
                ? Object.fromEntries(Object.entries(row).filter(([k]) => !TOKEN_KEYS.includes(k)))
                : row,
            }));
          }
          throw new Error(`query inattesa: ${sql}`);
        },
      };
      return run(tx);
    }
    async $disconnect() {
      this.disconnected = true;
    }
  }
  return { PrismaClient };
});

import {
  diagnoseLegacyUsers,
  importLegacyBatch,
  previewLegacyImport,
} from '@/lib/admin/legacy-users.server';
import {
  LegacyImportPostResponseSchema,
  LegacyUsersDiagnosticSchema,
} from '@/lib/contracts/legacy-users';
import { createLegacyCurrentDb, type FakeUser } from './support/legacy-users-db-fake';

const SECRET = 'segreto-di-prova-better-auth-0123456789';
const NOW = new Date('2026-11-15T10:00:00.000Z');
const A_POOLED = 'ep-cool-moon-111111-pooler.eu-central-1.aws.neon.tech';
const B_DIRECT = 'ep-old-river-222222.us-east-2.aws.neon.tech';
const C_HOST = 'db-legacy.c9xyz.eu-west-1.rds.amazonaws.com';
const GOOD_HASH = `${'a1'.repeat(16)}:${'b2'.repeat(64)}`;
const BCRYPT = '$2b$10$abcdefghijklmnopqrstuvabcdefghijklmnopqrstuvwxyz01234';

const ENV = {
  DATABASE_URL: `postgresql://owner:pwA@${A_POOLED}/neondb?sslmode=require`,
  OLD_DATABASE_URL: `postgresql://legacy_owner:pwB-segreta@${B_DIRECT}/solco?sslmode=require`,
  MY_STR_PGHOST: C_HOST,
  MY_STR_PGUSER: 'solco',
  MY_STR_PGDATABASE: 'solco',
  BETTER_AUTH_SECRET: SECRET,
};

function legacyUser(id: string, email: string, patch: JsonRow = {}): JsonRow {
  return {
    id,
    name: `Nome ${id}`,
    email,
    emailVerified: true,
    image: null,
    role: 'user',
    banned: false,
    banReason: null,
    banExpires: null,
    phoneNumber: null,
    phoneNumberVerified: null,
    createdAt: `2024-0${id.slice(-1)}-01T10:00:00.000`,
    updatedAt: '2025-01-01T10:00:00.000',
    ...patch,
  };
}

function legacyAccount(userId: string, providerId: string, patch: JsonRow = {}): JsonRow {
  return {
    id: `acc-${userId}-${providerId}`,
    userId,
    providerId,
    accountId: providerId === 'credential' ? userId : `sub-${userId}`,
    password: null,
    accessToken: null,
    refreshToken: null,
    idToken: null,
    createdAt: '2024-01-01T10:00:00.000',
    updatedAt: '2024-01-01T10:00:00.000',
    ...patch,
  };
}

function oldSite(): Scenario {
  return {
    tables: ['Playlist', 'PlaylistTrack', 'account', 'session', 'user', 'verification'],
    users: [
      legacyUser('u-old-1', 'Anna@Example.com'),
      legacyUser('u-old-2', 'bruno@example.com', {
        role: 'admin',
        image: 'http://insicura.example.com/b.png',
      }),
      legacyUser('u-old-3', 'carla@example.com', {
        phoneNumber: '+393331112222',
        phoneNumberVerified: true,
        image: 'https://cdn.example.com/c.png',
      }),
      legacyUser('u-old-4', 'mario.rossi@example.com'),
      legacyUser('u-old-5', 'davide@example.com', { banned: true, banReason: 'spam' }),
      legacyUser('u-old-6', 'non-una-email'),
    ],
    accounts: [
      legacyAccount('u-old-1', 'credential', { password: GOOD_HASH }),
      legacyAccount('u-old-2', 'credential', { password: BCRYPT }),
      legacyAccount('u-old-3', 'google', {
        accessToken: 'ya29.token-segreto',
        refreshToken: '1//refresh-segreto',
        idToken: 'eyJ.id-segreto',
        scope: 'openid email',
      }),
      legacyAccount('u-old-4', 'credential', { password: GOOD_HASH }),
      legacyAccount('u-old-5', 'credential', { password: GOOD_HASH }),
    ],
    otherTables: [
      { name: 'Playlist', rows: 12n },
      { name: 'PlaylistTrack', rows: 340n },
    ],
  };
}

function currentUser(id: string, email: string): FakeUser {
  return {
    id,
    name: 'Attuale',
    email,
    emailVerified: true,
    role: 'admin',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

let current: ReturnType<typeof createLegacyCurrentDb>;
let scenario: Scenario;
let errors: MockInstance<typeof console.error>;

beforeEach(() => {
  legacy.clients.length = 0;
  legacy.scenarios.clear();
  scenario = oldSite();
  legacy.scenarios.set(B_DIRECT, scenario);
  current = createLegacyCurrentDb({
    users: [
      // Stessa email del vecchio u-old-4, con maiuscole diverse.
      currentUser('cur-1', 'Mario.Rossi@example.com'),
      // Stesso id del vecchio u-old-5, email diversa.
      currentUser('u-old-5', 'zeta@example.com'),
    ],
  });
  legacy.holder.db = current.db;
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errors.mockRestore();
  vi.useRealTimers();
});

const FORBIDDEN_IN_OUTPUT = [
  'postgres',
  A_POOLED,
  B_DIRECT,
  C_HOST,
  'ep-old-river',
  'cool-moon',
  'pwB',
  'legacy_owner',
  'anna@',
  'Anna@',
  'bruno@',
  'carla@',
  'mario',
  'Mario',
  'davide@',
  GOOD_HASH.slice(0, 20),
  '$2b$',
  'ya29',
  'segreto',
  'u-old-',
  '+39333',
];

function expectNoSecrets(value: unknown) {
  const json = JSON.stringify(value);
  for (const fragment of FORBIDDEN_IN_OUTPUT) expect(json).not.toContain(fragment);
}

async function diagnose() {
  const result = await diagnoseLegacyUsers({ env: ENV, now: NOW });
  if (!result.ok) throw new Error(`atteso ok, ottenuto ${result.failure.code}`);
  return result.value;
}

async function oldSourceKey() {
  const data = await diagnose();
  const group = data.groups.find((g) => g.envVars.includes('OLD_DATABASE_URL'));
  if (!group) throw new Error('gruppo del vecchio sito mancante');
  legacy.clients.length = 0;
  return group.source;
}

async function preview(source: string, now = NOW) {
  const result = await previewLegacyImport(source, { env: ENV, now });
  if (!result.ok) throw new Error(`anteprima: ${result.failure.code}`);
  return result.value;
}

describe('controllo dei database', () => {
  it('gruppi: «in uso» e incompleto mai aperti; vecchio sito letto in sola lettura e chiuso', async () => {
    const data = await diagnose();
    expect(LegacyUsersDiagnosticSchema.parse(data)).toEqual(data);
    expect(data.currentDetected).toBe(true);
    expect(data.groups.map((g) => [g.status, g.current])).toEqual([
      ['current', true],
      ['ready', false],
      ['incomplete', false],
    ]);
    expect(data.groups[0]?.currentUsers).toBe(2);
    expect(data.groups[2]).toMatchObject({ incompleteVars: ['MY_STR_PG*'], stats: null });

    // Un solo client: quello del vecchio sito (né il database in uso né quello senza password).
    expect(legacy.clients).toHaveLength(1);
    const [client] = legacy.clients;
    expect(client?.url).toContain(B_DIRECT);
    expect(client?.url).toContain('connection_limit=1');
    expect(client?.url).toContain('sslmode=require');
    expect(client?.url).toContain('connect_timeout=5');
    expect(client?.disconnected).toBe(true);
    // Ogni transazione parte in sola lettura col timeout delle query.
    expect(client?.executed.length).toBeGreaterThanOrEqual(2);
    for (const statements of client?.executed ?? []) {
      expect(statements.slice(0, 2)).toEqual([
        'SET TRANSACTION READ ONLY',
        'SET LOCAL statement_timeout = 8000',
      ]);
    }
  });

  it('numeri del piano e altre tabelle; nessun URL, host, email, hash, token o id nel JSON', async () => {
    const data = await diagnose();
    const old = data.groups[1];
    expect(old).toMatchObject({
      providerHint: 'Neon · us-east-2',
      envVars: ['OLD_DATABASE_URL'],
      otherTables: [
        { name: 'Playlist', rows: 12 },
        { name: 'PlaylistTrack', rows: 340 },
      ],
      otherTablesApproximate: false,
    });
    expect(old?.stats).toMatchObject({
      users: 6,
      verified: 6,
      banned: 1,
      withPhone: 1,
      legacyAdmins: 1,
      alreadyPresent: 1,
      invalidEmail: 1,
      importable: 4,
      passwordCompatible: 2,
      passwordIncompatible: 1,
      oauthOnly: 1,
      needsPasswordReset: 1,
      adminsToDemote: 1,
      oldestAt: '2024-01-01T10:00:00.000Z',
      newestAt: '2024-06-01T10:00:00.000Z',
    });
    expectNoSecrets(data);
  });

  it('errore di accesso: solo la categoria, nei log solo il nome; client chiuso comunque', async () => {
    scenario.fail = Object.assign(
      new Error(`password authentication failed for user "legacy_owner" at ${B_DIRECT}`),
      { name: 'PrismaClientInitializationError', errorCode: 'P1000' },
    );
    const data = await diagnose();
    expect(data.groups[1]).toMatchObject({ status: 'error', errorKind: 'auth', stats: null });
    expectNoSecrets(data);
    expect(legacy.clients[0]?.disconnected).toBe(true);
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toContain('PrismaClientInitializationError');
    expect(logged).not.toContain(B_DIRECT);
    expect(logged).not.toContain('password authentication');
  });

  it('database che non risponde: scadenza complessiva → timeout, client chiuso', async () => {
    vi.useFakeTimers();
    scenario.hang = true;
    const pending = diagnoseLegacyUsers({ env: ENV, now: NOW });
    await vi.advanceTimersByTimeAsync(25_000);
    const result = await pending;
    expect(result.ok && result.value.groups[1]).toMatchObject({
      status: 'error',
      errorKind: 'timeout',
    });
    expect(legacy.clients[0]?.disconnected).toBe(true);
  });

  it('troppi utenti per una richiesta → too_large', async () => {
    scenario.tooMany = true;
    const data = await diagnose();
    expect(data.groups[1]).toMatchObject({ status: 'error', errorKind: 'too_large' });
  });

  it('senza tabelle di better-auth: non compatibile, con la tabella utenti diversa segnalata', async () => {
    scenario.tables = ['users', 'playlists'];
    const data = await diagnose();
    expect(data.groups[1]).toMatchObject({
      status: 'incompatible',
      otherUsersTable: 'users',
      stats: null,
    });
  });

  it('conteggio esatto delle altre tabelle non riuscito → stima di Postgres', async () => {
    scenario.failCounts = true;
    const data = await diagnose();
    expect(data.groups[1]).toMatchObject({
      status: 'ready',
      otherTablesApproximate: true,
      otherTables: [
        { name: 'Playlist', rows: 13 },
        { name: 'PlaylistTrack', rows: 341 },
      ],
    });
  });

  it('senza BETTER_AUTH_SECRET non si fa nulla', async () => {
    const result = await diagnoseLegacyUsers({ env: { ...ENV, BETTER_AUTH_SECRET: '' } });
    expect(result).toEqual({ ok: false, failure: { code: 'secret_missing' } });
    expect(legacy.clients).toHaveLength(0);
  });
});

describe('anteprima e trasferimento', () => {
  it('anteprima: numeri esatti e gettone; nessuna scrittura', async () => {
    const source = await oldSourceKey();
    const value = await preview(source);
    expect(LegacyImportPostResponseSchema.parse(value)).toEqual(value);
    expect(value.stats.importable).toBe(4);
    expect(value.previewToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(value.expiresAt).toBe('2026-11-15T10:15:00.000Z');
    expectNoSecrets({ ...value, previewToken: null });
    expect(current.tables.users).toHaveLength(2);
    expect(current.tables.imports).toHaveLength(0);
  });

  it('il database in uso, uno sconosciuto o uno incompleto non si possono importare', async () => {
    const data = await diagnose();
    const [inUse, , incomplete] = data.groups;
    legacy.clients.length = 0;
    expect(await previewLegacyImport(inUse?.source ?? '', { env: ENV })).toEqual({
      ok: false,
      failure: { code: 'source_in_use' },
    });
    expect(await previewLegacyImport('f'.repeat(32), { env: ENV })).toEqual({
      ok: false,
      failure: { code: 'unknown_source' },
    });
    expect(await previewLegacyImport(incomplete?.source ?? '', { env: ENV })).toEqual({
      ok: false,
      failure: { code: 'source_incomplete' },
    });
    expect(legacy.clients).toHaveLength(0);
  });

  it('lotti con «Continua» fino a zero; un secondo giro non importa nulla (idempotente)', async () => {
    const source = await oldSourceKey();
    const { previewToken } = await preview(source);
    const token = previewToken ?? '';

    const first = await importLegacyBatch(source, token, { env: ENV, now: NOW, batchSize: 3 });
    expect(first.ok && first.value.batch).toEqual({
      imported: 3,
      conflicts: 0,
      skippedExisting: 1,
      skippedInvalidEmail: 1,
      totalImported: 3,
      remaining: 1,
      done: false,
    });
    const second = await importLegacyBatch(source, token, { env: ENV, now: NOW, batchSize: 3 });
    expect(second.ok && second.value.batch).toMatchObject({
      imported: 1,
      totalImported: 4,
      remaining: 0,
      done: true,
    });
    const third = await importLegacyBatch(source, token, { env: ENV, now: NOW, batchSize: 3 });
    expect(third.ok && third.value.batch).toMatchObject({
      imported: 0,
      totalImported: 4,
      remaining: 0,
      done: true,
    });
    expect(current.tables.users).toHaveLength(6);
    expect(current.tables.imports).toHaveLength(4);
    for (const client of legacy.clients) expect(client.disconnected).toBe(true);

    const again = await preview(source);
    expect(again.stats).toMatchObject({ importable: 0, alreadyImported: 4 });
    expect(again.previewToken).toBeNull();
  });

  it('righe create: email minuscola, ruolo "user", id libero tenuto, password solo compatibile, OAuth senza token', async () => {
    const source = await oldSourceKey();
    const { previewToken } = await preview(source);
    await importLegacyBatch(source, previewToken ?? '', { env: ENV, now: NOW });

    const created = current.tables.users.slice(2);
    expect(created.map((u) => u.email)).toEqual([
      'anna@example.com',
      'bruno@example.com',
      'carla@example.com',
      'davide@example.com',
    ]);
    expect(created.every((u) => u.role === 'user')).toBe(true);
    const byEmail = Object.fromEntries(created.map((u) => [u.email, u]));
    expect(byEmail['anna@example.com']?.id).toBe('u-old-1');
    // L'id "u-old-5" era già usato qui: nuovo id, stesso registro.
    expect(byEmail['davide@example.com']?.id).not.toBe('u-old-5');
    expect(byEmail['davide@example.com']).toMatchObject({ banned: true, banReason: 'spam' });
    expect(byEmail['bruno@example.com']?.image).toBeNull();
    expect(byEmail['carla@example.com']).toMatchObject({
      image: 'https://cdn.example.com/c.png',
      phoneNumber: '+393331112222',
      phoneNumberVerified: true,
      createdAt: new Date('2024-03-01T10:00:00.000Z'),
    });

    const accounts = current.tables.accounts;
    expect(accounts.map((a) => [a.providerId, a.userId])).toEqual([
      ['credential', 'u-old-1'],
      ['google', 'u-old-3'],
      ['credential', byEmail['davide@example.com']?.id],
    ]);
    const anna = accounts[0];
    expect(anna).toMatchObject({ accountId: 'u-old-1', password: GOOD_HASH });
    const google = accounts[1];
    expect(google).toMatchObject({ accountId: 'sub-u-old-3', password: null });
    expect(google?.accessToken).toBeUndefined();
    expect(google?.refreshToken).toBeUndefined();
    expect(google?.idToken).toBeUndefined();
    expect(JSON.stringify(accounts)).not.toContain('segreto');
    // Bruno (bcrypt) non ha la credenziale: userà «Password dimenticata».
    expect(accounts.some((a) => a.userId === byEmail['bruno@example.com']?.id)).toBe(false);
    expect(current.tables.imports.map((r) => r.legacyUserId).sort()).toEqual([
      'u-old-1',
      'u-old-2',
      'u-old-3',
      'u-old-5',
    ]);
  });

  it('telefono già usato qui al momento del lotto → numero tolto', async () => {
    const source = await oldSourceKey();
    const { previewToken } = await preview(source);
    current.tables.users.push({
      ...currentUser('cur-tel', 'tel@example.com'),
      phoneNumber: '+393331112222',
    });
    await importLegacyBatch(source, previewToken ?? '', { env: ENV, now: NOW });
    const carla = current.tables.users.find((u) => u.email === 'carla@example.com');
    expect(carla).toMatchObject({ phoneNumber: null, phoneNumberVerified: null });
  });

  it('gettone scaduto → preview_expired, senza aprire il vecchio database', async () => {
    const source = await oldSourceKey();
    const { previewToken } = await preview(source);
    legacy.clients.length = 0;
    const later = new Date(NOW.getTime() + 16 * 60 * 1000);
    expect(await importLegacyBatch(source, previewToken ?? '', { env: ENV, now: later })).toEqual({
      ok: false,
      failure: { code: 'preview_expired' },
    });
    expect(legacy.clients).toHaveLength(0);
  });

  it('gettone di un’altra fonte o alterato → preview_invalid', async () => {
    const source = await oldSourceKey();
    const { previewToken } = await preview(source);
    const result = await importLegacyBatch('e'.repeat(32), previewToken ?? '', {
      env: ENV,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, failure: { code: 'preview_invalid' } });
    const tampered = await importLegacyBatch(source, `${previewToken}x`, { env: ENV, now: NOW });
    expect(tampered).toEqual({ ok: false, failure: { code: 'preview_invalid' } });
    expect(current.tables.imports).toHaveLength(0);
  });

  it('utente nuovo nel vecchio database dopo l’anteprima → preview_mismatch, nessuna scrittura', async () => {
    const source = await oldSourceKey();
    const { previewToken } = await preview(source);
    scenario.users.push(legacyUser('u-old-7', 'nuovo@example.com'));
    expect(await importLegacyBatch(source, previewToken ?? '', { env: ENV, now: NOW })).toEqual({
      ok: false,
      failure: { code: 'preview_mismatch' },
    });
    expect(current.tables.users).toHaveLength(2);
  });

  it('piano più piccolo dell’anteprima (email registrata nel frattempo) → va bene, quell’account saltato', async () => {
    const source = await oldSourceKey();
    const { previewToken } = await preview(source);
    current.tables.users.push(currentUser('cur-carla', 'CARLA@example.com'));
    const result = await importLegacyBatch(source, previewToken ?? '', { env: ENV, now: NOW });
    expect(result.ok && result.value.batch).toMatchObject({
      imported: 3,
      skippedExisting: 2,
      remaining: 0,
      done: true,
    });
    expect(
      current.tables.users.filter((u) => u.email.toLowerCase() === 'carla@example.com'),
    ).toHaveLength(1);
  });

  it('iscrizione concorrente durante il lotto: transazione annullata, poi uno alla volta, conflitto contato', async () => {
    const source = await oldSourceKey();
    const { previewToken } = await preview(source);
    current.concurrentSignups.push(currentUser('altro', 'anna@example.com'));
    const result = await importLegacyBatch(source, previewToken ?? '', { env: ENV, now: NOW });
    expect(result.ok && result.value.batch).toMatchObject({
      imported: 3,
      conflicts: 1,
      totalImported: 3,
      remaining: 0,
    });
    const annas = current.tables.users.filter((u) => u.email === 'anna@example.com');
    expect(annas).toEqual([expect.objectContaining({ id: 'altro', role: 'admin' })]);
    expect(current.tables.imports.map((r) => r.legacyUserId)).not.toContain('u-old-1');
  });

  it('stesso vecchio database con un’altra impronta (altro utente): account cancellati o con email cambiata qui non rinascono', async () => {
    const env = {
      ...ENV,
      SOLCO_DATABASE_URL: `postgresql://legacy_ro:pwR@${B_DIRECT}/solco?sslmode=require`,
    };
    const data = await diagnoseLegacyUsers({ env, now: NOW });
    if (!data.ok) throw new Error(data.failure.code);
    const first = data.value.groups.find((g) => g.envVars.includes('OLD_DATABASE_URL'));
    const second = data.value.groups.find((g) => g.envVars.includes('SOLCO_DATABASE_URL'));
    expect(first?.source).toBeTruthy();
    expect(second?.source).toBeTruthy();
    expect(first?.source).not.toBe(second?.source);

    const firstPreview = await previewLegacyImport(first?.source ?? '', { env, now: NOW });
    if (!firstPreview.ok) throw new Error(firstPreview.failure.code);
    const imported = await importLegacyBatch(
      first?.source ?? '',
      firstPreview.value.previewToken ?? '',
      { env, now: NOW },
    );
    expect(imported.ok && imported.value.batch.imported).toBe(4);

    // Anna cancella il suo account qui; Bruno cambia email.
    current.tables.users = current.tables.users.filter((u) => u.email !== 'anna@example.com');
    const bruno = current.tables.users.find((u) => u.email === 'bruno@example.com');
    if (bruno) bruno.email = 'bruno.nuovo@example.com';
    const usersBefore = current.tables.users.length;

    const again = await previewLegacyImport(second?.source ?? '', { env, now: NOW });
    if (!again.ok) throw new Error(again.failure.code);
    expect(again.value.stats).toMatchObject({ importable: 0, alreadyImported: 4 });
    expect(again.value.previewToken).toBeNull();
    expect(current.tables.users).toHaveLength(usersBefore);
    expect(current.tables.users.some((u) => u.email === 'anna@example.com')).toBe(false);
  });

  it('identità che il sito promuove ad admin: email mai create, id mai riusato', async () => {
    // Oltre all'email dell'admin designato (REQUESTED_ADMIN_EMAIL, assente da questi dati), l'email di
    // POLSIA_OWNER_EMAIL e l'id di ADMIN_USER_ID.
    const env = { ...ENV, POLSIA_OWNER_EMAIL: 'ANNA@example.com', ADMIN_USER_ID: 'u-old-3' };
    const data = await diagnoseLegacyUsers({ env, now: NOW });
    if (!data.ok) throw new Error(data.failure.code);
    const group = data.value.groups.find((g) => g.envVars.includes('OLD_DATABASE_URL'));
    expect(group?.stats).toMatchObject({ reservedAdmin: 1, importable: 3 });

    const result = await previewLegacyImport(group?.source ?? '', { env, now: NOW });
    if (!result.ok) throw new Error(result.failure.code);
    await importLegacyBatch(group?.source ?? '', result.value.previewToken ?? '', {
      env,
      now: NOW,
    });
    const emails = current.tables.users.map((u) => u.email.toLowerCase());
    expect(emails).not.toContain('anna@example.com');
    const carla = current.tables.users.find((u) => u.email === 'carla@example.com');
    expect(carla?.id).toBeTruthy();
    expect(carla?.id).not.toBe('u-old-3');
    const created = current.tables.users.filter((u) => u.name !== 'Attuale');
    expect(created).toHaveLength(3);
    expect(created.every((u) => u.role === 'user')).toBe(true);
  });

  it('identità riservata configurata dopo l’anteprima: il lotto non la crea (piano più piccolo)', async () => {
    const source = await oldSourceKey();
    const { previewToken } = await preview(source);
    const env = { ...ENV, POLSIA_OWNER_EMAIL: 'anna@example.com' };
    const result = await importLegacyBatch(source, previewToken ?? '', { env, now: NOW });
    expect(result.ok && result.value.batch).toMatchObject({ imported: 3, remaining: 0 });
    expect(current.tables.users.some((u) => u.email === 'anna@example.com')).toBe(false);
  });

  it('vecchio database irraggiungibile durante l’anteprima → source_unavailable con la categoria', async () => {
    const source = await oldSourceKey();
    scenario.fail = Object.assign(new Error(`Can't reach database server at ${B_DIRECT}`), {
      name: 'PrismaClientInitializationError',
      errorCode: 'P1001',
    });
    const result = await previewLegacyImport(source, { env: ENV, now: NOW });
    expect(result).toEqual({
      ok: false,
      failure: { code: 'source_unavailable', kind: 'unreachable' },
    });
    expect(legacy.clients[0]?.disconnected).toBe(true);
  });
});
