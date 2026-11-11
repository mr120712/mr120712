// @polsia:user-owned — "developer token" di Apple Music (MusicKit) firmato con la chiave .p8.
// Il token è pubblico per natura (lo usa il browser) ma vale solo per i domini di Solco
// (claim `origin`) e scade: lo rigeneriamo ogni 30 giorni.
import 'server-only';
import { createPrivateKey, sign } from 'node:crypto';
import { normalizePrivateKey } from '@/lib/business/apple-client-secret';

export const APPLE_MUSIC_TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

type TokenEnv = Record<string, string | undefined>;

export function appleMusicConfig(env: TokenEnv = process.env) {
  const teamId = env.APPLE_MUSIC_TEAM_ID?.trim() || env.APPLE_TEAM_ID?.trim();
  const keyId = env.APPLE_MUSIC_KEY_ID?.trim();
  const privateKey = env.APPLE_MUSIC_PRIVATE_KEY?.trim();
  if (!teamId || !keyId || !privateKey) return null;
  return { teamId, keyId, privateKey };
}

export function buildAppleMusicDeveloperToken(input: {
  teamId: string;
  keyId: string;
  privateKey: string;
  origins: string[];
  now?: Date;
}) {
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'ES256', kid: input.keyId });
  const payload = encode({
    iss: input.teamId,
    iat,
    exp: iat + APPLE_MUSIC_TOKEN_LIFETIME_SECONDS,
    origin: input.origins,
  });
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: createPrivateKey(normalizePrivateKey(input.privateKey)),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

let cached: { token: string; expiresAt: number } | null = null;

/** Token valido (riusato finché mancano più di 24 h alla scadenza); null se non configurato. */
export function currentAppleMusicToken(origins: string[], now = new Date()) {
  const config = appleMusicConfig();
  if (!config) return null;
  if (cached && cached.expiresAt - now.getTime() > 24 * 60 * 60 * 1000) return cached.token;
  try {
    const token = buildAppleMusicDeveloperToken({ ...config, origins, now });
    cached = { token, expiresAt: now.getTime() + APPLE_MUSIC_TOKEN_LIFETIME_SECONDS * 1000 };
    return token;
  } catch {
    // Malformed key: treat as not configured instead of failing the request.
    return null;
  }
}
