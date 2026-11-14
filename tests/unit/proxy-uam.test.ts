// @polsia:user-owned — il proxy con l'Under Attack Mode di Solco collegato: spento senza
// configurazione, attivo con UAM_MODE + UAM_SECRET, mai sulle API, e la CSP resta sempre.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sharedSongFromParams, songPreviewImagePath } from '@/lib/business/social-share';
import { sharedPlaylistImagePath } from '@/lib/music/playlist-share';
import { ipPrefix, issueClearance, UAM_COOKIE, uaHash } from '@/lib/security/uam';
import { proxy } from '@/proxy';

const SECRET = 'proxy-test-secret-0123456789-abcdefgh';
const IP = '203.0.113.42';
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const WHATSAPP = 'WhatsApp/2.23.20.0 A';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const SITE = 'https://www.solcomusic.online';
const SHARE_ID = 'AbCdEfGhIjKlMnOpQrStUv';

function request(
  path: string,
  method = 'GET',
  init: { headers?: Record<string, string>; ua?: string; origin?: string } = {},
) {
  return new NextRequest(`${init.origin ?? SITE}${path}`, {
    method,
    headers: { 'x-real-ip': IP, 'user-agent': init.ua ?? UA, ...init.headers },
  });
}

function enable(mode: 'first-visit' | 'attack') {
  vi.stubEnv('UAM_MODE', mode);
  vi.stubEnv('UAM_SECRET', SECRET);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', SITE);
}

function meta(html: string, key: string): string | null {
  const match = new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)">`).exec(html);
  return match ? (match[1] ?? '').replace(/&amp;/g, '&') : null;
}

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_TRUSTED_ORIGINS', '');
  vi.stubEnv('VERCEL_URL', '');
  vi.stubEnv('VERCEL_BRANCH_URL', '');
  vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', '');
  vi.stubEnv('UAM_DIFFICULTY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('proxy + Under Attack Mode', () => {
  it('senza configurazione la pagina passa, con la CSP stretta', async () => {
    vi.stubEnv('UAM_MODE', '');
    const response = await proxy(request('/'));
    expect(response.headers.get('x-solco-gate')).toBeNull();
    expect(response.headers.get('content-security-policy')).toContain("'strict-dynamic'");
    expect(response.headers.get('x-solco-edge')).toBe('1');
  });

  it('modalità attacco: schermata di verifica (503) prima delle pagine', async () => {
    enable('attack');
    const response = await proxy(request('/'));
    expect(response.status).toBe(503);
    expect(response.headers.get('x-solco-gate')).toBe('challenge');
    expect(response.headers.get('retry-after')).toBe('5');
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('le API, le immagini di anteprima e /health non vengono mai fermate', async () => {
    enable('attack');
    for (const path of [
      '/api/telegram/webhook',
      '/search/anteprima.png',
      '/search/anteprima.jpg?t=Brano&a=Artista',
      `/playlist/${SHARE_ID}/anteprima.jpg`,
      '/health',
    ]) {
      const response = await proxy(request(path, path.startsWith('/api') ? 'POST' : 'GET'));
      expect(response.headers.get('x-solco-gate'), path).toBeNull();
      expect(response.headers.get('x-solco-edge'), path).toBe('1');
    }
  });

  it('segreto troppo corto: spenta (mai un blocco per una configurazione sbagliata)', async () => {
    enable('attack');
    vi.stubEnv('UAM_SECRET', 'corto');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await proxy(request('/'));
    expect(response.headers.get('x-solco-gate')).toBeNull();
  });
});

describe('proxy: estensioni statiche esenti solo dove ci sono file', () => {
  it.each([
    '/albums/x.png',
    '/generi/x.json',
    '/profiles/abc/x.jpg',
    '/playlist/x.png',
    // Nella radice, in /fonts/ e in /brand/ solo i file veri (o con la forma giusta).
    '/a1.png',
    '/fonts/x.png',
    '/brand/spotify/x.json',
    // Il matcher ora li fa passare dal proxy (tests/unit/proxy-matcher.test.ts): qui il gate.
    '/apiary',
    '/api-docs',
    '/favicon.icox',
  ])('%s passa dal gate (nessun file: Next renderebbe una pagina)', async (path) => {
    enable('attack');
    const response = await proxy(request(path));
    expect(response.status).toBe(503);
    expect(response.headers.get('x-solco-gate')).toBe('challenge');
  });

  it.each([
    '/search/anteprima.jpg',
    '/fonts/inter/inter-400-normal-latin.woff2',
    '/brand/spotify/full-logo-green.svg',
    '/sw.js',
    '/apple-touch-icon.png',
  ])('il file %s non passa dal gate', async (path) => {
    enable('attack');
    const response = await proxy(request(path));
    expect(response.headers.get('x-solco-gate')).toBeNull();
    expect(response.headers.get('x-solco-edge')).toBe('1');
  });
});

describe('proxy: navigazioni client (RSC) in modalità attacco', () => {
  async function staleClearance(issuedIn: 'attack' | 'first-visit' = 'attack'): Promise<string> {
    const ctx = { secret: SECRET, ipPrefix: ipPrefix(IP), uaHash: await uaHash(UA) };
    return issueClearance({ ...ctx, now: Date.now() - 2 * 3600_000 }, issuedIn);
  }

  it('una clearance di 2 ore fa basta per una richiesta RSC (il player non si ferma)', async () => {
    enable('attack');
    const cookie = `${UAM_COOKIE}=${await staleClearance()}`;
    const response = await proxy(
      request('/music?_rsc=abc', 'GET', { headers: { rsc: '1', cookie } }),
    );
    expect(response.headers.get('x-solco-gate')).toBeNull();
    expect(response.headers.get('content-security-policy')).toContain("'strict-dynamic'");
    expect(response.headers.get('x-solco-edge')).toBe('1');
  });

  it.each(['document', 'empty', 'iframe'])(
    'la stessa clearance non basta per un documento (Sec-Fetch-Dest: %s, senza RSC)',
    async (dest) => {
      enable('attack');
      const cookie = `${UAM_COOKIE}=${await staleClearance()}`;
      const response = await proxy(
        request('/music', 'GET', { headers: { 'sec-fetch-dest': dest, cookie } }),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('x-solco-gate')).toBe('challenge');
    },
  );

  it('una clearance di first-visit di 2 ore fa non basta neanche per RSC', async () => {
    enable('attack');
    const cookie = `${UAM_COOKIE}=${await staleClearance('first-visit')}`;
    const response = await proxy(
      request('/music?_rsc=abc', 'GET', { headers: { rsc: '1', cookie } }),
    );
    expect(response.status).toBe(503);
  });

  it('senza clearance anche la richiesta RSC riceve la schermata', async () => {
    enable('attack');
    const response = await proxy(request('/music?_rsc=abc', 'GET', { headers: { rsc: '1' } }));
    expect(response.status).toBe(503);
    expect(response.headers.get('x-solco-gate')).toBe('challenge');
  });
});

describe('proxy: bot delle anteprime in modalità attacco', () => {
  it('un brano condiviso (/search) mostra titolo, artista e la sua immagine', async () => {
    enable('attack');
    const path = '/search?q=Mina%20Grande&t=Grande%20grande%20grande&a=Mina';
    const response = await proxy(request(path, 'GET', { ua: WHATSAPP }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-solco-gate')).toBe('preview');
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await response.text();
    const song = sharedSongFromParams({ q: 'Mina Grande', t: 'Grande grande grande', a: 'Mina' });
    expect(meta(html, 'og:title')).toBe('Grande grande grande · Mina');
    expect(meta(html, 'og:image')).toBe(`${SITE}${songPreviewImagePath(song)}`);
    expect(meta(html, 'og:url')).toBe(`${SITE}${path}`);
    expect(meta(html, 'twitter:card')).toBe('summary_large_image');
    expect(meta(html, 'robots')).toBe('noindex');
    expect(html).not.toContain('<script');
  });

  it('una playlist condivisa (/playlist/<id>)', async () => {
    enable('attack');
    const response = await proxy(
      request(`/playlist/${SHARE_ID}`, 'GET', {
        ua: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      }),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(meta(html, 'og:title')).toBe('Playlist condivisa su Solco');
    expect(meta(html, 'og:image')).toBe(`${SITE}${sharedPlaylistImagePath(SHARE_ID)}`);
    expect(meta(html, 'og:url')).toBe(`${SITE}/playlist/${SHARE_ID}`);
  });

  it('la home (/) mostra la scheda di Solco', async () => {
    enable('attack');
    const response = await proxy(request('/', 'GET', { ua: 'TelegramBot (like TwitterBot)' }));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(meta(html, 'og:title')).toBe('Solco');
    expect(meta(html, 'og:image')).toBe(`${SITE}/opengraph-image`);
    expect(meta(html, 'og:url')).toBe(`${SITE}/`);
  });

  it('senza NEXT_PUBLIC_APP_URL https gli URL usano l’origine della richiesta', async () => {
    enable('attack');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
    const response = await proxy(
      request('/', 'GET', { ua: WHATSAPP, origin: 'http://localhost:3000' }),
    );
    expect(response.status).toBe(200);
    expect(meta(await response.text(), 'og:image')).toBe('http://localhost:3000/opengraph-image');
  });

  it('i crawler di ricerca ricevono ancora 503 + Retry-After', async () => {
    enable('attack');
    const response = await proxy(request('/', 'GET', { ua: GOOGLEBOT }));
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(response.headers.get('x-solco-gate')).toBe('challenge');
  });

  it('in modalità first-visit i bot passano come prima (pagina vera, con la CSP)', async () => {
    enable('first-visit');
    const response = await proxy(request('/', 'GET', { ua: WHATSAPP }));
    expect(response.headers.get('x-solco-gate')).toBeNull();
    expect(response.headers.get('content-security-policy')).toContain("'strict-dynamic'");
  });
});

describe('proxy: host fuori da uamChallengeHosts', () => {
  const STATUS = 'https://status.solcomusic.online';

  it('modalità attacco: 308 allo stesso percorso sul dominio canonico', async () => {
    enable('attack');
    const response = await proxy(request('/stato?x=1', 'GET', { origin: STATUS }));
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe(`${SITE}/stato?x=1`);
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    const post = await proxy(request('/stato', 'POST', { origin: STATUS }));
    expect(post.status).toBe(405);
  });

  it('modalità first-visit: passa come prima', async () => {
    enable('first-visit');
    const response = await proxy(request('/stato', 'GET', { origin: STATUS }));
    expect(response.headers.get('x-solco-gate')).toBeNull();
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-solco-edge')).toBe('1');
  });

  it('modalità attacco: le API e /health di quell’host non vengono toccate', async () => {
    enable('attack');
    for (const path of ['/api/health', '/health']) {
      const response = await proxy(request(path, 'GET', { origin: STATUS }));
      expect(response.headers.get('location'), path).toBeNull();
      expect(response.headers.get('x-solco-gate'), path).toBeNull();
    }
  });
});
