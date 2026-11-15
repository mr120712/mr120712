// @polsia:user-owned — testi del player: perché un ascolto non è partito e quando mostrare il
// contatore degli ascolti gratuiti. Pure e testabili.
import { serverLimitMessage } from '@/lib/business/api-error-message';
import { audioComIdFromQualifiedId } from '@/lib/music/audiocom-license';

type MessageTrack = { playbackMode?: string | null; sourceUrl?: string | null } | null;

export const LICENSE_NOT_ALLOWED_MESSAGE =
  "L'artista ha scelto una licenza diversa: questo brano si ascolta solo su Audius.";
const UNAVAILABLE_MESSAGE = 'Questo brano non è disponibile al momento.';
/** Brano on-demand che non è partito affatto: il player passa da solo al successivo della coda. */
export const UNAVAILABLE_SKIP_MESSAGE = 'Brano non disponibile, passo al successivo.';
/** Stream interrotto senza rete: il player riprende da solo, dal punto in cui era, quando torna. */
export const OFFLINE_RESUME_MESSAGE = 'Connessione assente: riprendo appena torna la rete.';
/** Un giro completo della coda senza un video che parta: il player si ferma invece di girare a vuoto. */
export const YOUTUBE_QUEUE_UNPLAYABLE_MESSAGE = 'Nessun video della coda è riproducibile qui.';
/**
 * Brano di audio.com il cui permesso il server non ha confermato (rete, registro degli ascolti non
 * disponibile): l'audio non parte, perché nessuna route di stream lo ricontrollerebbe dopo.
 */
export const PLAY_PERMIT_UNCONFIRMED_MESSAGE =
  'Non è stato possibile verificare l’ascolto: nessun audio è partito. Riprova tra poco.';

/** Why an ascolto failed, in Italian. `error` carries the server's JSON body in `cause`. */
export function failureMessage(error: unknown, track: MessageTrack): string {
  if (track?.playbackMode === 'radio')
    return 'La stazione radio non risponde in questo momento. Prova un’altra stazione.';
  if (track?.playbackMode === 'podcast')
    return 'L’episodio non è disponibile dal feed del podcast. Riprova più tardi.';
  // Brano in evidenza o caricato: un file servito da Solco, niente a che vedere con Audius.
  if (track?.playbackMode === 'upload')
    return 'Il file di questo brano non è disponibile in questo momento. Riprova più tardi.';
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { error?: unknown; reason?: unknown; retryAfterSeconds?: unknown })
      : null;
  const reason = typeof cause?.reason === 'string' ? cause.reason : null;
  const limit = serverLimitMessage(error);
  if (limit) return limit;
  if (reason === 'license_not_allowed') return LICENSE_NOT_ALLOWED_MESSAGE;
  // Jamendo is switched off: a neutral message, no plan or catalogue promises.
  if (track?.playbackMode === 'jamendo' || reason === 'premium_required')
    return UNAVAILABLE_MESSAGE;
  if (reason === 'unauthorized') return 'Accedi per verificare l’accesso a Solco Pro.';
  if (reason === 'pro_required')
    return 'L’ascolto integrale richiede un abbonamento Solco Pro attivo.';
  if (reason === 'rights_unverified' || reason === 'rights_unavailable')
    return 'Questo brano non è disponibile: fonte o diritti di streaming non sono verificati.';
  if (reason === 'entitlement_unavailable')
    return 'La verifica dell’abbonamento non è disponibile. Nessun audio è stato riprodotto.';
  if (reason === 'track_unavailable') return 'Il brano non è disponibile per l’ascolto integrale.';
  if (reason === 'catalog_unavailable')
    return 'Il catalogo Audius non è verificabile. Nessun audio è stato riprodotto.';
  if (reason === 'album_context_required')
    return 'Per l’ascolto integrale serve una scheda album verificata.';
  if (reason === 'source_inactive')
    return 'Audius non è configurata o non è disponibile. Nessun audio è stato riprodotto.';
  if (reason === 'track_not_found') return 'Audius non ha trovato il brano richiesto.';
  if (reason === 'not_streamable') return 'Audius non autorizza lo streaming di questo brano.';
  if (reason === 'gated' || reason === 'access_denied')
    return 'Audius non autorizza questo stream per l’accesso corrente.';
  if (reason === 'access_unknown' || reason === 'state_unknown')
    return 'Audius non ha confermato lo stato di accesso; la riproduzione è stata fermata.';
  if (reason === 'rate_limited')
    return typeof cause?.retryAfterSeconds === 'number'
      ? `Audius ha limitato le richieste. Riprova tra ${cause.retryAfterSeconds} secondi.`
      : 'Audius ha limitato le richieste; attendi prima di riprovare.';
  return 'La verifica o lo stream Audius è fallito. Nessun audio è stato lasciato in riproduzione.';
}

/** Link shown next to an error message: the track's own Audius page for a licence refusal. */
export function failureLink(
  message: string | null,
  track: MessageTrack,
): { href: string; label: string } | null {
  if (message !== LICENSE_NOT_ALLOWED_MESSAGE || !track?.sourceUrl) return null;
  try {
    const url = new URL(track.sourceUrl);
    if (url.protocol !== 'https:') return null;
    if (url.hostname !== 'audius.co' && !url.hostname.endsWith('.audius.co')) return null;
    return { href: url.toString(), label: 'Ascolta su Audius' };
  } catch {
    return null;
  }
}

/**
 * The "Ascolti gratuiti …/40" counter belongs to items that use the Free quota: Audius (album
 * tracks included) and podcasts. Radio and YouTube never count, so they never show it.
 * Anche i brani di audio.com (id `audiocom:<id>`): suonano con lo stream 'upload' dei file
 * pubblici, che invece non contano, quindi qui decide l'id e non la modalità.
 */
export function showsFreePlayCounter(mode: string | null | undefined, qualifiedId?: string | null) {
  if (typeof qualifiedId === 'string' && audioComIdFromQualifiedId(qualifiedId) !== null) {
    return true;
  }
  return mode === 'audius' || mode === 'solco' || mode === 'podcast';
}
