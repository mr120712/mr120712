// @polsia:user-owned
// @vitest-environment node
//
// Regola ferrea, lato API: OGNI route sotto src/app/api/admin (trovate da sole: una route nuova
// entra nel test senza toccarlo) risponde a chi non è un amministratore con email verificata
// senza mai un esito 2xx, senza leggere o scrivere il database e senza chiamare servizi esterni.
// Il database finto lancia a ogni accesso e lo annota; il fetch globale annota ogni chiamata.
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  dbAccess: [] as string[],
  fetchCalls: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock('@/lib/db', () => ({
  prisma: new Proxy(
    {},
    {
      get(_target, property) {
        mocks.dbAccess.push(String(property));
        throw new Error(`database usato senza autorizzazione: ${String(property)}`);
      },
    },
  ),
}));
// Origine sempre accettata e nessun limite: così ciò che ferma la richiesta è il controllo admin.
vi.mock('@/lib/same-origin', () => ({ sameOrigin: () => true }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: async () => null,
  consumeRateLimit: async () => ({ allowed: true }),
  getRateLimitIdentity: () => 'ip:203.0.113.9',
}));
vi.mock('@/lib/env', () => ({ env: new Proxy({}, { get: () => undefined }) }));

const ROOT = join(process.cwd(), 'src/app/api/admin');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Handler = (request: Request, context: unknown) => Promise<Response> | Response;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === 'route.ts' ? [path] : [];
  });
}

const FILES = routeFiles(ROOT)
  .map((file) => relative(ROOT, file).split(sep).join('/'))
  .sort();

/** Parametri dinamici ([sourceId] e simili): qualunque nome vale "x". */
const context = {
  params: Promise.resolve(new Proxy({}, { get: () => 'xxxxxxxxxxx' })),
};

function request(route: string, method: string) {
  const path = route.replace(/\/route\.ts$/, '').replace(/\[([^\]]+)\]/g, 'xxxxxxxxxxx');
  return new Request(`https://www.solcomusic.online/api/admin/${path}?code=x&state=x`, {
    method,
    headers: {
      origin: 'https://www.solcomusic.online',
      'content-type': 'application/json',
      cookie: '__Secure-better-auth.session_token=token.firma',
    },
    ...(method === 'GET' ? {} : { body: '{}' }),
  });
}

const IDENTITIES = [
  ['anonimo', null],
  ['utente normale', { user: { id: 'u1', role: 'user', emailVerified: true, email: 'a@b.it' } }],
  [
    'admin con email non verificata',
    { user: { id: 'u2', role: 'admin', emailVerified: false, email: 'c@d.it' } },
  ],
] as const;

const realFetch = globalThis.fetch;
beforeAll(() => {
  // Servizi configurati come in produzione (valori finti): così anche le route OAuth di audio.com
  // e TikTok arrivano al controllo della sessione invece di fermarsi su «non configurato».
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://www.solcomusic.online');
  vi.stubEnv('BETTER_AUTH_SECRET', 'segreto-di-prova-lungo-almeno-32-caratteri!!');
  vi.stubEnv('TIKTOK_CLIENT_KEY', 'clientkey123');
  vi.stubEnv('TIKTOK_CLIENT_SECRET', 'client-secret-di-prova-0123456789');
  vi.stubEnv('YOUTUBE_DATA_API_KEY', 'chiave-finta');
  vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_finto_0123456789');
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    mocks.fetchCalls.push(String(input instanceof Request ? input.url : input));
    throw new Error('chiamata esterna senza autorizzazione');
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});
beforeEach(() => {
  mocks.getSession.mockReset();
  mocks.dbAccess.length = 0;
  mocks.fetchCalls.length = 0;
});

describe('regola ferrea: API di amministrazione', () => {
  it('le route admin sono tutte qui (nessuna sfugge al test)', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(37);
    expect(FILES).toContain('signups/route.ts');
    expect(FILES).toContain('tiktok/connect/callback/route.ts');
  });

  it.each(FILES)('%s: nessun esito, dato o servizio esterno per chi non è admin', async (route) => {
    const module = (await import(`@/app/api/admin/${route.replace(/\.ts$/, '')}`)) as Record<
      string,
      unknown
    >;
    const handlers = METHODS.filter((method) => typeof module[method] === 'function');
    expect(handlers.length, route).toBeGreaterThan(0);
    for (const [label, session] of IDENTITIES) {
      for (const method of handlers) {
        mocks.getSession.mockResolvedValue(session);
        const response = await (module[method] as Handler)(request(route, method), context);
        const where = `${method} ${route} (${label})`;
        expect(response.status, where).not.toBeLessThan(300);
        expect(mocks.dbAccess, where).toEqual([]);
        expect(mocks.fetchCalls, where).toEqual([]);
      }
    }
  });

  it('controprova: per un amministratore verificato la stessa route arriva ai dati', async () => {
    const module = await import('@/app/api/admin/signups/route');
    mocks.getSession.mockResolvedValue({
      user: { id: 'a1', role: 'admin', emailVerified: true, email: 'admin@x.it' },
    });
    await module.GET(request('signups/route.ts', 'GET'));
    // Il database finto lancia: conta solo che l'admin ci sia arrivato.
    expect(mocks.dbAccess.length).toBeGreaterThan(0);
  });
});
