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

import { uamGate } from '@/lib/security/uam-gate';
import * as uamPage from '@/lib/security/uam-page';

const page = {
  renderUamPage: vi.mocked(uamPage.renderUamPage),
  uamPageCsp: vi.mocked(uamPage.uamPageCsp),
};

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
  ])('lets requests to %s through (verify would refuse its origin)', async (origin) => {
    enable('attack');
    expect(await uamGate(request('/', { origin }))).toBeNull();
    expect(await uamGate(request('/', { origin, method: 'POST' }))).toBeNull();
    expect(page.renderUamPage).not.toHaveBeenCalled();
  });

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
  ])('lets the non-gateable path %s through', async (path) => {
    enable('attack');
    expect(await uamGate(request(path))).toBeNull();
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

  it('lets Googlebot through in first-visit mode', async () => {
    enable('first-visit');
    expect(await uamGate(request('/', { ua: GOOGLEBOT }))).toBeNull();
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
