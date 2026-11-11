// @polsia:user-owned
//
// Solco "Under Attack Mode" (UAM) — pure primitives shared by the proxy gate
// (src/lib/security/uam-gate.ts) and the verify route (src/app/api/uam/verify).
//
// Runs inside the proxy bundle: NO 'server-only', NO Node-only APIs. Hashing and
// HMAC use Web Crypto (globalThis.crypto.subtle), available in the proxy, route
// handlers and Vitest. Every function takes an injectable `now` (epoch ms) so the
// tests can move the clock.
//
// Privacy: the client IP never leaves this module in clear. It is reduced to a
// network prefix (IPv4 /16, IPv6 /48) and, like the User-Agent hash, only ever
// used as an HMAC input — never written to a cookie, a challenge or a log line.

/** Configured mode. Anything that is not a known value reads as 'off'. */
export type UamMode = 'off' | 'first-visit' | 'attack';
/** A mode in which the gate actually challenges visitors. */
export type ActiveUamMode = Exclude<UamMode, 'off'>;

export type UamConfig =
  | { enabled: false; reason: 'off' | 'weak_secret' }
  | {
      enabled: true;
      mode: ActiveUamMode;
      secret: string;
      /** Proof-of-work difficulty in leading zero bits. */
      difficulty: number;
      /** Max-Age of the clearance cookie. */
      clearanceTtlSeconds: number;
      /** Search crawlers and link-preview bots skip the challenge. */
      allowlistBots: boolean;
      /** HTTP status of the interstitial (503 + Retry-After in attack mode). */
      interstitialStatus: 200 | 503;
    };

/** Inputs every signature is bound to. `now` is epoch milliseconds (default Date.now()). */
export interface UamContext {
  secret: string;
  ipPrefix: string;
  uaHash: string;
  now?: number;
}

export type ChallengeCheck =
  | { ok: true; issuedAt: number; difficulty: number }
  | { ok: false; error: 'invalid' | 'expired' };

export const UAM_COOKIE = 'solco_uam';
export const UAM_MIN_SECRET_LENGTH = 32;
export const UAM_MIN_DIFFICULTY = 8;
/**
 * Upper clamp of UAM_DIFFICULTY. Phones hash several times slower than a server
 * core (~49k SHA-256/s with the solver's batching): above 20 bits the mean solve
 * takes minutes on mobile, so higher values would lock mobile visitors out.
 */
export const UAM_MAX_DIFFICULTY = 20;
export const UAM_DIFFICULTY_BY_MODE: Readonly<Record<ActiveUamMode, number>> = {
  'first-visit': 14,
  attack: 18,
};
/** Clearance lifetime (both modes); attack mode additionally requires a fresh one. */
export const UAM_CLEARANCE_TTL_SECONDS = 30 * 24 * 60 * 60;
/** In attack mode a clearance counts only if it was issued at most this long ago. */
export const UAM_ATTACK_MAX_CLEARANCE_AGE_SECONDS = 60 * 60;
/** Lifetime of a challenge of up to 18 bits (see challengeTtlSeconds). */
export const UAM_CHALLENGE_TTL_SECONDS = 120;
/** Ceiling of the scaled challenge lifetime. */
export const UAM_MAX_CHALLENGE_TTL_SECONDS = 600;
/** From this difficulty up, every extra bit doubles the challenge lifetime. */
const TTL_SCALING_FROM_DIFFICULTY = 18;
/** Tolerated clock skew for timestamps issued "in the future". */
export const UAM_CLOCK_SKEW_SECONDS = 5;

const CHALLENGE_PATTERN = /^c1\.(\d{1,12})\.(\d{1,2})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const CLEARANCE_PATTERN = /^v1\.(\d{1,12})\.(\d{1,12})\.(first-visit|attack)\.([A-Za-z0-9_-]{43})$/;
const SOLUTION_PATTERN = /^\d{1,12}$/;
const MAX_TOKEN_LENGTH = 200;
const MAX_UA_LENGTH = 1024;

type EnvLike = Record<string, string | undefined>;

/**
 * Reads the UAM settings from the environment on every call (never cached at
 * module load). Disabled unless UAM_MODE is 'first-visit' or 'attack' AND
 * UAM_SECRET has at least 32 characters. Never throws.
 */
export function readUamConfig(env: EnvLike = process.env): UamConfig {
  const rawMode = (env.UAM_MODE ?? '').trim().toLowerCase();
  if (rawMode !== 'first-visit' && rawMode !== 'attack') {
    return { enabled: false, reason: 'off' };
  }
  const mode: ActiveUamMode = rawMode;

  const secret = env.UAM_SECRET ?? '';
  if (secret.trim().length < UAM_MIN_SECRET_LENGTH) {
    return { enabled: false, reason: 'weak_secret' };
  }

  let difficulty = UAM_DIFFICULTY_BY_MODE[mode];
  const rawDifficulty = (env.UAM_DIFFICULTY ?? '').trim();
  if (/^-?\d{1,6}$/.test(rawDifficulty)) {
    difficulty = Math.min(
      UAM_MAX_DIFFICULTY,
      Math.max(UAM_MIN_DIFFICULTY, Number.parseInt(rawDifficulty, 10)),
    );
  }

  return {
    enabled: true,
    mode,
    secret,
    difficulty,
    clearanceTtlSeconds: UAM_CLEARANCE_TTL_SECONDS,
    allowlistBots: mode === 'first-visit',
    interstitialStatus: mode === 'attack' ? 503 : 200,
  };
}

// ---------------------------------------------------------------------------
// Client identity
// ---------------------------------------------------------------------------

type Ipv4 = [number, number, number, number];

function parseIpv4(value: string): Ipv4 | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return null;
  const octets: Ipv4 = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** Expands an IPv6 address (with optional "::" and trailing dotted IPv4) into 8 hextets. */
function parseIpv6(value: string): number[] | null {
  let address = value;
  // An embedded IPv4 tail (::ffff:1.2.3.4) is two hextets.
  const lastColon = address.lastIndexOf(':');
  if (address.slice(lastColon + 1).includes('.')) {
    const v4 = parseIpv4(address.slice(lastColon + 1));
    if (!v4) return null;
    const high = ((v4[0] << 8) | v4[1]).toString(16);
    const low = ((v4[2] << 8) | v4[3]).toString(16);
    address = `${address.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = parseGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
  const groups = [...head, ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null;

  let hextets: string[];
  if (halves.length === 2) {
    const missing = 8 - groups.length;
    if (missing < 1) return null;
    hextets = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    if (groups.length !== 8) return null;
    hextets = groups;
  }
  return hextets.map((group) => Number.parseInt(group, 16));
}

/**
 * Network prefix of the client IP: IPv4 → /16 ("a.b"), IPv6 → /48 (first three
 * hextets, lowercase, no leading zeros; IPv4-mapped addresses use the IPv4 rule).
 * Missing or malformed → "unknown". Only ever used as an HMAC input.
 */
export function ipPrefix(ip: string | null | undefined): string {
  if (!ip) return 'unknown';
  let value = ip.trim();
  if (value.length === 0 || value.length > 64) return 'unknown';
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);

  const v4 = parseIpv4(value);
  if (v4) return `${v4[0]}.${v4[1]}`;

  if (!value.includes(':')) return 'unknown';
  const v6 = parseIpv6(value);
  if (!v6) return 'unknown';
  const isV4Mapped = v6.slice(0, 5).every((hextet) => hextet === 0) && v6[5] === 0xffff;
  if (isV4Mapped) {
    const high = v6[6] ?? 0;
    return `${high >> 8}.${high & 0xff}`;
  }
  return v6
    .slice(0, 3)
    .map((hextet) => hextet.toString(16))
    .join(':');
}

const encoder = new TextEncoder();

async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(input)));
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** First 16 hex chars of SHA-256(user-agent ?? ''). Only ever used as an HMAC input. */
export async function uaHash(userAgent: string | null | undefined): Promise<string> {
  return toHex(await sha256(userAgent ?? '')).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Encoding + HMAC
// ---------------------------------------------------------------------------

/** base64url without padding. */
export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

function hmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret !== secret) {
    const key = globalThis.crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    // Never keep a rejected import around: the next call retries.
    key.catch(() => {
      if (cachedKey?.key === key) cachedKey = null;
    });
    cachedKey = { secret, key };
  }
  return cachedKey.key;
}

async function sign(secret: string, message: string): Promise<string> {
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    encoder.encode(message),
  );
  return base64Url(new Uint8Array(signature));
}

/** Constant-time string comparison (length is public: signatures are fixed-size). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

function nowSeconds(ctx: UamContext): number {
  return Math.floor((ctx.now ?? Date.now()) / 1000);
}

// ---------------------------------------------------------------------------
// Challenge + proof of work
// ---------------------------------------------------------------------------

function challengeMessage(ts: string, difficulty: string, salt: string, ctx: UamContext): string {
  return `c1|${ts}|${difficulty}|${salt}|${ctx.ipPrefix}|${ctx.uaHash}`;
}

/**
 * How long a challenge of `difficulty` bits may take to be solved and posted:
 * 120 s up to 18 bits, then doubled per extra bit (the expected work doubles
 * too), capped at 600 s — 19 → 240 s, 20 → 480 s. The difficulty is part of the
 * signed challenge, so the client cannot stretch its own window.
 */
export function challengeTtlSeconds(difficulty: number): number {
  return Math.min(
    UAM_MAX_CHALLENGE_TTL_SECONDS,
    UAM_CHALLENGE_TTL_SECONDS * 2 ** Math.max(0, difficulty - TTL_SCALING_FROM_DIFFICULTY),
  );
}

/**
 * Issues `c1.<tsSeconds>.<difficulty>.<salt>.<sig>`, bound to the client's
 * ipPrefix + uaHash. Valid for challengeTtlSeconds(difficulty) (see verifyChallenge).
 */
export async function issueChallenge(ctx: UamContext, difficulty: number): Promise<string> {
  if (
    !Number.isInteger(difficulty) ||
    difficulty < UAM_MIN_DIFFICULTY ||
    difficulty > UAM_MAX_DIFFICULTY
  ) {
    throw new RangeError('UAM difficulty out of range');
  }
  const ts = String(nowSeconds(ctx));
  const salt = base64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const level = String(difficulty);
  const sig = await sign(ctx.secret, challengeMessage(ts, level, salt, ctx));
  return `c1.${ts}.${level}.${salt}.${sig}`;
}

/**
 * Checks the signature (against THIS request's ipPrefix + uaHash) first, then
 * the age: tampered/foreign → 'invalid', older than challengeTtlSeconds() of its
 * signed difficulty → 'expired', more than 5 s in the future → 'invalid'.
 */
export async function verifyChallenge(challenge: string, ctx: UamContext): Promise<ChallengeCheck> {
  if (typeof challenge !== 'string' || challenge.length > MAX_TOKEN_LENGTH) {
    return { ok: false, error: 'invalid' };
  }
  const match = CHALLENGE_PATTERN.exec(challenge);
  if (!match) return { ok: false, error: 'invalid' };
  const [, ts = '', level = '', salt = '', sig = ''] = match;

  const difficulty = Number(level);
  if (difficulty < UAM_MIN_DIFFICULTY || difficulty > UAM_MAX_DIFFICULTY) {
    return { ok: false, error: 'invalid' };
  }
  const expected = await sign(ctx.secret, challengeMessage(ts, level, salt, ctx));
  if (!timingSafeEqual(sig, expected)) return { ok: false, error: 'invalid' };

  const issuedAt = Number(ts);
  const now = nowSeconds(ctx);
  if (issuedAt > now + UAM_CLOCK_SKEW_SECONDS) return { ok: false, error: 'invalid' };
  if (now - issuedAt > challengeTtlSeconds(difficulty)) return { ok: false, error: 'expired' };
  return { ok: true, issuedAt, difficulty };
}

/** True when the first `n` bits of `bytes` are all zero. */
export function hasLeadingZeroBits(bytes: Uint8Array, n: number): boolean {
  if (!Number.isInteger(n) || n < 0 || n > bytes.length * 8) return false;
  const fullBytes = Math.floor(n / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  const remainingBits = n % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((bytes[fullBytes] ?? 0xff) & mask) === 0;
}

/**
 * Proof of work: SHA-256(UTF-8 of `${challenge}:${solution}`) must start with at
 * least `difficulty` zero bits. `solution` is 1–12 decimal digits.
 */
export async function verifySolution(
  challenge: string,
  solution: string,
  difficulty: number,
): Promise<boolean> {
  if (typeof solution !== 'string' || !SOLUTION_PATTERN.test(solution)) return false;
  if (typeof challenge !== 'string' || challenge.length > MAX_TOKEN_LENGTH) return false;
  return hasLeadingZeroBits(await sha256(`${challenge}:${solution}`), difficulty);
}

// ---------------------------------------------------------------------------
// Clearance cookie
// ---------------------------------------------------------------------------

function clearanceMessage(iat: string, exp: string, mode: string, ctx: UamContext): string {
  return `v1|${iat}|${exp}|${mode}|${ctx.ipPrefix}|${ctx.uaHash}`;
}

/** Cookie value `v1.<iat>.<exp>.<mode>.<sig>`, bound to the client's ipPrefix + uaHash. */
export async function issueClearance(
  ctx: UamContext,
  mode: ActiveUamMode,
  ttlSeconds: number = UAM_CLEARANCE_TTL_SECONDS,
): Promise<string> {
  const iat = nowSeconds(ctx);
  const exp = iat + Math.max(1, Math.floor(ttlSeconds));
  const sig = await sign(ctx.secret, clearanceMessage(String(iat), String(exp), mode, ctx));
  return `v1.${iat}.${exp}.${mode}.${sig}`;
}

/**
 * A clearance counts when its signature matches THIS request's ipPrefix +
 * uaHash, it has not expired, it was not issued in the future and — when the
 * current mode is 'attack' — it was issued at most one hour ago (whatever mode
 * issued it).
 */
export async function verifyClearance(
  cookie: string | null | undefined,
  ctx: UamContext,
  currentMode: ActiveUamMode,
): Promise<boolean> {
  if (!cookie || cookie.length > MAX_TOKEN_LENGTH) return false;
  const match = CLEARANCE_PATTERN.exec(cookie);
  if (!match) return false;
  const [, iat = '', exp = '', mode = '', sig = ''] = match;

  const expected = await sign(ctx.secret, clearanceMessage(iat, exp, mode, ctx));
  if (!timingSafeEqual(sig, expected)) return false;

  const now = nowSeconds(ctx);
  const issuedAt = Number(iat);
  if (Number(exp) <= now) return false;
  if (issuedAt > now + UAM_CLOCK_SKEW_SECONDS) return false;
  if (currentMode === 'attack' && now - issuedAt > UAM_ATTACK_MAX_CLEARANCE_AGE_SECONDS) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Who and what is gated
// ---------------------------------------------------------------------------

const ALLOWLISTED_BOT =
  /googlebot|google-inspectiontool|googleother|storebot-google|adsbot-google|bingbot|bingpreview|duckduckbot|yandexbot|baiduspider|applebot|facebookexternalhit|facebot|twitterbot|telegrambot|whatsapp|linkedinbot|slackbot|discordbot|pinterestbot|redditbot|skypeuripreview|embedly|gptbot|oai-searchbot|chatgpt-user|claudebot|claude-user|perplexitybot/i;

/**
 * Search crawlers and link-preview bots (first-visit mode only). The UA is
 * self-declared, so attack mode ignores this list.
 */
export function isAllowlistedBot(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return ALLOWLISTED_BOT.test(userAgent.slice(0, MAX_UA_LENGTH));
}

const EXEMPT_EXACT = new Set([
  '/api',
  '/_next',
  '/_vercel',
  '/health',
  '/.well-known',
  '/favicon.ico',
  '/manifest.webmanifest',
  '/robots.txt',
  '/sitemap.xml',
  '/llms.txt',
]);
const EXEMPT_DIRECTORIES = ['/api/', '/_next/', '/_vercel/', '/health/', '/.well-known/'];
const EXEMPT_NAME_PREFIXES = ['/icon', '/apple-icon', '/opengraph-image', '/twitter-image'];
/**
 * Static-file extensions that skip the gate. Deliberately a closed list, not
 * "any dot": the dynamic pages (/albums/[albumId], /generi/[slug], …) would
 * otherwise render for `/albums/x.y` without a challenge.
 * Keep in sync with the src/proxy.ts matcher once the gate is wired (see uam-gate.ts).
 */
export const UAM_STATIC_EXTENSIONS = [
  'ico',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'css',
  'js',
  'mjs',
  'map',
  'json',
  'txt',
  'xml',
  'webmanifest',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'opus',
  'wav',
  'mp4',
  'webm',
  'vtt',
  'pdf',
  'apk',
  'mobileconfig',
  'wasm',
] as const;
const STATIC_FILE = new RegExp(`\\.(?:${UAM_STATIC_EXTENSIONS.join('|')})$`, 'i');

/**
 * True when a navigation to `pathname` should pass through the gate. False for
 * /api, framework/platform internals, health, metadata files and static files.
 */
export function isGateablePath(pathname: string): boolean {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return true;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;
  if (EXEMPT_EXACT.has(path)) return false;
  if (EXEMPT_DIRECTORIES.some((directory) => path.startsWith(directory))) return false;
  if (EXEMPT_NAME_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  return !STATIC_FILE.test(lastSegment);
}

// ---------------------------------------------------------------------------
// Where the gate may challenge
// ---------------------------------------------------------------------------

/** NEXT_PUBLIC_APP_URL's default in src/lib/env.ts. */
const DEFAULT_APP_URL = 'http://localhost:3000';
/** Vercel system env vars that hold this deployment's own hosts (no scheme). */
const VERCEL_HOST_VARS = ['VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL'];

/** Exact http(s) origin of `value`; null for wildcards, credentials and garbage (as sameOrigin). */
function exactOrigin(value: string): string | null {
  if (value.includes('*')) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * This Vercel deployment's own https origins: its unique deployment URL, its
 * branch URL and the project's production domain (none outside Vercel). POST
 * /api/uam/verify accepts them on top of sameOrigin, so the gate also works,
 * and can be tried out, on preview and deployment URLs.
 */
export function vercelDeploymentOrigins(env: EnvLike = process.env): string[] {
  const origins: string[] = [];
  for (const name of VERCEL_HOST_VARS) {
    const host = env[name]?.trim();
    const origin = host ? exactOrigin(`https://${host}`) : null;
    if (origin) origins.push(origin);
  }
  return origins;
}

/**
 * Hosts the gate may challenge on: the ones whose pages pass the origin check of
 * POST /api/uam/verify — NEXT_PUBLIC_APP_URL (default http://localhost:3000, as
 * in src/lib/env.ts), the exact origins in BETTER_AUTH_TRUSTED_ORIGINS (as in
 * src/lib/same-origin.ts) and vercelDeploymentOrigins(). On any other host (a
 * new custom domain, an unlisted alias) verify would answer 403 forever, so the
 * gate lets requests through there instead: add a new domain to
 * NEXT_PUBLIC_APP_URL or BETTER_AUTH_TRUSTED_ORIGINS to gate it.
 */
export function uamChallengeHosts(env: EnvLike = process.env): Set<string> {
  const candidates = [
    env.NEXT_PUBLIC_APP_URL?.trim() || DEFAULT_APP_URL,
    ...(env.BETTER_AUTH_TRUSTED_ORIGINS ?? '').split(','),
  ];
  const hosts = new Set<string>();
  for (const candidate of candidates) {
    const origin = exactOrigin(candidate.trim());
    if (origin) hosts.add(new URL(origin).host);
  }
  for (const origin of vercelDeploymentOrigins(env)) hosts.add(new URL(origin).host);
  return hosts;
}
