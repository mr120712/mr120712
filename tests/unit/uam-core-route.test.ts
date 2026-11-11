// @vitest-environment node
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hasLeadingZeroBits,
  ipPrefix,
  issueChallenge,
  UAM_COOKIE,
  type UamContext,
  uaHash,
  verifyClearance,
} from '@/lib/security/uam';

const mocks = vi.hoisted(() => ({ sameOrigin: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));

import { POST } from '@/app/api/uam/verify/route';
import { uamGate } from '@/lib/security/uam-gate';
import { uamPageCsp } from '@/lib/security/uam-page';

const SECRET = 'route-test-secret-0123456789-abcdefg';
const ORIGIN = 'https://solcomusic.vercel.app';
const IP = '2001:db8:85a3::8a2e:370:7334';
const UA = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36';

function enable(mode: 'first-visit' | 'attack', difficulty = '8') {
  vi.stubEnv('UAM_MODE', mode);
  vi.stubEnv('UAM_SECRET', SECRET);
  vi.stubEnv('UAM_DIFFICULTY', difficulty);
}

async function clientCtx(ip = IP, ua = UA): Promise<UamContext> {
  return { secret: SECRET, ipPrefix: ipPrefix(ip), uaHash: await uaHash(ua) };
}

function solve(challenge: string, difficulty: number, valid = true): string {
  for (let n = 0; n < 50_000_000; n += 1) {
    const digest = new Uint8Array(createHash('sha256').update(`${challenge}:${n}`).digest());
    if (hasLeadingZeroBits(digest, difficulty) === valid) return String(n);
  }
  throw new Error('no solution found');
}

function post(
  body: unknown,
  init: { ip?: string; ua?: string; url?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request(init.url ?? `${ORIGIN}/api/uam/verify`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'x-real-ip': init.ip ?? IP,
      'user-agent': init.ua ?? UA,
      'x-forwarded-proto': 'https',
      ...init.headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function solvedBody(difficulty = 8, ctx?: UamContext) {
  const challenge = await issueChallenge(ctx ?? (await clientCtx()), difficulty);
  return { challenge, solution: solve(challenge, difficulty) };
}

beforeEach(() => {
  mocks.sameOrigin.mockReset();
  mocks.sameOrigin.mockReturnValue(true);
  vi.stubEnv('UAM_MODE', '');
  vi.stubEnv('UAM_SECRET', '');
  vi.stubEnv('UAM_DIFFICULTY', '');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ORIGIN);
  vi.stubEnv('BETTER_AUTH_TRUSTED_ORIGINS', '');
  vi.stubEnv('VERCEL_URL', '');
  vi.stubEnv('VERCEL_BRANCH_URL', '');
  vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/uam/verify — refusals', () => {
  it('refuses a cross-origin request with 403 before reading the body', async () => {
    enable('first-visit');
    mocks.sameOrigin.mockReturnValue(false);
    const request = post(await solvedBody());
    const response = await POST(request);
    expect(response.status).toBe(403);
    expect(request.bodyUsed).toBe(false);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it("accepts this Vercel deployment's own origins on top of sameOrigin", async () => {
    enable('first-visit');
    mocks.sameOrigin.mockReturnValue(false);
    vi.stubEnv('VERCEL_URL', 'solcomusic-abc123-team.vercel.app');
    vi.stubEnv('VERCEL_BRANCH_URL', 'solcomusic-git-preview-team.vercel.app');
    for (const origin of [
      'https://solcomusic-abc123-team.vercel.app',
      'https://solcomusic-git-preview-team.vercel.app',
    ]) {
      const response = await POST(post(await solvedBody(), { headers: { origin } }));
      expect(response.status, origin).toBe(200);
    }
    for (const origin of ['https://evil.example', 'http://solcomusic-abc123-team.vercel.app']) {
      const response = await POST(post(await solvedBody(), { headers: { origin } }));
      expect(response.status, origin).toBe(403);
    }
  });

  it('answers 503 disabled when UAM is not configured', async () => {
    const response = await POST(post({ challenge: 'c1', solution: '1' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'disabled' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('answers 503 disabled when the secret is too short', async () => {
    vi.stubEnv('UAM_MODE', 'attack');
    vi.stubEnv('UAM_SECRET', 'short');
    expect((await POST(post({ challenge: 'c1', solution: '1' }))).status).toBe(503);
  });

  it('answers 413 for a body over 1 KB', async () => {
    enable('first-visit');
    const response = await POST(post({ challenge: 'x'.repeat(1100), solution: '1' }));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'payload_too_large' });
  });

  it('answers 400 for malformed JSON', async () => {
    enable('first-visit');
    const response = await POST(post('{not json'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_json' });
  });

  it.each([
    {},
    { challenge: 'c1.1.8.a.b' },
    { challenge: 'c1.1.8.a.b', solution: 'abc' },
    { challenge: 'c1.1.8.a.b', solution: '1234567890123' },
    { challenge: 'c1.1.8.a.b', solution: 42 },
    { challenge: 'x'.repeat(201), solution: '1' },
  ])('answers 400 bad_request for %j', async (body) => {
    enable('first-visit');
    const response = await POST(post(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'bad_request' });
  });

  it('answers 400 invalid for a tampered challenge', async () => {
    enable('first-visit');
    const { challenge, solution } = await solvedBody();
    const tampered = challenge.replace(/\.8\./, '.9.');
    const response = await POST(post({ challenge: tampered, solution }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid' });
  });

  it('answers 400 invalid for a challenge issued to another network or browser', async () => {
    enable('first-visit');
    const body = await solvedBody(8, await clientCtx('198.51.100.7'));
    expect(await (await POST(post(body))).json()).toEqual({ error: 'invalid' });
    const otherUa = await solvedBody(8, await clientCtx(IP, 'curl/8.5.0'));
    expect(await (await POST(post(otherUa))).json()).toEqual({ error: 'invalid' });
  });

  it('ignores x-forwarded-for when binding the challenge', async () => {
    enable('first-visit');
    const body = await solvedBody(8, await clientCtx('198.51.100.7'));
    const response = await POST(post(body, { headers: { 'x-forwarded-for': '198.51.100.7' } }));
    expect(await response.json()).toEqual({ error: 'invalid' });
  });

  it('gives a 20-bit challenge 480 s instead of 120 s', async () => {
    enable('attack', '20');
    const ctx = await clientCtx();
    const late = await issueChallenge({ ...ctx, now: Date.now() - 300_000 }, 20);
    // Not solved: the age check passes, so the answer is about the solution.
    expect(await (await POST(post({ challenge: late, solution: '1' }))).json()).toEqual({
      error: 'wrong_solution',
    });
    const stale = await issueChallenge({ ...ctx, now: Date.now() - 481_000 }, 20);
    expect(await (await POST(post({ challenge: stale, solution: '1' }))).json()).toEqual({
      error: 'expired',
    });
  });

  it('answers 400 expired for a challenge older than 120 s', async () => {
    enable('first-visit');
    const body = await solvedBody(8, { ...(await clientCtx()), now: Date.now() - 121_000 });
    const response = await POST(post(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'expired' });
  });

  it('answers 400 expired for a challenge easier than the current difficulty', async () => {
    enable('attack', '10');
    const response = await POST(post(await solvedBody(8)));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'expired' });
  });

  it('answers 400 wrong_solution for a solution without enough zero bits', async () => {
    enable('first-visit');
    const challenge = await issueChallenge(await clientCtx(), 8);
    const response = await POST(post({ challenge, solution: solve(challenge, 8, false) }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'wrong_solution' });
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('POST /api/uam/verify — success', () => {
  it('answers 200 and sets an HttpOnly, Lax, Secure clearance cookie for 30 days', async () => {
    enable('first-visit');
    const response = await POST(post(await solvedBody()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('cache-control')).toBe('no-store');

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(new RegExp(`^${UAM_COOKIE}=v1\\.\\d+\\.\\d+\\.first-visit\\.`));
    expect(setCookie).toMatch(/;\s*HttpOnly/i);
    expect(setCookie).toMatch(/;\s*SameSite=lax/i);
    expect(setCookie).toMatch(/;\s*Path=\//);
    expect(setCookie).toMatch(/;\s*Secure/i);
    expect(setCookie).toMatch(/;\s*Max-Age=2592000/);
    expect(setCookie).not.toContain('2001');
    expect(setCookie).not.toContain('85a3');
  });

  it('binds the cookie to the client and to the current mode', async () => {
    enable('attack');
    const response = await POST(post(await solvedBody()));
    const value = response.cookies.get(UAM_COOKIE)?.value ?? '';
    expect(value).toMatch(/^v1\.\d+\.\d+\.attack\./);
    expect(await verifyClearance(value, await clientCtx(), 'attack')).toBe(true);
    expect(await verifyClearance(value, await clientCtx('198.51.100.7'), 'attack')).toBe(false);
  });

  it('omits Secure on plain http (local dev)', async () => {
    enable('first-visit');
    const response = await POST(
      post(await solvedBody(), {
        url: 'http://localhost:3000/api/uam/verify',
        headers: { 'x-forwarded-proto': 'http' },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie') ?? '').not.toMatch(/;\s*Secure/i);
  });

  it('sets Secure from x-forwarded-proto behind a proxy with an internal http URL', async () => {
    enable('first-visit');
    const response = await POST(
      post(await solvedBody(), { url: 'http://10.0.0.12:3000/api/uam/verify' }),
    );
    expect(response.headers.get('set-cookie') ?? '').toMatch(/;\s*Secure/i);
  });
});

describe('UAM end to end: gate → loading screen → proof of work → verify → gate', () => {
  it.each(['first-visit', 'attack'] as const)(
    'lets the visitor in after solving (%s)',
    async (mode) => {
      enable(mode, '10');
      const headers = { 'x-real-ip': IP, 'user-agent': UA };

      // 1. First navigation: the gate answers with the loading screen.
      const gated = await uamGate(new NextRequest(`${ORIGIN}/albums/abc`, { headers }));
      expect(gated?.headers.get('x-solco-gate')).toBe('challenge');
      expect(gated?.status).toBe(mode === 'attack' ? 503 : 200);
      const html = (await gated?.text()) ?? '';

      // 2. The real loading screen: its solver runs under the gate's CSP nonce
      //    and the page embeds the challenge as JSON in #uam-data.
      const nonce = /<script nonce="([^"]+)">/.exec(html)?.[1] ?? '';
      expect(gated?.headers.get('content-security-policy')).toBe(uamPageCsp(nonce));
      const data = /<script[^>]*id="uam-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
      expect(data).toBeTruthy();
      const { challenge, difficulty } = JSON.parse(data ?? '{}') as {
        challenge: string;
        difficulty: number;
      };
      expect(difficulty).toBe(10);

      // 3. The browser brute-forces the proof of work and posts it.
      const verified = await POST(post({ challenge, solution: solve(challenge, difficulty) }));
      expect(verified.status).toBe(200);
      const cookie = verified.cookies.get(UAM_COOKIE)?.value;
      expect(cookie).toBeTruthy();

      // 4. The reload carries the cookie and passes the gate.
      const cleared = await uamGate(
        new NextRequest(`${ORIGIN}/albums/abc`, {
          headers: { ...headers, cookie: `${UAM_COOKIE}=${cookie}` },
        }),
      );
      expect(cleared).toBeNull();

      // The same cookie from another network is challenged again.
      const elsewhere = await uamGate(
        new NextRequest(`${ORIGIN}/albums/abc`, {
          headers: { ...headers, 'x-real-ip': '198.51.100.7', cookie: `${UAM_COOKIE}=${cookie}` },
        }),
      );
      expect(elsewhere?.headers.get('x-solco-gate')).toBe('challenge');
    },
  );
});

// ---------------------------------------------------------------------------
// The page's own inline solver (not the test's brute force) against the real
// verify route: same proof of work, same request body.
// ---------------------------------------------------------------------------

/** The few DOM bits the inline solver touches, backed by the gate's HTML. */
function solverDocument(html: string) {
  const element = (textContent = '') => ({
    textContent,
    style: {} as Record<string, string>,
    attributes: {} as Record<string, string>,
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    },
    focus() {},
    addEventListener() {},
  });
  const data = /<script type="application\/json" id="uam-data">([\s\S]*?)<\/script>/.exec(
    html,
  )?.[1];
  const elements: Record<string, ReturnType<typeof element>> = {
    'uam-data': element(data ?? ''),
    'uam-title': element(),
    'uam-status': element(),
    'uam-progress': element(),
    'uam-fill': element(),
    'uam-retry': element(),
  };
  return {
    documentElement: element(),
    getElementById: (id: string) => elements[id] ?? null,
    elements,
  };
}

describe('UAM end to end with the inline solver of the loading screen', () => {
  it('solves the challenge, gets the cookie from verify and passes the gate', async () => {
    enable('first-visit', '10');
    const headers = { 'x-real-ip': IP, 'user-agent': UA };

    const gated = await uamGate(new NextRequest(`${ORIGIN}/`, { headers }));
    const html = (await gated?.text()) ?? '';
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script).toBeTruthy();

    const doc = solverDocument(html);
    const responses: Response[] = [];
    // The browser's same-origin fetch: relative URL, plus the headers the
    // browser and Vercel add (Origin, x-real-ip, User-Agent, https).
    const fetchToRoute = vi.fn(async (path: string, init: RequestInit) => {
      const response = await POST(
        new Request(`${ORIGIN}${path}`, {
          method: init.method,
          body: init.body,
          signal: init.signal,
          headers: {
            ...(init.headers as Record<string, string>),
            origin: ORIGIN,
            'x-real-ip': IP,
            'user-agent': UA,
            'x-forwarded-proto': 'https',
          },
        }),
      );
      responses.push(response);
      return response;
    });
    const location = { reload: vi.fn() };
    const run = new Function(
      'document',
      'fetch',
      'location',
      'sessionStorage',
      'navigator',
      script ?? '',
    );
    run(doc, fetchToRoute, location, null, { cookieEnabled: true });

    await vi.waitFor(() => expect(location.reload).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(fetchToRoute).toHaveBeenCalledTimes(1);
    expect(responses[0]?.status).toBe(200);
    expect(doc.elements['uam-status']?.textContent).toBe('Fatto! Entriamo…');

    const cookie = responses[0]?.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(cookie.startsWith(`${UAM_COOKIE}=v1.`)).toBe(true);
    expect(
      await uamGate(new NextRequest(`${ORIGIN}/`, { headers: { ...headers, cookie } })),
    ).toBeNull();
  }, 20_000);
});
