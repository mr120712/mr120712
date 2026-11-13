// @polsia:user-owned — token firmato (HMAC) per collegare un account Solco al bot Telegram.
// L'utente loggato ottiene un token a breve scadenza; il bot lo riceve via deep-link
// (t.me/<bot>?start=<token>) e, verificandolo, sa quale utente collegare. Nessuna tabella di token:
// il token è autocontenuto e firmato con BETTER_AUTH_SECRET.
import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';

/** Validità del token di collegamento (il tempo per aprire il bot). */
const TOKEN_TTL_MS = 15 * 60 * 1000;

function sign(payload: string): string {
  return createHmac('sha256', env.BETTER_AUTH_SECRET).update(payload).digest('base64url');
}

/** Crea un token `payload.firma` che codifica userId e scadenza. */
export function createTelegramLinkToken(userId: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: now + TOKEN_TTL_MS })).toString(
    'base64url',
  );
  return `${payload}.${sign(payload)}`;
}

/** Verifica firma e scadenza; ritorna lo userId, oppure null se non valido/scaduto. */
export function verifyTelegramLinkToken(token: string, now = Date.now()): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      u?: unknown;
      e?: unknown;
    };
    if (typeof data.u !== 'string' || typeof data.e !== 'number') return null;
    if (now > data.e) return null;
    return data.u;
  } catch {
    return null;
  }
}
