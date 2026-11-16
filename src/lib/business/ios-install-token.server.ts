// @polsia:user-owned — token di installazione dell'app iOS. L'installatore di iOS scarica manifest e
// IPA senza i cookie di Safari, quindi il cancello non può essere la sessione: GET /api/ios/install
// (con sessione) rilascia un token firmato HMAC-SHA256, legato all'account e a scadenza (15 minuti),
// che manifest e IPA verificano. Il segreto è BETTER_AUTH_SECRET con un contesto dedicato, come per
// gli id di condivisione (featured-share.server): cambiarlo invalida i link in corso, nient'altro.
import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { IOS_INSTALL_TOKEN_TTL_MS } from '@/lib/ios-app';

/** Contesto dell'HMAC: separa questi token da ogni altro uso dello stesso segreto. */
export const IOS_INSTALL_TOKEN_CONTEXT = 'ios-install:v1:';

const PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{1,400}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type IosInstallTokenClaims = { userId: string; exp: number };
export type IosInstallTokenCheck =
  | { ok: true; claims: IosInstallTokenClaims }
  | { ok: false; reason: 'secret' | 'format' | 'signature' | 'expired' };

/** Il segreto per i token, o null (installazione spenta) se manca. */
export function iosInstallSecret(): string | null {
  const secret = env.BETTER_AUTH_SECRET;
  return typeof secret === 'string' && secret.trim() ? secret : null;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${IOS_INSTALL_TOKEN_CONTEXT}${payload}`)
    .digest('base64url');
}

/** Token `payload.firma`: il payload è JSON {u, e} in base64url. Null senza segreto. */
export function signIosInstallToken(
  userId: string,
  now: number = Date.now(),
  ttlMs: number = IOS_INSTALL_TOKEN_TTL_MS,
): { token: string; expiresAt: number } | null {
  const secret = iosInstallSecret();
  if (!secret || !userId) return null;
  const expiresAt = now + ttlMs;
  const payload = Buffer.from(JSON.stringify({ u: userId, e: expiresAt }), 'utf8').toString(
    'base64url',
  );
  return { token: `${payload}.${sign(payload, secret)}`, expiresAt };
}

export function verifyIosInstallToken(
  token: string | null | undefined,
  now: number = Date.now(),
): IosInstallTokenCheck {
  const secret = iosInstallSecret();
  if (!secret) return { ok: false, reason: 'secret' };
  if (typeof token !== 'string') return { ok: false, reason: 'format' };
  const dot = token.indexOf('.');
  if (dot <= 0) return { ok: false, reason: 'format' };
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!PAYLOAD_PATTERN.test(payload) || !SIGNATURE_PATTERN.test(signature)) {
    return { ok: false, reason: 'format' };
  }
  const expected = Buffer.from(sign(payload, secret), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'signature' };
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'format' };
  }
  if (
    !claims ||
    typeof claims !== 'object' ||
    typeof (claims as { u?: unknown }).u !== 'string' ||
    typeof (claims as { e?: unknown }).e !== 'number'
  ) {
    return { ok: false, reason: 'format' };
  }
  const { u: userId, e: exp } = claims as { u: string; e: number };
  if (!userId || !Number.isFinite(exp) || exp <= now) return { ok: false, reason: 'expired' };
  return { ok: true, claims: { userId, exp } };
}
