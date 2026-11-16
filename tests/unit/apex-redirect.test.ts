// @polsia:user-owned — dominio nudo → www per hstspreload.org: il proxy risponde 308 verso l'origine
// canonica con HSTS completo (includeSubDomains, preload), percorso e query intatti, solo quando la
// richiesta arriva su solcomusic.online (host o x-forwarded-host); www, sottodomini e anteprime senza
// www non sono toccati. In next.user-config.ts restano i redirect di /api (fuori dal proxy) e quelli
// del sottodominio di stato.
// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apexHostOf,
  apexRedirect,
  HSTS_PRELOAD_VALUE,
  requestHost,
} from '@/lib/security/apex-redirect';
import { proxy } from '@/proxy';
import { userNextConfig } from '../../next.user-config';

const CANONICAL = 'https://www.solcomusic.online';
const ENV = { NEXT_PUBLIC_APP_URL: CANONICAL };

function request(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { headers });
}

describe('apexHostOf / requestHost', () => {
  it('ricava il dominio nudo solo da un’origine canonica con www.', () => {
    expect(apexHostOf(CANONICAL)).toBe('solcomusic.online');
    expect(apexHostOf('https://WWW.Solcomusic.online/')).toBe('solcomusic.online');
    expect(apexHostOf('https://solcomusic.vercel.app')).toBeNull();
    expect(apexHostOf('http://localhost:3000')).toBeNull();
    expect(apexHostOf('non un url')).toBeNull();
    expect(apexHostOf(null)).toBeNull();
  });

  it('preferisce x-forwarded-host (prima voce) all’host dell’URL', () => {
    expect(requestHost(request('https://solcomusic.online/'))).toBe('solcomusic.online');
    expect(
      requestHost(
        request('http://10.0.0.5:3000/', { 'x-forwarded-host': 'Solcomusic.online, 10.0.0.5' }),
      ),
    ).toBe('solcomusic.online');
  });
});

describe('apexRedirect', () => {
  it('dal dominio nudo: 308 verso www con HSTS completo, percorso e query intatti', () => {
    for (const req of [
      request('https://solcomusic.online/guida?x=1&y=2'),
      request('http://127.0.0.1:3000/guida?x=1&y=2', { 'x-forwarded-host': 'solcomusic.online' }),
    ]) {
      const response = apexRedirect(req, ENV);
      expect(response?.status).toBe(308);
      expect(response?.headers.get('location')).toBe(`${CANONICAL}/guida?x=1&y=2`);
      expect(response?.headers.get('strict-transport-security')).toBe(HSTS_PRELOAD_VALUE);
      expect(HSTS_PRELOAD_VALUE).toMatch(/max-age=\d{8,}; includeSubDomains; preload/);
      expect(response?.headers.get('cache-control')).toContain('max-age');
    }
    expect(apexRedirect(request('https://solcomusic.online/'), ENV)?.headers.get('location')).toBe(
      `${CANONICAL}/`,
    );
  });

  it('un percorso che prova a cambiare origine resta sull’origine canonica', () => {
    const response = apexRedirect(request('https://solcomusic.online//altro.example/x'), ENV);
    const location = response?.headers.get('location') ?? '';
    expect(new URL(location).origin).toBe(CANONICAL);
  });

  it('non tocca www, sottodomini, altri host né le anteprime senza www', () => {
    for (const url of [
      `${CANONICAL}/`,
      'https://status.solcomusic.online/',
      'https://solcomusic.vercel.app/',
      'http://localhost:3000/',
    ]) {
      expect(apexRedirect(request(url), ENV), url).toBeNull();
    }
    expect(
      apexRedirect(request('https://solcomusic.vercel.app/'), {
        NEXT_PUBLIC_APP_URL: 'https://solcomusic.vercel.app',
      }),
    ).toBeNull();
    expect(apexRedirect(request('https://solcomusic.online/'), {})).toBeNull();
  });
});

describe('proxy: il dominio nudo reindirizza prima di tutto', () => {
  const saved = process.env.NEXT_PUBLIC_APP_URL;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = CANONICAL;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = saved;
  });

  it('solcomusic.online/… → 308 con HSTS; www passa', async () => {
    const redirected = await proxy(request('https://solcomusic.online/search?q=a'));
    expect(redirected.status).toBe(308);
    expect(redirected.headers.get('location')).toBe(`${CANONICAL}/search?q=a`);
    expect(redirected.headers.get('strict-transport-security')).toBe(HSTS_PRELOAD_VALUE);

    const served = await proxy(request(`${CANONICAL}/search?q=a`));
    expect(served.status).toBe(200);
    expect(served.headers.get('location')).toBeNull();
  });
});

describe('redirects() di next.user-config.ts', () => {
  it('copre /api del dominio nudo (fuori dal proxy) e lascia stato e www', async () => {
    const rules = (await userNextConfig.redirects?.()) ?? [];
    const apex = rules.filter((rule) => rule.destination === `${CANONICAL}/api/:path*`);
    expect(apex).toHaveLength(2);
    for (const rule of apex) {
      expect(rule.source).toBe('/api/:path*');
      expect(rule.permanent).toBe(true);
    }
    expect(apex.map((rule) => rule.has)).toEqual(
      expect.arrayContaining([
        [{ type: 'host', value: 'solcomusic.online' }],
        [{ type: 'header', key: 'x-forwarded-host', value: 'solcomusic.online' }],
      ]),
    );
    const hosts = rules.flatMap((rule) => (rule.has ?? []).map((condition) => condition.value));
    expect(hosts).not.toContain('www.solcomusic.online');
    expect(rules.filter((rule) => rule.destination === '/stato')).toHaveLength(2);
  });
});
