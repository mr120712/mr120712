// @polsia:user-owned
// @vitest-environment node
//
// Regola ferrea dell'amministrazione (src/lib/security/admin-gate.ts): /admin esiste solo per un
// amministratore con email verificata; per tutti gli altri, motori di ricerca compresi, è un 404
// senza nulla dell'amministrazione, mai in cache né indicizzabile. Provata da sola e nel proxy.
import { getSessionCookie } from 'better-auth/cookies';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));
// Il gate carica better-auth solo quando serve: qui la sessione è finta.
vi.mock('@/lib/auth', () => ({ auth: { api: { getSession: mocks.getSession } } }));

import {
  ADMIN_ROBOTS,
  type AdminSessionUser,
  adminGate,
  hasSessionCookie,
  isAdminPath,
} from '@/lib/security/admin-gate';
import { proxy } from '@/proxy';

const SITE = 'https://www.solcomusic.online';
const SESSION = '__Secure-better-auth.session_token=token.firma';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const ADMIN = { role: 'admin', emailVerified: true };

function request(path: string, cookie?: string, ua = 'Mozilla/5.0 Safari/604.1') {
  return new NextRequest(`${SITE}${path}`, {
    headers: { 'user-agent': ua, 'x-real-ip': '203.0.113.7', ...(cookie ? { cookie } : {}) },
  });
}

const reader = (user: AdminSessionUser) => vi.fn(async () => user);

beforeEach(() => {
  mocks.getSession.mockReset();
  vi.stubEnv('BETTER_AUTH_TRUSTED_ORIGINS', '');
  vi.stubEnv('VERCEL_URL', '');
  vi.stubEnv('VERCEL_BRANCH_URL', '');
  vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', '');
  vi.stubEnv('UAM_MODE', '');
  vi.stubEnv('UAM_DIFFICULTY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function expectHidden(response: Response | null, status = 404) {
  expect(response?.status).toBe(status);
  expect(response?.headers.get('x-robots-tag')).toBe(ADMIN_ROBOTS);
  expect(response?.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  expect(response?.headers.get('content-security-policy')).toContain("default-src 'none'");
  const html = (await response?.text()) ?? '';
  expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  // Nulla dell'amministrazione: niente script, niente parole che la rivelino.
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/amministra|admin/i);
  return html;
}

describe('regola ferrea /admin: quali percorsi', () => {
  it('riconosce /admin e ogni sottopagina, anche scritte in modo diverso o in forma RSC', () => {
    for (const path of [
      '/admin',
      '/admin/',
      '/admin/iscritti',
      '/admin/monitoraggio/dettaglio',
      '/ADMIN',
      '/Admin/Monitoraggio',
      '/%61dmin',
      '/%2561dmin',
      '//admin',
      '/\\admin',
      '/admin.rsc',
      '/admin/iscritti.rsc',
      '/admin.segments/_tree.segment.rsc',
      '/_next/data/build-123/admin.json',
      '/admin;jsessionid=1',
    ]) {
      expect(isAdminPath(path), path).toBe(true);
    }
  });

  it('non tocca le altre pagine (le API admin si proteggono da sole)', () => {
    for (const path of [
      '/',
      '/administrator',
      '/admins',
      '/adminx',
      '/dashboard',
      '/search',
      '/x/admin',
      '/api/admin/signups',
    ]) {
      expect(isAdminPath(path), path).toBe(false);
    }
  });

  it('riconosce il cookie di sessione esattamente come better-auth', () => {
    for (const cookie of [
      '',
      'altro=1',
      SESSION,
      'better-auth.session_token=abc',
      'better-auth-session_token=abc',
      '__Secure-better-auth-session_token=abc',
      'better-auth.session_token=',
      'x=1; better-auth.session_token=abc; y=2',
      'better-auth.session_data=abc',
      '__Host-better-auth.session_token=abc',
    ]) {
      const headers = new Headers(cookie ? { cookie } : {});
      expect(hasSessionCookie(headers), cookie).toBe(getSessionCookie(headers) !== null);
    }
  });
});

describe('regola ferrea /admin: chi passa', () => {
  it('senza cookie di sessione: 404, senza nemmeno leggere il database', async () => {
    const read = reader(ADMIN);
    await expectHidden(await adminGate(request('/admin'), read));
    await expectHidden(await adminGate(request('/admin/iscritti', 'altro=1'), read));
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ['sessione scaduta o falsa', null],
    ['utente normale', { role: 'user', emailVerified: true }],
    ['admin con email non verificata', { role: 'admin', emailVerified: false }],
    ['ruolo mancante', { emailVerified: true }],
    ['ruolo che contiene "admin" ma non è admin', { role: 'superadmin', emailVerified: true }],
  ])('%s: 404 come una pagina che non esiste', async (_label, user) => {
    const read = reader(user as AdminSessionUser);
    const html = await expectHidden(await adminGate(request('/admin/monitoraggio', SESSION), read));
    expect(html).toContain('Pagina non trovata');
    expect(read).toHaveBeenCalledOnce();
  });

  it('amministratore con email verificata: passa (anche con più ruoli)', async () => {
    expect(await adminGate(request('/admin/iscritti', SESSION), reader(ADMIN))).toBeNull();
    expect(
      await adminGate(
        request('/admin', SESSION),
        reader({ role: 'user, admin', emailVerified: true }),
      ),
    ).toBeNull();
  });

  it('sessione non leggibile (database irraggiungibile): 503 generico, nessuno passa', async () => {
    const read = vi.fn(async () => {
      throw new Error('database giù');
    });
    const response = await adminGate(request('/admin', SESSION), read);
    const html = await expectHidden(response, 503);
    expect(response?.headers.get('retry-after')).toBe('30');
    expect(html).toContain('Riprova tra poco');
  });

  it('le altre pagine proseguono senza alcun controllo', async () => {
    const read = reader(null);
    expect(await adminGate(request('/'), read)).toBeNull();
    expect(await adminGate(request('/dashboard', SESSION), read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('regola ferrea /admin nel proxy', () => {
  it('Googlebot e chiunque senza sessione ricevono 404, mai la pagina', async () => {
    for (const path of ['/admin', '/admin/iscritti', '/admin/visitatori']) {
      await expectHidden(await proxy(request(path, undefined, GOOGLEBOT)));
    }
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it('vale prima dell’Under Attack Mode: nessuna schermata di verifica né anteprima per /admin', async () => {
    vi.stubEnv('UAM_MODE', 'attack');
    vi.stubEnv('UAM_SECRET', 'admin-gate-test-secret-0123456789-abcdef');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', SITE);
    await expectHidden(await proxy(request('/admin', undefined, GOOGLEBOT)));
    await expectHidden(await proxy(request('/admin', undefined, 'WhatsApp/2.23.20.0 A')));
  });

  it('un utente normale con sessione riceve 404; l’amministratore la pagina, con la CSP', async () => {
    mocks.getSession.mockResolvedValueOnce({ user: { role: 'user', emailVerified: true } });
    await expectHidden(await proxy(request('/admin', SESSION)));

    mocks.getSession.mockResolvedValueOnce({ user: ADMIN });
    const admin = await proxy(request('/admin', SESSION));
    expect(admin.status).toBe(200);
    expect(admin.headers.get('content-security-policy')).toMatch(/nonce-/);
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
  });

  it('le pagine pubbliche non leggono la sessione', async () => {
    const home = await proxy(request('/', SESSION));
    expect(home.status).toBe(200);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
});

describe('regola ferrea: nessuna strada pubblica porta a /admin', () => {
  const PRIVATE = /^\/(?:admin|api)(?:[/.]|$)/i;

  it('robots.txt tiene fuori /admin e le API', async () => {
    const { robotsConfig } = await import('@/lib/robots-config');
    expect(robotsConfig.disallow).toEqual(expect.arrayContaining(['/admin', '/api/']));
  });

  it('sitemap.xml e llms.txt non elencano /admin né le API', async () => {
    // Le pagine pubbliche vere (menu, generi, artisti) senza le variabili di produzione.
    vi.stubEnv('SKIP_ENV_VALIDATION', '1');
    vi.stubEnv('SEO_INDEXABLE', 'true');
    const sitemap = (await import('@/app/sitemap')).default;
    const entries = await sitemap();
    expect(entries.length).toBeGreaterThan(5);
    for (const entry of entries) {
      expect(new URL(entry.url).pathname, entry.url).not.toMatch(PRIVATE);
    }
    const { GET } = await import('@/app/llms.txt/route');
    const text = await (await GET()).text();
    expect(text.length).toBeGreaterThan(100);
    expect(text).not.toMatch(/\/admin(?:[/.)\s]|$)/m);
    expect(text).not.toMatch(/\/api\//);
  });

  it('nessuna voce del menu punta a /admin o alle API', async () => {
    const { navItems } = await import('@/lib/nav');
    for (const item of navItems) expect(item.href, item.label).not.toMatch(PRIVATE);
  });

  it('anche all’amministratore la pagina arriva noindex, nofollow e senza copia', async () => {
    const { metadata } = await import('@/app/(dashboard)/admin/layout');
    expect(metadata.robots).toMatchObject({ index: false, follow: false, nocache: true });
  });
});
