// @polsia:user-owned — regole del limite di ascolti per gli account free (pure, testabili).
import { romeDay } from '@/lib/business/rewards';
import { AUDIOCOM_QUALIFIED_PREFIX, audioComIdFromQualifiedId } from '@/lib/music/audiocom-license';

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
 * Il limite vale per Audius, podcast e brani di audio.com (`audiocom:<id>`, solo CC0 / CC BY /
 * CC BY-SA / CC BY-ND, mai cover: vedi audiocom-license.ts), e per Jamendo se mai attivato con una
 * licenza commerciale.
 */
// I brani caricati nella libreria pubblica sono contenuti degli utenti (non catalogo in licenza):
// non consumano il limite gratuito, come YouTube e le radio. audio.com NON è qui: ha il suo
// prefisso `audiocom:` (non più `upload:audiocom~`), quindi conta e richiede l'accesso.
export const FREE_QUOTA_EXEMPT_PREFIXES = ['youtube:', 'radio:', 'upload:'] as const;

export function countsTowardFreeQuota(qualifiedId: string) {
  return !FREE_QUOTA_EXEMPT_PREFIXES.some((prefix) => qualifiedId.startsWith(prefix));
}

/**
 * Fonti il cui audio il browser scarica DIRETTAMENTE dalla fonte (audio.com: stream https sui suoi
 * server), senza passare da una route di stream di Solco. Per le altre fonti è la route di stream
 * a fermare ospiti e account oltre il limite e a registrare l'ascolto quando l'audio parte; qui
 * nessuna route lo vede, quindi l'unico controllo è il permesso del player (POST
 * /api/music/plays), che per questi id REGISTRA l'ascolto Free invece di limitarsi a verificarlo.
 * Il player aspetta quel permesso prima di far partire l'audio (vedi music-player.tsx).
 */
export const PERMIT_RECORDED_PREFIXES = [AUDIOCOM_QUALIFIED_PREFIX] as const;

export function permitRecordsPlay(qualifiedId: string) {
  return PERMIT_RECORDED_PREFIXES.some((prefix) => qualifiedId.startsWith(prefix));
}

export function isValidPlayId(qualifiedId: string) {
  if (qualifiedId.startsWith(AUDIOCOM_QUALIFIED_PREFIX)) {
    return audioComIdFromQualifiedId(qualifiedId) !== null;
  }
  return /^(audius:[A-Za-z0-9_-]{1,128}|radio:[A-Za-z0-9_-]{1,128}|podcast:[0-9]{1,20}~[A-Za-z0-9_-]{1,64}|jamendo:[0-9]{1,20}|youtube:[A-Za-z0-9_-]{11})$/.test(
    qualifiedId,
  );
}
