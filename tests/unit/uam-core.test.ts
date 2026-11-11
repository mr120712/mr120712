// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  challengeTtlSeconds,
  hasLeadingZeroBits,
  ipPrefix,
  isAllowlistedBot,
  isGateablePath,
  issueChallenge,
  issueClearance,
  readUamConfig,
  type UamContext,
  uaHash,
  uamChallengeHosts,
  vercelDeploymentOrigins,
  verifyChallenge,
  verifyClearance,
  verifySolution,
} from '@/lib/security/uam';

const SECRET = 'test-secret-0123456789-abcdefghijkl'; // 35 chars
const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);

const ctx = (overrides: Partial<UamContext> = {}): UamContext => ({
  secret: SECRET,
  ipPrefix: '203.0',
  uaHash: '0123456789abcdef',
  now: T0,
  ...overrides,
});

function sha256(input: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(input, 'utf8').digest());
}

/** Brute-forces a valid (or, with `valid: false`, an invalid) solution. */
function solve(challenge: string, difficulty: number, valid = true): string {
  for (let n = 0; n < 10_000_000; n += 1) {
    if (hasLeadingZeroBits(sha256(`${challenge}:${n}`), difficulty) === valid) return String(n);
  }
  throw new Error('no solution found');
}

/** Flips one character of the signature (last dot-separated part). */
function tamperSignature(token: string): string {
  const index = token.length - 5;
  const replacement = token[index] === 'A' ? 'B' : 'A';
  return `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('readUamConfig', () => {
  it('is off by default and for unknown modes', () => {
    expect(readUamConfig({})).toEqual({ enabled: false, reason: 'off' });
    expect(readUamConfig({ UAM_MODE: 'banana', UAM_SECRET: SECRET })).toEqual({
      enabled: false,
      reason: 'off',
    });
    expect(readUamConfig({ UAM_MODE: 'off', UAM_SECRET: SECRET })).toEqual({
      enabled: false,
      reason: 'off',
    });
  });

  it('is disabled when the secret is missing or shorter than 32 chars', () => {
    expect(readUamConfig({ UAM_MODE: 'attack' })).toEqual({
      enabled: false,
      reason: 'weak_secret',
    });
    expect(readUamConfig({ UAM_MODE: 'attack', UAM_SECRET: 'x'.repeat(31) })).toEqual({
      enabled: false,
      reason: 'weak_secret',
    });
    expect(readUamConfig({ UAM_MODE: 'attack', UAM_SECRET: `  ${'x'.repeat(30)}  ` })).toEqual({
      enabled: false,
      reason: 'weak_secret',
    });
    expect(readUamConfig({ UAM_MODE: 'attack', UAM_SECRET: 'x'.repeat(32) }).enabled).toBe(true);
  });

  it('first-visit: 14 bits, 30-day clearance, allowlist on, status 200', () => {
    expect(readUamConfig({ UAM_MODE: 'first-visit', UAM_SECRET: SECRET })).toEqual({
      enabled: true,
      mode: 'first-visit',
      secret: SECRET,
      difficulty: 14,
      clearanceTtlSeconds: 30 * 24 * 60 * 60,
      allowlistBots: true,
      interstitialStatus: 200,
    });
  });

  it('attack: 18 bits, allowlist off, status 503 (mode is trimmed and case-insensitive)', () => {
    expect(readUamConfig({ UAM_MODE: ' ATTACK ', UAM_SECRET: SECRET })).toMatchObject({
      enabled: true,
      mode: 'attack',
      difficulty: 18,
      allowlistBots: false,
      interstitialStatus: 503,
    });
  });

  it.each([
    ['16', 16],
    ['3', 8],
    ['-2', 8],
    ['40', 20],
    ['22', 20],
    ['20', 20],
    ['abc', 14],
    ['12.5', 14],
    ['', 14],
  ])('UAM_DIFFICULTY=%j → %i bits (clamped to [8, 20])', (raw, expected) => {
    const config = readUamConfig({
      UAM_MODE: 'first-visit',
      UAM_SECRET: SECRET,
      UAM_DIFFICULTY: raw,
    });
    expect(config.enabled && config.difficulty).toBe(expected);
  });

  it('reads process.env at call time', () => {
    vi.stubEnv('UAM_MODE', 'attack');
    vi.stubEnv('UAM_SECRET', SECRET);
    expect(readUamConfig().enabled).toBe(true);
    vi.stubEnv('UAM_MODE', 'off');
    expect(readUamConfig().enabled).toBe(false);
  });
});

describe('ipPrefix', () => {
  it.each([
    ['203.0.113.42', '203.0'],
    [' 10.1.2.3 ', '10.1'],
    ['010.001.2.3', '10.1'],
    ['2001:db8:85a3::8a2e:370:7334', '2001:db8:85a3'],
    ['2001:0DB8:0000:0000:0000:ff00:0042:8329', '2001:db8:0'],
    ['2001:db8::1', '2001:db8:0'],
    ['2001:db8:85a3:0:0:8a2e:1.2.3.4', '2001:db8:85a3'],
    ['::1', '0:0:0'],
    ['::', '0:0:0'],
    ['1:2:3:4:5:6:7::', '1:2:3'],
    ['fe80::1%eth0', 'fe80:0:0'],
    ['[2001:db8::1]', '2001:db8:0'],
    ['::ffff:192.0.2.128', '192.0'],
    ['::ffff:c000:280', '192.0'],
  ])('%s → %s', (ip, expected) => {
    expect(ipPrefix(ip)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    '',
    'unknown',
    '256.1.1.1',
    '1.2.3',
    '1.2.3.4:5678',
    '2001:db8:1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7::8',
    '2001:db8::1::2',
    'gggg::1',
    '12345::1',
    '::ffff:999.0.0.1',
    'x'.repeat(100),
  ])('%j → unknown', (ip) => {
    expect(ipPrefix(ip)).toBe('unknown');
  });
});

describe('uaHash', () => {
  it('is the first 16 hex chars of SHA-256(user-agent)', async () => {
    expect(await uaHash(null)).toBe('e3b0c44298fc1c14');
    expect(await uaHash(undefined)).toBe('e3b0c44298fc1c14');
    const ua = 'Mozilla/5.0 (iPhone) Safari/605.1.15';
    expect(await uaHash(ua)).toBe(createHash('sha256').update(ua).digest('hex').slice(0, 16));
    expect(await uaHash(ua)).not.toBe(await uaHash(`${ua} `));
  });
});

describe('hasLeadingZeroBits', () => {
  it('counts zero bits across byte boundaries', () => {
    expect(hasLeadingZeroBits(new Uint8Array([0x00, 0x0f]), 12)).toBe(true);
    expect(hasLeadingZeroBits(new Uint8Array([0x00, 0x0f]), 13)).toBe(false);
    expect(hasLeadingZeroBits(new Uint8Array([0x00, 0x00]), 16)).toBe(true);
    expect(hasLeadingZeroBits(new Uint8Array([0x7f]), 1)).toBe(true);
    expect(hasLeadingZeroBits(new Uint8Array([0x80]), 1)).toBe(false);
    expect(hasLeadingZeroBits(new Uint8Array([0x01]), 7)).toBe(true);
    expect(hasLeadingZeroBits(new Uint8Array([0x01]), 8)).toBe(false);
    expect(hasLeadingZeroBits(new Uint8Array([0xff]), 0)).toBe(true);
  });

  it('rejects impossible or malformed counts', () => {
    expect(hasLeadingZeroBits(new Uint8Array([0x00, 0x00]), 17)).toBe(false);
    expect(hasLeadingZeroBits(new Uint8Array([0x00]), -1)).toBe(false);
    expect(hasLeadingZeroBits(new Uint8Array([0x00]), 1.5)).toBe(false);
  });
});

describe('challenges', () => {
  it('has the c1.<ts>.<difficulty>.<salt>.<sig> shape with a random salt', async () => {
    const first = await issueChallenge(ctx(), 14);
    const second = await issueChallenge(ctx(), 14);
    expect(first).toMatch(/^c1\.\d+\.14\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(first.split('.')[1]).toBe(String(T0 / 1000));
    expect(first).not.toBe(second);
  });

  it('refuses to issue an out-of-range difficulty', async () => {
    await expect(issueChallenge(ctx(), 7)).rejects.toThrow(RangeError);
    await expect(issueChallenge(ctx(), 21)).rejects.toThrow(RangeError);
  });

  it('verifies for the same client within 120 s', async () => {
    const challenge = await issueChallenge(ctx(), 14);
    expect(await verifyChallenge(challenge, ctx())).toEqual({
      ok: true,
      issuedAt: T0 / 1000,
      difficulty: 14,
    });
    expect((await verifyChallenge(challenge, ctx({ now: T0 + 120_000 }))).ok).toBe(true);
  });

  it('expires after 120 s', async () => {
    const challenge = await issueChallenge(ctx(), 14);
    expect(await verifyChallenge(challenge, ctx({ now: T0 + 121_000 }))).toEqual({
      ok: false,
      error: 'expired',
    });
  });

  it.each([
    [8, 120],
    [14, 120],
    [18, 120],
    [19, 240],
    [20, 480],
    [21, 600],
    [30, 600],
  ])('gives a %i-bit challenge %i s (the window grows with the work)', (bits, seconds) => {
    expect(challengeTtlSeconds(bits)).toBe(seconds);
  });

  it.each([
    [18, 120],
    [19, 240],
    [20, 480],
  ])('expires a %i-bit challenge after %i s, not before', async (bits, seconds) => {
    const challenge = await issueChallenge(ctx(), bits);
    expect((await verifyChallenge(challenge, ctx({ now: T0 + seconds * 1000 }))).ok).toBe(true);
    expect(await verifyChallenge(challenge, ctx({ now: T0 + (seconds + 1) * 1000 }))).toEqual({
      ok: false,
      error: 'expired',
    });
  });

  it('rejects a challenge signed above the current maximum difficulty', async () => {
    const challenge = await issueChallenge(ctx(), 20);
    const forged = challenge.replace(/^c1\.(\d+)\.20\./, 'c1.$1.21.');
    expect(await verifyChallenge(forged, ctx())).toEqual({ ok: false, error: 'invalid' });
  });

  it('accepts 5 s of clock skew but not more', async () => {
    const challenge = await issueChallenge(ctx({ now: T0 + 5_000 }), 14);
    expect((await verifyChallenge(challenge, ctx())).ok).toBe(true);
    const future = await issueChallenge(ctx({ now: T0 + 6_000 }), 14);
    expect(await verifyChallenge(future, ctx())).toEqual({ ok: false, error: 'invalid' });
  });

  it('is invalid for another IP prefix, another UA or another secret', async () => {
    const challenge = await issueChallenge(ctx(), 14);
    const invalid = { ok: false, error: 'invalid' };
    expect(await verifyChallenge(challenge, ctx({ ipPrefix: '198.51' }))).toEqual(invalid);
    expect(await verifyChallenge(challenge, ctx({ uaHash: 'fedcba9876543210' }))).toEqual(invalid);
    expect(await verifyChallenge(challenge, ctx({ secret: `${SECRET}x` }))).toEqual(invalid);
  });

  it('detects tampering with the signature, the difficulty or the timestamp', async () => {
    const challenge = await issueChallenge(ctx(), 14);
    const [, ts, , salt, sig] = challenge.split('.');
    const invalid = { ok: false, error: 'invalid' };
    expect(await verifyChallenge(tamperSignature(challenge), ctx())).toEqual(invalid);
    expect(await verifyChallenge(`c1.${ts}.8.${salt}.${sig}`, ctx())).toEqual(invalid);
    expect(await verifyChallenge(`c1.${Number(ts) + 60}.14.${salt}.${sig}`, ctx())).toEqual(
      invalid,
    );
    // A forged, already-expired timestamp is still reported as invalid, not expired.
    expect(await verifyChallenge(`c1.${Number(ts) - 600}.14.${salt}.${sig}`, ctx())).toEqual(
      invalid,
    );
  });

  it.each([
    '',
    'c1',
    'c2.1.14.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'c1.1.140.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'c1.1.4.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'c1.1.14.AAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    `c1.1.14.${'A'.repeat(200)}`,
  ])('rejects malformed challenge %j', async (challenge) => {
    expect(await verifyChallenge(challenge, ctx())).toEqual({ ok: false, error: 'invalid' });
  });
});

describe('verifySolution', () => {
  it('accepts a real proof of work and rejects a wrong one', async () => {
    const challenge = await issueChallenge(ctx(), 8);
    expect(await verifySolution(challenge, solve(challenge, 8), 8)).toBe(true);
    expect(await verifySolution(challenge, solve(challenge, 8, false), 8)).toBe(false);
  });

  it('binds the solution to the exact challenge string', async () => {
    const challenge = await issueChallenge(ctx(), 8);
    const solution = solve(challenge, 12);
    expect(await verifySolution(challenge, solution, 12)).toBe(true);
    const other = await issueChallenge(ctx(), 8);
    expect(await verifySolution(other, solution, 12)).toBe(false);
  });

  it.each(['', 'abc', '12a', '-1', '1234567890123', ' 1'])(
    'rejects malformed solution %j',
    async (solution) => {
      const challenge = await issueChallenge(ctx(), 8);
      expect(await verifySolution(challenge, solution, 0)).toBe(false);
    },
  );
});

describe('clearance cookie', () => {
  it('has the v1.<iat>.<exp>.<mode>.<sig> shape', async () => {
    const cookie = await issueClearance(ctx(), 'first-visit');
    const iat = T0 / 1000;
    expect(cookie).toMatch(
      new RegExp(`^v1\\.${iat}\\.${iat + 30 * 24 * 3600}\\.first-visit\\.[A-Za-z0-9_-]{43}$`),
    );
    expect(await issueClearance(ctx(), 'attack', 60)).toMatch(
      new RegExp(`^v1\\.${iat}\\.${iat + 60}\\.attack\\.`),
    );
  });

  it('is valid for the same client until it expires', async () => {
    const cookie = await issueClearance(ctx(), 'first-visit');
    expect(await verifyClearance(cookie, ctx(), 'first-visit')).toBe(true);
    const almost = T0 + (30 * 24 * 3600 - 1) * 1000;
    expect(await verifyClearance(cookie, ctx({ now: almost }), 'first-visit')).toBe(true);
    const expired = T0 + 30 * 24 * 3600 * 1000;
    expect(await verifyClearance(cookie, ctx({ now: expired }), 'first-visit')).toBe(false);
  });

  it('is bound to the IP prefix, the UA hash and the secret', async () => {
    const cookie = await issueClearance(ctx(), 'first-visit');
    expect(await verifyClearance(cookie, ctx({ ipPrefix: '198.51' }), 'first-visit')).toBe(false);
    expect(await verifyClearance(cookie, ctx({ uaHash: 'fedcba9876543210' }), 'first-visit')).toBe(
      false,
    );
    expect(await verifyClearance(cookie, ctx({ secret: `${SECRET}x` }), 'first-visit')).toBe(false);
  });

  it('detects tampering with any field', async () => {
    const cookie = await issueClearance(ctx(), 'attack');
    const [, iat, exp, , sig] = cookie.split('.');
    expect(await verifyClearance(tamperSignature(cookie), ctx(), 'first-visit')).toBe(false);
    expect(
      await verifyClearance(`v1.${iat}.${Number(exp) + 999}.attack.${sig}`, ctx(), 'first-visit'),
    ).toBe(false);
    expect(
      await verifyClearance(`v1.${Number(iat) + 1}.${exp}.attack.${sig}`, ctx(), 'attack'),
    ).toBe(false);
    expect(await verifyClearance(`v1.${iat}.${exp}.first-visit.${sig}`, ctx(), 'first-visit')).toBe(
      false,
    );
  });

  it('in attack mode counts only if issued at most 1 h ago, whatever mode issued it', async () => {
    for (const issuedIn of ['first-visit', 'attack'] as const) {
      const cookie = await issueClearance(ctx(), issuedIn);
      expect(await verifyClearance(cookie, ctx({ now: T0 + 3600_000 }), 'attack')).toBe(true);
      expect(await verifyClearance(cookie, ctx({ now: T0 + 3601_000 }), 'attack')).toBe(false);
      expect(await verifyClearance(cookie, ctx({ now: T0 + 3601_000 }), 'first-visit')).toBe(true);
    }
  });

  it('rejects a clearance issued in the future', async () => {
    const cookie = await issueClearance(ctx({ now: T0 + 60_000 }), 'first-visit');
    expect(await verifyClearance(cookie, ctx(), 'first-visit')).toBe(false);
  });

  it.each([null, undefined, '', 'v1', 'v1.1.2.off.x', 'garbage', `v1.${'1'.repeat(300)}`])(
    'rejects malformed cookie %j',
    async (cookie) => {
      expect(await verifyClearance(cookie, ctx(), 'first-visit')).toBe(false);
    },
  );
});

describe('isAllowlistedBot', () => {
  it.each([
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (Linux; Android 6.0.1) Chrome/120 Mobile Safari/537.36 (compatible; Google-InspectionTool/1.0;)',
    'GoogleOther',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)',
    'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Twitterbot/1.0',
    'TelegramBot (like TwitterBot)',
    'WhatsApp/2.23.20.0 A',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0)',
  ])('allows %s', (ua) => {
    expect(isAllowlistedBot(ua)).toBe(true);
  });

  it.each([
    null,
    undefined,
    '',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
    'curl/8.5.0',
    'python-requests/2.32',
  ])('does not allow %j', (ua) => {
    expect(isAllowlistedBot(ua)).toBe(false);
  });
});

describe('isGateablePath', () => {
  it.each([
    '/',
    '/music',
    '/music/',
    '/albums/abc123',
    '/albums/x.y',
    '/generi/hip.hop',
    '/invito/abc123',
    '/apiary',
    '/healthy',
    '/music.rsc',
    '/index.rsc',
    '/ios',
  ])('gates %s', (pathname) => {
    expect(isGateablePath(pathname)).toBe(true);
  });

  it.each([
    '/api',
    '/api/',
    '/api/uam/verify',
    '/_next/static/chunks/app.js',
    '/_next/image',
    '/_next',
    '/_vercel/insights/script.js',
    '/health',
    '/health/',
    '/.well-known/assetlinks.json',
    '/favicon.ico',
    '/icon',
    '/icon.svg',
    '/icon1.png',
    '/apple-icon.png',
    '/manifest.webmanifest',
    '/robots.txt',
    '/sitemap.xml',
    '/llms.txt',
    '/opengraph-image',
    '/opengraph-image-1a2b3c',
    '/twitter-image',
    '/solco.apk',
    '/ios/solco.mobileconfig',
    '/fonts/inter/inter-latin-400.woff2',
    '/music-captions.vtt',
    '/LOGO.PNG',
    '/logo.png/',
  ])('does not gate %s', (pathname) => {
    expect(isGateablePath(pathname)).toBe(false);
  });
});

describe('hosts the gate may challenge on', () => {
  it('reads NEXT_PUBLIC_APP_URL, the exact trusted origins and the Vercel deployment hosts', () => {
    const hosts = uamChallengeHosts({
      NEXT_PUBLIC_APP_URL: 'https://solcomusic.vercel.app',
      BETTER_AUTH_TRUSTED_ORIGINS:
        ' https://Solco.example ,https://*.example.org,https://user:pw@evil.example,ftp://x.example,garbage',
      VERCEL_URL: 'solcomusic-abc123-team.vercel.app',
      VERCEL_BRANCH_URL: 'solcomusic-git-preview-team.vercel.app',
      VERCEL_PROJECT_PRODUCTION_URL: 'solcomusic.vercel.app',
    });
    expect([...hosts].sort()).toEqual([
      'solco.example',
      'solcomusic-abc123-team.vercel.app',
      'solcomusic-git-preview-team.vercel.app',
      'solcomusic.vercel.app',
    ]);
  });

  it('defaults NEXT_PUBLIC_APP_URL to http://localhost:3000 like src/lib/env.ts', () => {
    expect([...uamChallengeHosts({})]).toEqual(['localhost:3000']);
    expect([...uamChallengeHosts({ NEXT_PUBLIC_APP_URL: '  ' })]).toEqual(['localhost:3000']);
    expect([...uamChallengeHosts({ NEXT_PUBLIC_APP_URL: 'http://localhost:4000/x' })]).toEqual([
      'localhost:4000',
    ]);
  });

  it('turns the Vercel system env vars into exact https origins', () => {
    expect(
      vercelDeploymentOrigins({
        VERCEL_URL: 'solcomusic-abc123-team.vercel.app',
        VERCEL_BRANCH_URL: '',
        VERCEL_PROJECT_PRODUCTION_URL: 'solcomusic.vercel.app',
      }),
    ).toEqual(['https://solcomusic-abc123-team.vercel.app', 'https://solcomusic.vercel.app']);
    expect(vercelDeploymentOrigins({})).toEqual([]);
    expect(vercelDeploymentOrigins({ VERCEL_URL: '*.vercel.app' })).toEqual([]);
  });
});
