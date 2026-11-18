// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ipPrefix,
  issueClearance,
  UAM_COOKIE,
  type UamContext,
  uaHash,
  verifyChallenge,
} from '@/lib/security/uam';

// The real loading screen (src/lib/security/uam-page.ts), wrapped in spies so
// the tests can read what the gate passes it and make it throw (fail open).
vi.mock('@/lib/security/uam-page', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/uam-page')>();
  return {
    ...actual,
    renderUamPage: vi.fn(actual.renderUamPage),
    uamPageCsp: vi.fn(actual.uamPageCsp),
  };
});

// La paginetta per i bot delle anteprime, vera ma spiata (per farla fallire: fail open).
vi.mock('@/lib/security/uam-preview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/uam-preview')>();
  return { ...actual, renderLinkPreviewPage: vi.fn(actual.renderLinkPreviewPage) };
});

// «Skynet»: la prova DNS dei motori di ricerca (crawler-verify.ts) è finta: nessuna rete nei test.
const crawler = vi.hoisted(() => ({ verifySearchCrawler: vi.fn(async () => false) }));
vi.mock('@/lib/security/crawler-verify', () => crawler);

import { uamGate } from '@/lib/security/uam-gate';
import * as uamPage from '@/lib/security/uam-page';
import * as uamPreview from '@/lib/security/uam-preview';

const page = {
  renderUamPage: vi.mocked(uamPage.renderUamPage),
  uamPageCsp: vi.mocked(uamPage.uamPageCsp),
};
const preview = { renderLinkPreviewPage: vi.mocked(uamPreview.renderLinkPreviewPage) };

const SECRET = 'gate-test-secret-0123456789-abcdefgh';
const IP = '203.0.113.42';
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

function enable(mode: 'first-visit' | 'attack', difficulty?: string) {
  vi.stubEnv('UAM_MODE', mode);
  vi.stubEnv('UAM_SECRET', SECRET);
  vi.stubEnv('UAM_DIFFICULTY', difficulty ?? '');
}

function request(
  path = '/',
  init: {
    method?: string;
    headers?: Record<string, string>;
    ip?: string;
    ua?: string;
    origin?: string;
  } = {},
): NextRequest {
  const headers: Record<string, string> = {
    'x-real-ip': init.ip ?? IP,
    'user-agent': init.ua ?? UA,
    ...init.headers,
  };
  return new NextRequest(`${init.origin ?? 'https://solcomusic.vercel.app'}${path}`, {
    method: init.method ?? 'GET',
    headers,
  });
}

/** Input of the n-th renderUamPage call (throws if there was none). */
function rendered(index = 0): uamPage.UamPageInput {
  const call = page.renderUamPage.mock.calls[index];
  if (!call) throw new Error(`renderUamPage call #${index} missing`);
  return call[0];
}

async function clientCtx(ip = IP, ua = UA): Promise<UamContext> {
  return { secret: SECRET, ipPrefix: ipPrefix(ip), uaHash: await uaHash(ua) };
}

beforeEach(() => {
  crawler.verifySearchCrawler.mockReset();
  crawler.verifySearchCrawler.mockResolvedValue(false);
  vi.stubEnv('UAM_MODE', '');
  vi.stubEnv('UAM_SECRET', '');
  vi.stubEnv('UAM_DIFFICULTY', '');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://solcomusic.vercel.app');
  vi.stubEnv('BETTER_AUTH_TRUSTED_ORIGINS', '');
  vi.stubEnv('VERCEL_URL', '');
  vi.stubEnv('VERCEL_BRANCH_URL', '');
  vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', '');
  page.renderUamPage.mockClear();
  page.uamPageCsp.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('uamGate — pass-through', () => {
  it('lets everything through when UAM is not configured', async () => {
    expect(await uamGate(request())).toBeNull();
    expect(page.renderUamPage).not.toHaveBeenCalled();
  });

  it("lets everything through in mode 'off' even with a valid secret", async () => {
    vi.stubEnv('UAM_MODE', 'off');
    vi.stubEnv('UAM_SECRET', SECRET);
    expect(await uamGate(request())).toBeNull();
  });

  it('warns once per instance (without throwing) when the secret is too short', async () => {
    vi.resetModules();
    const { uamGate: freshGate } = await import('@/lib/security/uam-gate');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('UAM_MODE', 'attack');
    vi.stubEnv('UAM_SECRET', 'too-short');
    expect(await freshGate(request())).toBeNull();
    expect(await freshGate(request())).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain('too-short');
  });

  it.each([
    'https://www.example.com',
    'https://solcomusic-git-main-team.vercel.app',
    'http://localhost:3000',
  ])(
    'lets requests to %s through in first-visit mode (verify would refuse its origin)',
    async (origin) => {
      enable('first-visit');
      expect(await uamGate(request('/', { origin }))).toBeNull();
      expect(await uamGate(request('/', { origin, method: 'POST' }))).toBeNull();
      expect(page.renderUamPage).not.toHaveBeenCalled();
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'lets %s through with a valid clearance cookie',
    async (method) => {
      enable('attack');
      const cookie = await issueClearance(await clientCtx(), 'attack');
      const response = await uamGate(
        request('/', { method, headers: { cookie: `${UAM_COOKIE}=${cookie}` } }),
      );
      expect(response).toBeNull();
    },
  );

  it.each([
    '/api/music/radio',
    '/_next/static/chunks/app.js',
    '/health',
    '/icon.svg',
    '/robots.txt',
    '/search/anteprima.jpg?t=Brano',
    '/search/anteprima.png?t=Brano',
    '/playlist/AbCdEfGhIjKlMnOpQrStUv/anteprima.jpg',
    '/fonts/inter/inter-400-normal-latin.woff2',
    '/sw.js',
    '/solco.apk',
  ])('lets the non-gateable path %s through', async (path) => {
    enable('attack');
    expect(await uamGate(request(path))).toBeNull();
  });

  it.each([
    '/a1.png',
    '/x.js',
    '/fonts/x.png',
    '/fonts/inter/x.json',
    '/brand/spotify/x.json',
    '/albums/x.png',
  ])('challenges %s (no such file: Next would render a page)', async (path) => {
    enable('attack');
    const response = await uamGate(request(path));
    expect(response?.status).toBe(503);
    expect(response?.headers.get('x-solco-gate')).toBe('challenge');
  });

  it('lets a valid clearance cookie through', async () => {
    enable('first-visit');
    const cookie = await issueClearance(await clientCtx(), 'first-visit');
    const response = await uamGate(
      request('/music', { headers: { cookie: `${UAM_COOKIE}=${cookie}` } }),
    );
    expect(response).toBeNull();
  });

  it('accepts the clearance from another address of the same /16 network', async () => {
    enable('first-visit');
    const cookie = await issueClearance(await clientCtx('203.0.1.1'), 'first-visit');
    const response = await uamGate(
      request('/', { ip: '203.0.200.7', headers: { cookie: `${UAM_COOKIE}=${cookie}` } }),
    );
    expect(response).toBeNull();
  });

  it('lets Googlebot through in first-visit mode only when DNS confirms it is Google', async () => {
    enable('first-visit');
    crawler.verifySearchCrawler.mockResolvedValueOnce(true);
    expect(await uamGate(request('/', { ua: GOOGLEBOT }))).toBeNull();
    // La prova riceve l'indirizzo scritto da Vercel (x-real-ip) e lo User-Agent.
    expect(crawler.verifySearchCrawler).toHaveBeenLastCalledWith(IP, GOOGLEBOT);
  });

  it('«Skynet»: a fake Googlebot (DNS does not confirm) gets the challenge like everyone', async () => {
    enable('first-visit');
    crawler.verifySearchCrawler.mockResolvedValueOnce(false);
    const response = await uamGate(request('/', { ua: GOOGLEBOT }));
    expect(response?.status).toBe(200);
    expect(response?.headers.get('x-solco-gate')).toBe('challenge');
  });
});

describe('uamGate — hosts', () => {
  it('challenges on the trusted origins and on this Vercel deployment', async () => {
    enable('first-visit');
    vi.stubEnv('BETTER_AUTH_TRUSTED_ORIGINS', 'https://solco.example, https://*.example.org');
    vi.stubEnv('VERCEL_URL', 'solcomusic-abc123-team.vercel.app');
    vi.stubEnv('VERCEL_BRANCH_URL', 'solcomusic-git-preview-team.vercel.app');
    for (const origin of [
      'https://solcomusic.vercel.app',
      'https://solco.example',
      'https://solcomusic-abc123-team.vercel.app',
      'https://solcomusic-git-preview-team.vercel.app',
    ]) {
      const response = await uamGate(request('/', { origin }));
      expect(response?.headers.get('x-solco-gate'), origin).toBe('challenge');
    }
    // Wildcards are ignored, as sameOrigin ignores them.
    expect(await uamGate(request('/', { origin: 'https://a.example.org' }))).toBeNull();
  });

  it('defaults to http://localhost:3000 when NEXT_PUBLIC_APP_URL is unset', async () => {
    enable('first-visit');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    expect(await uamGate(request('/'))).toBeNull();
    const local = await uamGate(request('/', { origin: 'http://localhost:3000' }));
    expect(local?.headers.get('x-solco-gate')).toBe('challenge');
  });
});

describe('uamGate — host non protetti in modalità attacco', () => {
  const STATUS = 'https://status.solcomusic.online';

  it.each([
    ['/', 'https://solcomusic.vercel.app/'],
    ['/stato', 'https://solcomusic.vercel.app/stato'],
    ['/albums/abc?x=1&y=%C3%A8', 'https://solcomusic.vercel.app/albums/abc?x=1&y=%C3%A8'],
    // Un percorso che inizia con // resta un percorso dell'origine canonica (nessun open redirect).
    ['//evil.example/x', 'https://solcomusic.vercel.app//evil.example/x'],
  ])('rimanda %s allo stesso percorso sull’origine canonica (308)', async (path, location) => {
    enable('attack');
    for (const method of ['GET', 'HEAD']) {
      const response = await uamGate(request(path, { origin: STATUS, method }));
      expect(response?.status, method).toBe(308);
      expect(response?.headers.get('location'), method).toBe(location);
      expect(new URL(response?.headers.get('location') ?? '').host).toBe('solcomusic.vercel.app');
      expect(response?.headers.get('cache-control')).toBe('no-store, private');
      expect(response?.headers.get('x-solco-gate')).toBe('redirect');
      expect(response?.headers.get('set-cookie')).toBeNull();
    }
    expect(page.renderUamPage).not.toHaveBeenCalled();
  });

  it('rimanda anche con una clearance o con lo UA di un bot (là il gate decide)', async () => {
    enable('attack');
    const cookie = await issueClearance(await clientCtx(), 'attack');
    const withCookie = await uamGate(
      request('/', { origin: STATUS, headers: { cookie: `${UAM_COOKIE}=${cookie}` } }),
    );
    expect(withCookie?.status).toBe(308);
    const bot = await uamGate(request('/', { origin: STATUS, ua: 'WhatsApp/2.23.20.0 A' }));
    expect(bot?.status).toBe(308);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('risponde 405 a %s', async (method) => {
    enable('attack');
    const response = await uamGate(request('/', { origin: STATUS, method }));
    expect(response?.status).toBe(405);
    expect(response?.body).toBeNull();
    expect(response?.headers.get('allow')).toBe('GET, HEAD');
    expect(response?.headers.get('location')).toBeNull();
  });

  it('non tocca i percorsi esclusi dal gate (API, /health, immagini di anteprima)', async () => {
    enable('attack');
    for (const path of ['/api/music/radio', '/health', '/search/anteprima.jpg?t=x', '/sw.js']) {
      expect(await uamGate(request(path, { origin: STATUS })), path).toBeNull();
    }
  });

  it.each([
    ['', 'NEXT_PUBLIC_APP_URL assente'],
    ['http://solcomusic.example', 'origine non https'],
    ['https://*.example.org', 'wildcard'],
    ['https://user:pw@solco.example', 'credenziali'],
    ['garbage', 'valore non valido'],
  ])('senza origine canonica https lascia passare (%s: %s)', async (appUrl) => {
    enable('attack');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', appUrl);
    expect(await uamGate(request('/', { origin: STATUS }))).toBeNull();
    expect(await uamGate(request('/', { origin: STATUS, method: 'POST' }))).toBeNull();
  });

  it('in modalità first-visit lascia passare (comportamento invariato)', async () => {
    enable('first-visit');
    expect(await uamGate(request('/stato', { origin: STATUS }))).toBeNull();
    expect(await uamGate(request('/', { origin: STATUS, method: 'POST' }))).toBeNull();
  });
});

describe('uamGate — navigazioni client (RSC) in modalità attacco', () => {
  async function oldCookie(hoursAgo = 2, issuedIn: 'attack' | 'first-visit' = 'attack') {
    const ctx = await clientCtx();
    return issueClearance({ ...ctx, now: Date.now() - hoursAgo * 3600_000 }, issuedIn);
  }

  it.each([
    ['RSC: 1', { rsc: '1' }],
    ['prefetch RSC', { rsc: '1', 'next-router-prefetch': '1' }],
    ['RSC con Sec-Fetch-Dest: empty', { rsc: '1', 'sec-fetch-dest': 'empty' }],
  ])('accetta una clearance di attacco più vecchia di 1 h per %s', async (_label, headers) => {
    enable('attack');
    const cookie = await oldCookie();
    const response = await uamGate(
      request('/music?_rsc=abc', { headers: { ...headers, cookie: `${UAM_COOKIE}=${cookie}` } }),
    );
    expect(response).toBeNull();
  });

  it('accetta una clearance di attacco di 23 h per una richiesta RSC, non una di 25 h', async () => {
    enable('attack');
    for (const [hoursAgo, passes] of [
      [23, true],
      [25, false],
    ] as const) {
      const cookie = await oldCookie(hoursAgo);
      const response = await uamGate(
        request('/music?_rsc=abc', { headers: { rsc: '1', cookie: `${UAM_COOKIE}=${cookie}` } }),
      );
      if (passes) expect(response, `${hoursAgo} h`).toBeNull();
      else expect(response?.status, `${hoursAgo} h`).toBe(503);
    }
  });

  it.each([
    ['nessun header', {}],
    ['Sec-Fetch-Dest: document', { 'sec-fetch-dest': 'document' }],
    // Sec-Fetch-Dest lo sceglie il client: con "empty" (o iframe, …) riceverebbe l'HTML completo.
    ['Sec-Fetch-Dest: empty', { 'sec-fetch-dest': 'empty' }],
    ['Sec-Fetch-Dest: iframe', { 'sec-fetch-dest': 'iframe' }],
    ['Sec-Fetch-Dest: image', { 'sec-fetch-dest': 'image' }],
    ['RSC: 0', { rsc: '0' }],
  ])('per una navigazione di documento (%s) resta la regola di 1 h', async (_label, headers) => {
    enable('attack');
    const cookie = await oldCookie();
    const response = await uamGate(
      request('/music', { headers: { ...headers, cookie: `${UAM_COOKIE}=${cookie}` } }),
    );
    expect(response?.status).toBe(503);
    expect(response?.headers.get('x-solco-gate')).toBe('challenge');
  });

  it('una vecchia clearance di first-visit non basta per una richiesta RSC', async () => {
    enable('attack');
    for (const hoursAgo of [2, 29 * 24]) {
      const cookie = await oldCookie(hoursAgo, 'first-visit');
      const variants: Record<string, string>[] = [{ rsc: '1' }, { 'sec-fetch-dest': 'empty' }, {}];
      for (const headers of variants) {
        const response = await uamGate(
          request('/', { headers: { ...headers, cookie: `${UAM_COOKIE}=${cookie}` } }),
        );
        expect(response?.status, `${hoursAgo} h ${JSON.stringify(headers)}`).toBe(503);
      }
    }
  });

  it('una clearance di first-visit recente (meno di 1 h) vale anche per RSC', async () => {
    enable('attack');
    const cookie = await oldCookie(0.5, 'first-visit');
    const response = await uamGate(
      request('/music?_rsc=abc', { headers: { rsc: '1', cookie: `${UAM_COOKIE}=${cookie}` } }),
    );
    expect(response).toBeNull();
  });

  it('senza clearance valida una richiesta RSC riceve ancora la schermata', async () => {
    enable('attack');
    const ctx = await clientCtx();
    const expired = await issueClearance({ ...ctx, now: Date.now() - 2 * 3600_000 }, 'attack', 60);
    const foreign = await issueClearance(await clientCtx('198.51.100.1'), 'attack');
    const fresh = await issueClearance(ctx, 'attack');
    const tampered = fresh.replace('.attack.', '.first-visit.');
    for (const cookie of [null, expired, foreign, tampered, 'garbage']) {
      const headers: Record<string, string> = { rsc: '1' };
      if (cookie) headers.cookie = `${UAM_COOKIE}=${cookie}`;
      const response = await uamGate(request('/music?_rsc=abc', { headers }));
      expect(response?.status, String(cookie)).toBe(503);
    }
  });

  it('in modalità first-visit nulla cambia: la clearance vale per 30 giorni', async () => {
    enable('first-visit');
    const ctx = await clientCtx();
    const old = await issueClearance({ ...ctx, now: Date.now() - 10 * 24 * 3600_000 }, 'attack');
    expect(
      await uamGate(request('/music', { headers: { cookie: `${UAM_COOKIE}=${old}` } })),
    ).toBeNull();
  });
});

describe('uamGate — bot delle anteprime in modalità attacco', () => {
  const WHATSAPP = 'WhatsApp/2.23.20.0 A';
  const FACEBOOK = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
  const TELEGRAM = 'TelegramBot (like TwitterBot)';

  it.each([WHATSAPP, FACEBOOK, TELEGRAM])(
    'risponde 200 con la paginetta di meta tag a %s',
    async (ua) => {
      enable('attack');
      const response = await uamGate(request('/', { ua }));
      expect(response?.status).toBe(200);
      const headers = response?.headers;
      expect(headers?.get('x-solco-gate')).toBe('preview');
      expect(headers?.get('content-type')).toBe('text/html; charset=utf-8');
      expect(headers?.get('cache-control')).toBe('no-store, private');
      expect(headers?.get('content-security-policy')).toContain("default-src 'none'");
      expect(headers?.get('retry-after')).toBeNull();
      expect(headers?.get('set-cookie')).toBeNull();
      const html = (await response?.text()) ?? '';
      expect(html).toContain('<meta property="og:title" content="Solco">');
      expect(html).toContain(
        '<meta property="og:image" content="https://solcomusic.vercel.app/opengraph-image">',
      );
      expect(html).not.toContain('<script');
      expect(page.renderUamPage).not.toHaveBeenCalled();
    },
  );

  it('HEAD: stessi header, nessun corpo', async () => {
    enable('attack');
    const response = await uamGate(request('/', { ua: WHATSAPP, method: 'HEAD' }));
    expect(response?.status).toBe(200);
    expect(response?.headers.get('x-solco-gate')).toBe('preview');
    expect(response?.body).toBeNull();
  });

  it('POST da un bot di anteprima: 405 come per tutti', async () => {
    enable('attack');
    expect((await uamGate(request('/', { ua: WHATSAPP, method: 'POST' })))?.status).toBe(405);
  });

  it.each([
    GOOGLEBOT,
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)',
  ])('i crawler di ricerca (%s) ricevono ancora 503 + Retry-After', async (ua) => {
    enable('attack');
    const response = await uamGate(request('/', { ua }));
    expect(response?.status).toBe(503);
    expect(response?.headers.get('retry-after')).toBe('5');
    expect(response?.headers.get('x-solco-gate')).toBe('challenge');
  });

  it('«Skynet», first-visit: i bot delle anteprime ricevono la paginetta, mai l’app', async () => {
    enable('first-visit');
    for (const ua of [WHATSAPP, FACEBOOK, TELEGRAM]) {
      const response = await uamGate(request('/search?t=Brano', { ua }));
      expect(response?.status).toBe(200);
      expect(response?.headers.get('x-solco-gate')).toBe('preview');
      expect(await response?.text()).not.toContain('<script');
    }
    // Niente prova DNS per loro, e niente scrittura: solo GET e HEAD.
    expect(crawler.verifySearchCrawler).not.toHaveBeenCalled();
    const post = await uamGate(request('/search', { ua: WHATSAPP, method: 'POST' }));
    expect(post?.status).toBe(405);
  });

  it.each([
    'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0)',
  ])('«Skynet», first-visit: l’agente AI %s riceve la verifica, mai la pagina', async (ua) => {
    enable('first-visit');
    const response = await uamGate(request('/', { ua }));
    expect(response?.status).toBe(200);
    expect(response?.headers.get('x-solco-gate')).toBe('challenge');
  });

  it('«Skynet», first-visit: il verificatore di Search Console legge la pagina vera se è Google, sennò trova il meta nella verifica', async () => {
    enable('first-visit');
    vi.stubEnv('GOOGLE_SITE_VERIFICATION', 'token-search-console');
    const verifier = 'Mozilla/5.0 (compatible; Google-Site-Verification/1.0)';
    crawler.verifySearchCrawler.mockResolvedValueOnce(true);
    expect(await uamGate(request('/', { ua: verifier }))).toBeNull();
    crawler.verifySearchCrawler.mockResolvedValueOnce(false);
    const response = await uamGate(request('/', { ua: verifier }));
    expect(response?.headers.get('x-solco-gate')).toBe('challenge');
    expect(await response?.text()).toContain(
      '<meta name="google-site-verification" content="token-search-console">',
    );
  });

  it('«Skynet», modalità attacco: nessuna prova DNS, i motori ricevono il 503 e ripassano', async () => {
    enable('attack');
    const response = await uamGate(request('/', { ua: GOOGLEBOT }));
    expect(response?.status).toBe(503);
    expect(crawler.verifySearchCrawler).not.toHaveBeenCalled();
  });

  it('se la paginetta fallisce lascia passare (fail open)', async () => {
    enable('attack');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    preview.renderLinkPreviewPage.mockImplementationOnce(() => {
      throw new TypeError(`boom for ${IP}`);
    });
    expect(await uamGate(request('/', { ua: WHATSAPP }))).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect((error.mock.calls[0] ?? []).map(String).join(' ')).not.toContain(IP);
  });
});

describe('uamGate — interstitial', () => {
  it('serves the first-visit loading screen with status 200 and locked-down headers', async () => {
    enable('first-visit');
    const response = await uamGate(request('/music'));
    expect(response).not.toBeNull();
    if (!response) return;

    expect(response.status).toBe(200);
    expect(page.renderUamPage).toHaveBeenCalledTimes(1);
    const input = rendered();
    expect(input).toMatchObject({ difficulty: 14, mode: 'first-visit' });
    expect(input.nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(atob(input.nonce)).toHaveLength(16);

    const headers = response.headers;
    expect(headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(headers.get('cache-control')).toBe('no-store, private');
    expect(headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(headers.get('content-security-policy')).toBe(page.uamPageCsp(input.nonce));
    expect(headers.get('referrer-policy')).toBe('same-origin');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('x-frame-options')).toBe('DENY');
    expect(headers.get('x-solco-gate')).toBe('challenge');
    expect(headers.get('retry-after')).toBeNull();
    expect(headers.get('set-cookie')).toBeNull();

    // The real page: its one script carries the nonce the CSP allows, and its
    // data block carries the challenge the gate issued.
    expect(headers.get('content-security-policy')).toContain(`script-src 'nonce-${input.nonce}'`);
    const html = await response.text();
    expect(html).toBe(page.renderUamPage.mock.results[0]?.value);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(`<script nonce="${input.nonce}">`);
    const data = /<script type="application\/json" id="uam-data">([\s\S]*?)<\/script>/.exec(html);
    expect(JSON.parse(data?.[1] ?? 'null')).toEqual({
      challenge: input.challenge,
      difficulty: 14,
      mode: 'first-visit',
    });
  });

  it('binds the challenge to the client and uses x-real-ip only', async () => {
    enable('first-visit');
    await uamGate(
      request('/', {
        headers: { 'x-forwarded-for': '198.51.100.1', 'cf-connecting-ip': '192.0.2.1' },
      }),
    );
    const { challenge } = rendered();
    expect((await verifyChallenge(challenge, await clientCtx())).ok).toBe(true);
    expect((await verifyChallenge(challenge, await clientCtx('198.51.100.1'))).ok).toBe(false);
    expect((await verifyChallenge(challenge, await clientCtx(IP, `${UA} other`))).ok).toBe(false);
  });

  it('issues a fresh nonce and challenge on every request', async () => {
    enable('first-visit');
    await uamGate(request());
    await uamGate(request());
    const [first, second] = [rendered(0), rendered(1)];
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.challenge).not.toBe(second.challenge);
  });

  it('serves 503 + Retry-After: 5 at 18 bits in attack mode', async () => {
    enable('attack');
    const response = await uamGate(request());
    expect(response?.status).toBe(503);
    expect(response?.headers.get('retry-after')).toBe('5');
    expect(response?.headers.get('x-solco-gate')).toBe('challenge');
    expect(rendered()).toMatchObject({ difficulty: 18, mode: 'attack' });
  });

  it('honours the UAM_DIFFICULTY override', async () => {
    enable('attack', '9');
    await uamGate(request());
    expect(rendered().difficulty).toBe(9);
  });

  it('challenges Googlebot in attack mode (the UA is self-declared)', async () => {
    enable('attack');
    expect((await uamGate(request('/', { ua: GOOGLEBOT })))?.status).toBe(503);
  });

  it('answers HEAD with the interstitial status and headers but no body', async () => {
    enable('first-visit');
    const response = await uamGate(request('/', { method: 'HEAD' }));
    expect(response?.status).toBe(200);
    expect(response?.headers.get('x-solco-gate')).toBe('challenge');
    expect(response?.body).toBeNull();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
    'refuses %s without clearance with a bodyless 405 (Next would render the page)',
    async (method) => {
      enable('attack');
      const response = await uamGate(request('/music', { method }));
      expect(response?.status).toBe(405);
      expect(response?.body).toBeNull();
      expect(response?.headers.get('allow')).toBe('GET, HEAD');
      expect(response?.headers.get('cache-control')).toBe('no-store, private');
      expect(response?.headers.get('x-solco-gate')).toBe('challenge');
      expect(response?.headers.get('set-cookie')).toBeNull();
      expect(page.renderUamPage).not.toHaveBeenCalled();
    },
  );

  it('refuses POST in first-visit mode too, also with a cookie from another network', async () => {
    enable('first-visit');
    const cookie = await issueClearance(await clientCtx('198.51.100.1'), 'first-visit');
    const response = await uamGate(
      request('/', { method: 'POST', headers: { cookie: `${UAM_COOKIE}=${cookie}` } }),
    );
    expect(response?.status).toBe(405);
  });

  it('challenges RSC and prefetch requests without clearance (no exemption)', async () => {
    enable('first-visit');
    const rsc = await uamGate(
      request('/music?_rsc=abc', {
        headers: { rsc: '1', 'next-router-prefetch': '1', purpose: 'prefetch' },
      }),
    );
    expect(rsc?.headers.get('x-solco-gate')).toBe('challenge');
  });

  it('challenges a cookie bound to another network', async () => {
    enable('first-visit');
    const cookie = await issueClearance(await clientCtx('198.51.100.1'), 'first-visit');
    const response = await uamGate(
      request('/', {
        headers: { cookie: `${UAM_COOKIE}=${cookie}`, 'x-forwarded-for': '198.51.100.1' },
      }),
    );
    expect(response?.headers.get('x-solco-gate')).toBe('challenge');
  });

  it('challenges a tampered cookie', async () => {
    enable('first-visit');
    const cookie = await issueClearance(await clientCtx(), 'first-visit');
    const tampered = cookie.replace('.first-visit.', '.attack.');
    const response = await uamGate(
      request('/', { headers: { cookie: `${UAM_COOKIE}=${tampered}` } }),
    );
    expect(response?.headers.get('x-solco-gate')).toBe('challenge');
  });

  it('in attack mode challenges a clearance older than 1 h and accepts a fresh one', async () => {
    enable('attack');
    const ctx = await clientCtx();
    const stale = await issueClearance({ ...ctx, now: Date.now() - 2 * 3600_000 }, 'first-visit');
    const staleResponse = await uamGate(
      request('/', { headers: { cookie: `${UAM_COOKIE}=${stale}` } }),
    );
    expect(staleResponse?.status).toBe(503);

    const fresh = await issueClearance({ ...ctx, now: Date.now() - 60_000 }, 'first-visit');
    expect(
      await uamGate(request('/', { headers: { cookie: `${UAM_COOKIE}=${fresh}` } })),
    ).toBeNull();
  });
});

describe('uamGate — fails open', () => {
  it('returns null and logs a short message without IP or UA when anything throws', async () => {
    enable('attack');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    page.renderUamPage.mockImplementationOnce(() => {
      throw new TypeError(`boom for ${IP} ${UA}`);
    });
    expect(await uamGate(request())).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    const logged = (error.mock.calls[0] ?? []).map(String).join(' ');
    expect(logged).toContain('[uam]');
    expect(logged).not.toContain(IP);
    expect(logged).not.toContain('203.0');
    expect(logged).not.toContain('iPhone');
  });

  it('returns null when Web Crypto is unavailable', async () => {
    enable('first-visit');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValueOnce(new Error('no crypto'));
    expect(await uamGate(request())).toBeNull();
  });
});
