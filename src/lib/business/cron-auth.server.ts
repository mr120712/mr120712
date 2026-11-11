// @polsia:user-owned — autorizzazione dei lavori pianificati (Vercel Cron, vedi vercel.json).
// Vercel invia "Authorization: Bearer <CRON_SECRET>"; senza un segreto lungo e identico la
// richiesta è rifiutata. Confronto a tempo costante per non rivelare il segreto un byte alla volta.
import 'server-only';
import { timingSafeEqual } from 'node:crypto';

/** Shorter secrets are treated as missing: the cron routes then refuse every request. */
export const CRON_SECRET_MIN_LENGTH = 24;

export function cronAuthorized(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const secret = env.CRON_SECRET?.trim();
  if (!secret || secret.length < CRON_SECRET_MIN_LENGTH) return false;
  const given = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
