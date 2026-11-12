// @polsia:user-owned — "Scarica il permesso": decide, in modo puro, se un brano si può salvare
// per l'ascolto OFFLINE o se resta solo in streaming, con una nota in italiano per chi non si può
// scaricare.
//
// Fonti consentite (le sole):
//  1. file locali dell'ascoltatore ('local') — già sul dispositivo, nulla da scaricare;
//  2. Audius quando l'artista ha segnato il brano come scaricabile (is_downloadable) ED è
//     riproducibile sotto la Open Music License (evaluateAudiusPlayback) → 'audius-download';
//  3. episodi podcast: le enclosure RSS sono fatte per essere scaricate → 'podcast-download'.
// Tutto il resto (YouTube, radio, Jamendo, Audius non scaricabile o con altra licenza, brani
// importati) resta 'online-only'. Non si scarica MAI da YouTube (le condizioni vietano il
// download), dalla radio (diretta) o da Jamendo (solo uso non commerciale).
//
// Funzione PURA: niente rete, niente server-only. Chi la chiama fornisce i dati già risolti
// (per Audius: is_downloadable e l'esito di evaluateAudiusPlayback); la rotta di download li
// riverifica comunque lato server prima di scaricare un solo byte.

import { type AudiusPlaybackReason, getAudiusPlaybackReasonText } from '@/lib/music/audius';

/** Esito dell'idoneità offline: una delle tre fonti consentite, oppure solo-streaming. */
export type OfflineEligibility =
  | { kind: 'local' }
  | { kind: 'audius-download' }
  | { kind: 'podcast-download' }
  | { kind: 'online-only'; reason: string };

export type OfflineEligibilityInput =
  /** File dell'ascoltatore, già in "La tua musica". */
  | { source: 'local' }
  /**
   * Brano Audius. `playbackEligible` è l'esito di evaluateAudiusPlayback (copre la Open Music
   * License); `isDownloadable` è il campo is_downloadable dell'API Audius.
   */
  | {
      source: 'audius';
      isDownloadable: boolean;
      playbackEligible: boolean;
      playbackReason?: AudiusPlaybackReason;
    }
  /** Episodio podcast: `hasEnclosure` false solo se il feed non espone un file audio. */
  | { source: 'podcast'; hasEnclosure?: boolean }
  | { source: 'youtube' }
  | { source: 'radio' }
  | { source: 'jamendo' }
  /** Brano importato da un elenco: viene risolto e riprodotto in streaming da YouTube. */
  | { source: 'song' };

/** Note in italiano mostrate accanto a un brano che resta solo in streaming. */
export const OFFLINE_INELIGIBLE_REASONS = {
  youtube:
    'I brani di YouTube si possono solo ascoltare in streaming: le condizioni di YouTube non ne permettono il download.',
  radio: 'La radio è una diretta e non si può scaricare per l’ascolto offline.',
  jamendo: 'I brani Jamendo sono concessi per il solo uso non commerciale e restano in streaming.',
  song: 'Questo brano importato viene riprodotto in streaming da YouTube, quindi non è scaricabile.',
  audiusNotDownloadable:
    'L’artista non ha reso questo brano scaricabile: resta in streaming su Audius.',
  audiusLicense:
    'L’artista ha scelto una licenza diversa da quella aperta: questo brano si ascolta solo in streaming.',
  audiusUnavailable: 'Questo brano Audius non è disponibile per il download offline.',
  podcastNoAudio: 'Questo episodio non ha un file audio da scaricare.',
} as const;

function onlineOnly(reason: string): OfflineEligibility {
  return { kind: 'online-only', reason };
}

function audiusEligibility(input: {
  isDownloadable: boolean;
  playbackEligible: boolean;
  playbackReason?: AudiusPlaybackReason;
}): OfflineEligibility {
  if (!input.playbackEligible) {
    if (input.playbackReason === 'license_not_allowed') {
      return onlineOnly(OFFLINE_INELIGIBLE_REASONS.audiusLicense);
    }
    // Un brano non riproducibile (gated, non in streaming, stato sconosciuto…) non è scaricabile:
    // riusa la spiegazione già tradotta quando c'è, altrimenti una nota generica.
    return onlineOnly(
      input.playbackReason
        ? getAudiusPlaybackReasonText(input.playbackReason)
        : OFFLINE_INELIGIBLE_REASONS.audiusUnavailable,
    );
  }
  if (!input.isDownloadable) {
    return onlineOnly(OFFLINE_INELIGIBLE_REASONS.audiusNotDownloadable);
  }
  return { kind: 'audius-download' };
}

/** Decide l'idoneità offline di un brano. Vedi OfflineEligibility. */
export function offlineEligibility(input: OfflineEligibilityInput): OfflineEligibility {
  switch (input.source) {
    case 'local':
      return { kind: 'local' };
    case 'audius':
      return audiusEligibility(input);
    case 'podcast':
      return input.hasEnclosure === false
        ? onlineOnly(OFFLINE_INELIGIBLE_REASONS.podcastNoAudio)
        : { kind: 'podcast-download' };
    case 'youtube':
      return onlineOnly(OFFLINE_INELIGIBLE_REASONS.youtube);
    case 'radio':
      return onlineOnly(OFFLINE_INELIGIBLE_REASONS.radio);
    case 'jamendo':
      return onlineOnly(OFFLINE_INELIGIBLE_REASONS.jamendo);
    case 'song':
      return onlineOnly(OFFLINE_INELIGIBLE_REASONS.song);
  }
}

/** Vero quando l'esito consente un salvataggio offline (locale o scaricabile). */
export function isOfflineAvailable(eligibility: OfflineEligibility): boolean {
  return eligibility.kind !== 'online-only';
}

/** Vero quando l'esito richiede davvero un download (Audius o podcast), non un file già locale. */
export function isOfflineDownloadable(eligibility: OfflineEligibility): boolean {
  return eligibility.kind === 'audius-download' || eligibility.kind === 'podcast-download';
}
