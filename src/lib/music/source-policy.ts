// @polsia:user-owned

export type SourceBlocker = 'credential_missing';

export type SearchOutcome =
  | 'idle'
  | 'results'
  | 'no_results'
  | 'partial'
  | 'unavailable'
  | 'inactive';

export type MusicSourceId = 'audius' | 'youtube';

export const AUDIUS_PREREQUISITE =
  'Configura AUDIUS_API_KEY nei segreti server-side. I risultati e la riproduzione dipendono dalla risposta REST di Audius e dallo stato del singolo brano.';

export const YOUTUBE_PREREQUISITE =
  'Configurare YOUTUBE_DATA_API_KEY nei segreti server-side, con un progetto dedicato, YouTube Data API v3 abilitata e quota disponibile. La chiave resta sul server.';

export function sourceStatus(input: {
  id: MusicSourceId;
  active: boolean;
  outcome?: SearchOutcome;
  unavailableReason?: 'not_configured' | 'quota_exceeded' | 'api_error';
  retryAfterSeconds?: number;
  youtubeConfigured?: boolean;
  audiusApiKeyConfigured?: boolean;
  blockers?: SourceBlocker[];
}) {
  if (input.id === 'audius') {
    return {
      id: 'audius' as const,
      label: 'Solco',
      active: input.active,
      searchOutcome: input.outcome ?? (input.active ? 'idle' : 'inactive'),
      ...(input.unavailableReason ? { unavailableReason: input.unavailableReason } : {}),
      ...(input.retryAfterSeconds ? { retryAfterSeconds: input.retryAfterSeconds } : {}),
      blockers: input.blockers ?? [],
      summary: input.active
        ? 'Audius è disponibile per la ricerca REST; lo stream viene verificato con la risposta del servizio per ogni brano.'
        : 'La ricerca Audius non è disponibile: manca AUDIUS_API_KEY nei segreti server-side.',
      prerequisite: AUDIUS_PREREQUISITE,
    };
  }

  const configured = Boolean(input.youtubeConfigured);
  return {
    id: 'youtube' as const,
    label: 'YouTube',
    active: configured,
    searchOutcome: input.outcome ?? (configured ? 'idle' : 'inactive'),
    ...(input.unavailableReason ? { unavailableReason: input.unavailableReason } : {}),
    summary: configured
      ? 'La chiave server-side è presente; la disponibilità effettiva dipende dalla risposta della YouTube Data API.'
      : 'Ricerca YouTube inattiva: manca la chiave server-side richiesta.',
    prerequisite: YOUTUBE_PREREQUISITE,
  };
}

export function withSourceSearchOutcomes(
  outcomes: Partial<Record<MusicSourceId, SearchOutcome>>,
  input: { audiusActive: boolean; youtubeConfigured: boolean },
) {
  return [
    sourceStatus({ id: 'audius', active: input.audiusActive, outcome: outcomes.audius }),
    sourceStatus({
      id: 'youtube',
      active: input.youtubeConfigured,
      outcome: outcomes.youtube,
      youtubeConfigured: input.youtubeConfigured,
    }),
  ];
}
