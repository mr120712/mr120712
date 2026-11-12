// @polsia:user-owned — regole del limite di ascolti per gli account free (pure, testabili).
import { romeDay } from '@/lib/business/rewards';

export const FREE_MONTHLY_PLAYS = 40;
/** Ripetere lo stesso brano entro 30 minuti (pausa, ripresa, ricarica) non conta come nuovo ascolto. */
export const REPLAY_WINDOW_MS = 30 * 60 * 1000;

export function romeMonth(now: Date) {
  return romeDay(now).slice(0, 7);
}

export type PlayDecision =
  | { allowed: true; counted: boolean; used: number; limit: number | null }
  | { allowed: false; reason: 'login_required' | 'monthly_limit'; used: number; limit: number };

export function decidePlay(input: {
  signedIn: boolean;
  premium: boolean;
  usedThisMonth: number;
  recentSameTrack: boolean;
}): PlayDecision {
  if (!input.signedIn) {
    return { allowed: false, reason: 'login_required', used: 0, limit: FREE_MONTHLY_PLAYS };
  }
  if (input.premium)
    return { allowed: true, counted: false, used: input.usedThisMonth, limit: null };
  if (input.recentSameTrack) {
    return { allowed: true, counted: false, used: input.usedThisMonth, limit: FREE_MONTHLY_PLAYS };
  }
  if (input.usedThisMonth >= FREE_MONTHLY_PLAYS) {
    return {
      allowed: false,
      reason: 'monthly_limit',
      used: input.usedThisMonth,
      limit: FREE_MONTHLY_PLAYS,
    };
  }
  return { allowed: true, counted: true, used: input.usedThisMonth + 1, limit: FREE_MONTHLY_PLAYS };
}

/**
 * Fonti escluse dai 40 ascolti Free: non vengono mai contate né bloccate dal limite
 * (serve comunque l'accesso con un account).
 * - YouTube: le norme delle API YouTube vietano di limitare o far pagare l'accesso ai
 *   contenuti YouTube.
 * - Radio dal vivo: lo stream è della stazione, Solco non lo vende né lo limita.
 * Il limite vale per Audius e podcast (e per Jamendo, se mai attivato con una licenza commerciale).
 */
// I brani caricati nella libreria pubblica sono contenuti degli utenti (non catalogo in licenza):
// non consumano il limite gratuito, come YouTube e le radio.
export const FREE_QUOTA_EXEMPT_PREFIXES = ['youtube:', 'radio:', 'upload:'] as const;

export function countsTowardFreeQuota(qualifiedId: string) {
  return !FREE_QUOTA_EXEMPT_PREFIXES.some((prefix) => qualifiedId.startsWith(prefix));
}

export function isValidPlayId(qualifiedId: string) {
  return /^(audius:[A-Za-z0-9_-]{1,128}|radio:[A-Za-z0-9_-]{1,128}|podcast:[0-9]{1,20}~[A-Za-z0-9_-]{1,64}|jamendo:[0-9]{1,20}|youtube:[A-Za-z0-9_-]{11})$/.test(
    qualifiedId,
  );
}
