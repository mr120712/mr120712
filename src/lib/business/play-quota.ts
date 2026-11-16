// @polsia:user-owned — regole del limite di ascolti per gli account free (pure, testabili).
import { romeDay } from '@/lib/business/rewards';
import { AUDIOCOM_QUALIFIED_PREFIX, audioComIdFromQualifiedId } from '@/lib/music/audiocom-license';
import { FEATURED_QUALIFIED_PREFIX, isFeaturedPlayId } from '@/lib/music/featured-track-id';

export const FREE_MONTHLY_PLAYS = 40;
/**
 * I "brani in evidenza" della Home (`upload:<pathname>`, vedi featured-track-id.ts) hanno un
 * conteggio Free A PARTE: al più 30 avvii al mese, che non intaccano i 40 ascolti di Audius,
 * podcast e audio.com e non ne sono intaccati. Premium: nessun limite, come oggi.
 */
export const FEATURED_FREE_MONTHLY_PLAYS = 30;
/** Ripetere lo stesso brano entro 30 minuti (pausa, ripresa, ricarica) non conta come nuovo ascolto. */
export const REPLAY_WINDOW_MS = 30 * 60 * 1000;

export function romeMonth(now: Date) {
  return romeDay(now).slice(0, 7);
}

export type PlayDecision =
  | { allowed: true; counted: boolean; used: number; limit: number | null }
  | { allowed: false; reason: 'login_required' | 'monthly_limit'; used: number; limit: number };

/**
 * Le stesse regole per ogni conteggio Free; `limit` è il tetto del conteggio in cui entra il brano
 * (40 per il catalogo, 30 per i brani in evidenza: vedi freeMonthlyLimit).
 */
export function decidePlay(input: {
  signedIn: boolean;
  premium: boolean;
  usedThisMonth: number;
  recentSameTrack: boolean;
  limit?: number;
}): PlayDecision {
  const limit = input.limit ?? FREE_MONTHLY_PLAYS;
  if (!input.signedIn) {
    return { allowed: false, reason: 'login_required', used: 0, limit };
  }
  if (input.premium)
    return { allowed: true, counted: false, used: input.usedThisMonth, limit: null };
  if (input.recentSameTrack) {
    return { allowed: true, counted: false, used: input.usedThisMonth, limit };
  }
  if (input.usedThisMonth >= limit) {
    return {
      allowed: false,
      reason: 'monthly_limit',
      used: input.usedThisMonth,
      limit,
    };
  }
  return { allowed: true, counted: true, used: input.usedThisMonth + 1, limit };
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
// I brani in evidenza della Home usano lo stesso prefisso `upload:` ma si riconoscono dal pathname
// (isFeaturedPlayId) e hanno il loro conteggio: vedi playQuotaClass.
export const FREE_QUOTA_EXEMPT_PREFIXES = ['youtube:', 'radio:', 'upload:'] as const;

/**
 * In quale conteggio Free entra un brano:
 * - 'catalog': Audius, podcast, audio.com (e Jamendo se attivo): FREE_MONTHLY_PLAYS al mese;
 * - 'featured': brani in evidenza della Home (`upload:<pathname>`): FEATURED_FREE_MONTHLY_PLAYS;
 * - 'exempt': YouTube, radio dal vivo, upload degli utenti: mai contati né bloccati.
 * Le righe del registro (MusicPlay.qualifiedId) si separano per prefisso: `upload:` sono solo brani
 * in evidenza (gli upload degli utenti, esenti, non hanno mai scritto una riga).
 */
export type PlayQuotaClass = 'catalog' | 'featured' | 'exempt';

export function playQuotaClass(qualifiedId: string): PlayQuotaClass {
  if (isFeaturedPlayId(qualifiedId)) return 'featured';
  if (FREE_QUOTA_EXEMPT_PREFIXES.some((prefix) => qualifiedId.startsWith(prefix))) return 'exempt';
  return 'catalog';
}

/** Il tetto mensile Free del conteggio indicato (per 'exempt' quello del catalogo, solo da mostrare). */
export function freeMonthlyLimit(quotaClass: PlayQuotaClass): number {
  return quotaClass === 'featured' ? FEATURED_FREE_MONTHLY_PLAYS : FREE_MONTHLY_PLAYS;
}

/** Il prefisso delle righe del registro che appartengono al conteggio dei brani in evidenza. */
export const FEATURED_PLAY_ROW_PREFIX = FEATURED_QUALIFIED_PREFIX;

export function countsTowardFreeQuota(qualifiedId: string) {
  return playQuotaClass(qualifiedId) !== 'exempt';
}

/**
 * Fonti il cui audio il browser scarica DIRETTAMENTE dalla fonte (audio.com: stream https sui suoi
 * server), senza passare da una route di stream di Solco. Per le altre fonti è la route di stream
 * a fermare ospiti e account oltre il limite e a registrare l'ascolto quando l'audio parte; qui
 * nessuna route lo vede, quindi l'unico controllo è il permesso del player (POST
 * /api/music/plays), che per questi id REGISTRA l'ascolto Free invece di limitarsi a verificarlo.
 * Il player aspetta quel permesso prima di far partire l'audio (vedi music-player.tsx).
 * I brani in evidenza NON sono qui: la loro route (/api/music/home-tracks/stream) vede ogni avvio.
 */
export const PERMIT_RECORDED_PREFIXES = [AUDIOCOM_QUALIFIED_PREFIX] as const;

export function permitRecordsPlay(qualifiedId: string) {
  return PERMIT_RECORDED_PREFIXES.some((prefix) => qualifiedId.startsWith(prefix));
}

export function isValidPlayId(qualifiedId: string) {
  if (qualifiedId.startsWith(AUDIOCOM_QUALIFIED_PREFIX)) {
    return audioComIdFromQualifiedId(qualifiedId) !== null;
  }
  // Brani in evidenza: `upload:<pathname audio>`; un upload utente (cuid) o l'id storico di
  // audio.com (`upload:audiocom~<id>`) non sono id del permesso.
  if (qualifiedId.startsWith(FEATURED_QUALIFIED_PREFIX)) return isFeaturedPlayId(qualifiedId);
  return /^(audius:[A-Za-z0-9_-]{1,128}|radio:[A-Za-z0-9_-]{1,128}|podcast:[0-9]{1,20}~[A-Za-z0-9_-]{1,64}|jamendo:[0-9]{1,20}|youtube:[A-Za-z0-9_-]{11})$/.test(
    qualifiedId,
  );
}
