// @polsia:user-owned — "client secret" di Sign in with Apple generato dalla chiave .p8.
// Apple accetta un JWT ES256 valido al massimo 6 mesi: generandolo all'avvio non scade mai.
import { createPrivateKey, sign } from 'node:crypto';

const MAX_LIFETIME_SECONDS = 180 * 24 * 60 * 60 - 60;

function base64url(value: Buffer | string) {
  return Buffer.from(value).toString('base64url');
}

/** Accetta la chiave .p8 con a capo veri o scritti come "\n" (come capita nelle variabili d'ambiente). */
export function normalizePrivateKey(raw: string) {
  const key = raw.trim().replace(/\\n/g, '\n');
  return key.includes('BEGIN PRIVATE KEY')
    ? key
    : `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----`;
}

export function buildAppleClientSecret(input: {
  teamId: string;
  keyId: string;
  clientId: string;
  privateKey: string;
  now?: Date;
}) {
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: input.keyId, typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: input.teamId,
      iat,
      exp: iat + MAX_LIFETIME_SECONDS,
      aud: 'https://appleid.apple.com',
      sub: input.clientId,
    }),
  );
  const key = createPrivateKey(normalizePrivateKey(input.privateKey));
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${payload}.${base64url(signature)}`;
}

/** Secret di Apple: quello fornito, oppure generato da Team ID, Key ID e chiave .p8. */
export function resolveAppleClientSecret(env: {
  APPLE_CLIENT_ID?: string;
  APPLE_CLIENT_SECRET?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
}) {
  const clientId = env.APPLE_CLIENT_ID?.trim();
  if (!clientId) return undefined;
  if (env.APPLE_CLIENT_SECRET?.trim()) return env.APPLE_CLIENT_SECRET.trim();
  const teamId = env.APPLE_TEAM_ID?.trim();
  const keyId = env.APPLE_KEY_ID?.trim();
  const privateKey = env.APPLE_PRIVATE_KEY?.trim();
  if (!teamId || !keyId || !privateKey) return undefined;
  try {
    return buildAppleClientSecret({ teamId, keyId, clientId, privateKey });
  } catch {
    // Malformed key: leave Apple sign-in off rather than breaking every auth request.
    return undefined;
  }
}
