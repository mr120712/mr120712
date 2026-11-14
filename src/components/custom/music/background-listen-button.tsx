// @polsia:user-owned — "Ascolta in background": cerca lo stesso brano di un video YouTube su
// Audius o Jamendo (licenze che consentono l'ascolto in background) e lo avvia nel player audio.
// Il video YouTube resta nel suo player ufficiale e si ferma in background, come vuole YouTube.
// useBackgroundListen è l'unico flusso: lo usano il pulsante qui sotto e l'avviso al ritorno.
'use client';

import { Headphones, Loader2 } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { audiusToTrack } from '@/components/custom/music/audius-section';
import { jamendoToTrack } from '@/components/custom/music/live-tracks';
import {
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import { type JamendoListResponse, JamendoListResponseSchema } from '@/lib/contracts/library';
import { type MusicSearchResponse, MusicSearchResponseSchema } from '@/lib/contracts/music';
import { backgroundSearchQuery, bestMatch } from '@/lib/music/background-match';
import ctaStyles from './background-switch-notice.module.css';
import styles from './discover.module.css';

export type BackgroundVideo = { videoId: string; title: string; channelTitle: string };

/** A search failed (not "the song is missing"): the listener can simply try again. */
export const SEARCH_ERROR_TEXT = 'Non riesco a cercare il brano adesso. Riprova tra poco.';

export type BackgroundListenOutcome =
  | { status: 'playing'; track: MusicPlayerTrack }
  /** Every search answered and none has this song in a background-capable version. */
  | { status: 'not_found' }
  /** No match, and a search failed (offline, rate limit, catalogue down): worth a retry. */
  | { status: 'error' }
  /** The track changed while searching (the video ended, another song started): nothing done. */
  | { status: 'stale' };

/** A match, no match (`null`), or a search that did not answer (`'error'`). */
type SearchResult = { track: MusicPlayerTrack; path: string } | null | 'error';

async function findAudius(video: BackgroundVideo, query: string): Promise<SearchResult> {
  let response: MusicSearchResponse;
  try {
    response = await apiFetch(`/api/music/search?source=audius&q=${encodeURIComponent(query)}`, {
      schema: MusicSearchResponseSchema,
    });
  } catch {
    // Network error (phone just woken, Wi-Fi ↔ mobile), 429 or 5xx: not "not on Audius".
    return 'error';
  }
  if (response.outcome === 'unavailable') return 'error';
  const candidates = response.tracks.filter((track) => track.playbackEligible);
  const match = bestMatch(video, candidates);
  if (!match) return null;
  return {
    track: audiusToTrack(match),
    path: `/api/music/audius/tracks/${encodeURIComponent(match.id)}/stream`,
  };
}

async function findJamendo(video: BackgroundVideo, query: string): Promise<SearchResult> {
  let response: JamendoListResponse;
  try {
    response = await apiFetch(`/api/music/jamendo?q=${encodeURIComponent(query)}`, {
      schema: JamendoListResponseSchema,
    });
  } catch {
    return 'error';
  }
  if (response.outcome === 'unavailable') return 'error';
  const match = bestMatch(video, response.tracks);
  if (!match) return null;
  const track = jamendoToTrack(match);
  const path = trackStreamPath(track);
  return path ? { track, path } : null;
}

type Availability = 'yes' | 'no' | 'unknown';

// One check per page load: is at least one background-capable catalogue configured? A check that
// fails (offline, 5xx) is 'unknown', is not kept, and is tried again by the next control.
let availability: Promise<Availability> | null = null;
function backgroundSourcesAvailable(): Promise<Availability> {
  const check = (url: string, configured: (body: unknown) => boolean): Promise<Availability> =>
    fetch(url, { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then(
        (body: unknown) => (configured(body) ? 'yes' : 'no'),
        () => 'unknown' as const,
      );
  availability ??= Promise.all([
    check(
      '/api/music/source-status',
      (body) =>
        (body as { sources?: { id?: string; active?: boolean }[] } | null)?.sources?.some(
          (source) => source.id === 'audius' && source.active,
        ) === true,
    ),
    check('/api/music/jamendo?q=test', (body) => {
      const outcome = (body as { outcome?: string } | null)?.outcome;
      return Boolean(outcome) && outcome !== 'not_configured';
    }),
  ]).then(([audius, jamendo]): Availability => {
    if (audius === 'yes' || jamendo === 'yes') return 'yes';
    if (audius === 'unknown' || jamendo === 'unknown') {
      availability = null;
      return 'unknown';
    }
    return 'no';
  });
  return availability;
}

// One search per video at a time, shared by every "Ascolta in background" control and the return
// notice: a second tap (or a tap on the other control) joins the pending search instead of
// starting another search and another playTrack (which would restart the audio).
const inFlight = new Map<string, Promise<BackgroundListenOutcome>>();
const inFlightListeners = new Set<() => void>();

function subscribeInFlight(listener: () => void) {
  inFlightListeners.add(listener);
  return () => {
    inFlightListeners.delete(listener);
  };
}

function notifyInFlight() {
  for (const listener of inFlightListeners) listener();
}

/**
 * The background-listen flow. `start` must be called synchronously from a tap handler (never
 * without a tap): it unlocks the shared <audio> element first, because the searches take a
 * network round trip after which iOS no longer treats play() as part of the tap
 * (NotAllowedError on the first background switch). The 'playback' audio session is declared by
 * the player right before play(), so a search that finds nothing leaves the YouTube video with
 * the browser's default session.
 */
export function useBackgroundListen(video: BackgroundVideo) {
  const player = useMusicPlayer();
  const videoId = video.videoId;
  const searching = useSyncExternalStore(
    subscribeInFlight,
    () => inFlight.has(videoId),
    () => false,
  );
  // 'unknown' finché il controllo dei cataloghi non ha risposto.
  const [availability, setAvailability] = useState<'unknown' | 'yes' | 'no'>('unknown');
  const available = availability === 'yes';

  useEffect(() => {
    let cancelled = false;
    void backgroundSourcesAvailable().then((value) => !cancelled && setAvailability(value));
    return () => {
      cancelled = true;
    };
  }, []);

  const start = (): Promise<BackgroundListenOutcome> => {
    // Already searching this video (other control, double tap): same search, same outcome.
    const pending = inFlight.get(videoId);
    if (pending) return pending;
    // First statement of the tap: nothing awaited before it.
    player.primeAudio();
    const run = async (): Promise<BackgroundListenOutcome> => {
      const query = backgroundSearchQuery(video.title, video.channelTitle);
      const audius = await findAudius(video, query);
      const found = audius && audius !== 'error' ? audius : await findJamendo(video, query);
      // Read now, not from the tap's render: the listener may have moved on while we searched.
      if (player.isCurrentTrack && !player.isCurrentTrack(`youtube:${videoId}`)) {
        return { status: 'stale' };
      }
      if (found && found !== 'error') {
        // Al posto del video, nello stesso punto della coda: il resto della coda resta.
        if (player.replaceCurrentTrack) await player.replaceCurrentTrack(found.track, found.path);
        else await player.playTrack(found.track, found.path, [found.track]);
        return { status: 'playing', track: found.track };
      }
      // "Not found" only when every search answered: a failed one may still have the song.
      return audius === 'error' || found === 'error'
        ? { status: 'error' }
        : { status: 'not_found' };
    };
    const promise = run().finally(() => {
      inFlight.delete(videoId);
      notifyInFlight();
    });
    inFlight.set(videoId, promise);
    notifyInFlight();
    return promise;
  };

  return { available, availability, searching, start };
}

export function BackgroundListenButton({
  video,
  compact = true,
  hint,
  className,
}: {
  video: BackgroundVideo;
  /** true: solo icona (elenchi, mini player); false: pulsante con testo (player). */
  compact?: boolean;
  /** Breve spiegazione: visibile sotto il testo (compact=false), come suggerimento altrimenti. */
  hint?: string;
  /** Sostituisce lo stile predefinito (es. il mini player). */
  className?: string;
}) {
  const { available, searching, start } = useBackgroundListen(video);

  // Hidden until Audius or Jamendo is configured: nothing to switch to before that.
  if (!available) return null;

  const listen = () => {
    start().then(
      (outcome) => {
        if (outcome.status === 'stale') return;
        if (outcome.status === 'error') {
          toast(SEARCH_ERROR_TEXT);
          return;
        }
        if (outcome.status === 'not_found') {
          toast('Questo brano non è disponibile per l’ascolto in background.', {
            description: 'Lo trovi solo come video YouTube, che si ferma quando chiudi Solco.',
          });
          return;
        }
        toast.success(`In background: ${outcome.track.title} · ${outcome.track.sourceLabel}`);
      },
      () => undefined,
    );
  };

  const icon = searching ? (
    <Loader2 aria-hidden="true" className={styles.spin} />
  ) : (
    <Headphones aria-hidden="true" />
  );

  if (compact) {
    return (
      <button
        type="button"
        className={className ?? styles.iconButton}
        onClick={listen}
        disabled={searching}
        aria-label={`Ascolta ${video.title} in background`}
        title={hint ? `Ascolta in background: ${hint}` : 'Ascolta in background'}
      >
        {icon}
      </button>
    );
  }

  if (hint) {
    // aria-disabled (not disabled) while searching: the focused button keeps focus.
    return (
      <button
        type="button"
        className={className ?? ctaStyles.cta}
        onClick={() => {
          if (!searching) listen();
        }}
        aria-disabled={searching || undefined}
      >
        {icon}
        <span className={ctaStyles.ctaCopy}>
          <span>{searching ? 'Cerco…' : 'Ascolta in background'}</span>
          <small>{hint}</small>
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={className ?? styles.backgroundButton}
      onClick={listen}
      disabled={searching}
      aria-label={`Ascolta ${video.title} in background`}
      title="Ascolta in background"
    >
      {icon}
      <span>{searching ? 'Cerco…' : 'Ascolta in background'}</span>
    </button>
  );
}
