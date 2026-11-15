// @polsia:user-owned — "Scarica il permesso": decide, in modo puro, se un brano si può salvare
// per l'ascolto OFFLINE o se resta solo in streaming, con una nota in italiano per chi non si può
// scaricare.
//
// Fonti consentite (le sole):
//  1. file locali dell'ascoltatore ('local') — già sul dispositivo, nulla da scaricare;
//  2. Audius quando l'artista ha segnato il brano come scaricabile (is_downloadable) ED è
//     riproducibile sotto la Open Music License (evaluateAudiusPlayback) → 'audius-download';
//  3. episodi podcast: le enclosure RSS sono fatte per essere scaricate → 'podcast-download';
//  4. brani in evidenza DICHIARATI in diritti.json col permesso della copia offline →
//     'featured-download' (regole in featuredOfflinePermission, qui sotto, e nel commento di
//     featured-rights.server.ts): licenza "propria", "cc0", "cc-by", "cc-by-sa" o "cc-by-nd" salvo
//     "offline": false; licenza "licenza" (contratto con terzi) SOLO con "offline": true. Un brano
//     non dichiarato non è MAI scaricabile.
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
  | { kind: 'featured-download' }
  | { kind: 'online-only'; reason: string };

/**
 * Licenze di diritti.json (le stesse di featured-rights.server, che le riusa: qui senza
 * server-only, così la regola della copia offline è una sola per server, client e test).
 */
export const FEATURED_RIGHTS_LICENCES = [
  'propria',
  'licenza',
  'cc0',
  'cc-by',
  'cc-by-sa',
  'cc-by-nd',
] as const;
export type FeaturedRightsLicence = (typeof FEATURED_RIGHTS_LICENCES)[number];

/**
 * Perché un brano in evidenza DICHIARATO può (o non può) avere la copia offline:
 *  - licence_default: licenza propria o Creative Commons commerciale, nessun "offline" → sì;
 *  - opt_in: "offline": true → sì (l'unico modo per la licenza "licenza");
 *  - opt_out: "offline": false → no, qualunque sia la licenza;
 *  - licence_needs_opt_in: licenza "licenza" senza "offline": true → no (una licenza di streaming
 *    non copre per forza il download).
 */
export type FeaturedOfflineBasis =
  | 'licence_default'
  | 'opt_in'
  | 'opt_out'
  | 'licence_needs_opt_in';

/** La parte di una voce di diritti.json che decide la copia offline. */
export type FeaturedOfflineRightsEntry = {
  licenza: FeaturedRightsLicence;
  offline?: boolean;
};

/**
 * La regola della copia offline di un brano in evidenza DICHIARATO (una voce valida di
 * diritti.json). Pura: chi la chiama ha già verificato che la voce esista e valga.
 */
export function featuredOfflinePermission(entry: FeaturedOfflineRightsEntry): {
  allowed: boolean;
  basis: FeaturedOfflineBasis;
} {
  if (entry.offline === false) return { allowed: false, basis: 'opt_out' };
  if (entry.offline === true) return { allowed: true, basis: 'opt_in' };
  if (entry.licenza === 'licenza') return { allowed: false, basis: 'licence_needs_opt_in' };
  return { allowed: true, basis: 'licence_default' };
}

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
  | { source: 'song' }
  /**
   * Brano in evidenza (lato server): la voce di diritti.json che vale per quel file, o null se il
   * brano non è dichiarato (mai scaricabile).
   */
  | { source: 'featured'; entry: FeaturedOfflineRightsEntry | null }
  /**
   * Brano in evidenza (lato client): il permesso già calcolato dal server sul manifest (campo
   * `offline` delle risposte con brani dichiarati). Assente/null = non disponibile.
   */
  | { source: 'featured-track'; offline?: boolean | null };

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
  featuredDeclined:
    'Il titolare non ha concesso la copia offline: questo brano si ascolta solo in streaming.',
  featuredStreamingLicence:
    'La licenza di questo brano copre l’ascolto in streaming ma non la copia offline: si ascolta solo in streaming.',
  featuredUnavailable: 'Questo brano in evidenza non è disponibile per la copia offline.',
} as const;

/** La nota in italiano per un brano in evidenza dichiarato SENZA copia offline. */
export function featuredOfflineReason(basis: FeaturedOfflineBasis): string {
  return basis === 'licence_needs_opt_in'
    ? OFFLINE_INELIGIBLE_REASONS.featuredStreamingLicence
    : OFFLINE_INELIGIBLE_REASONS.featuredDeclined;
}

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
    case 'featured': {
      // Non dichiarato: la stessa nota di un brano sconosciuto (non si dice che cosa c'è nello store).
      if (!input.entry) return onlineOnly(OFFLINE_INELIGIBLE_REASONS.featuredUnavailable);
      const permission = featuredOfflinePermission(input.entry);
      return permission.allowed
        ? { kind: 'featured-download' }
        : onlineOnly(featuredOfflineReason(permission.basis));
    }
    case 'featured-track':
      if (input.offline === true) return { kind: 'featured-download' };
      return onlineOnly(
        input.offline === false
          ? OFFLINE_INELIGIBLE_REASONS.featuredDeclined
          : OFFLINE_INELIGIBLE_REASONS.featuredUnavailable,
      );
  }
}

/** Vero quando l'esito consente un salvataggio offline (locale o scaricabile). */
export function isOfflineAvailable(eligibility: OfflineEligibility): boolean {
  return eligibility.kind !== 'online-only';
}

/**
 * Vero quando l'esito richiede davvero un download (Audius, podcast o brano in evidenza), non un
 * file già locale.
 */
export function isOfflineDownloadable(eligibility: OfflineEligibility): boolean {
  return (
    eligibility.kind === 'audius-download' ||
    eligibility.kind === 'podcast-download' ||
    eligibility.kind === 'featured-download'
  );
}
