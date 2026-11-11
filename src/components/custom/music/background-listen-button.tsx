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
  | { status: 'error' };

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

// One check per page load: is at least one background-capable catalogue configured?
let availability: Promise<boolean> | null = null;
function backgroundSourcesAvailable() {
  availability ??= Promise.all([
    fetch('/api/music/source-status', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (body: { sources?: { id?: string; active?: boolean }[] } | null) =>
          body?.sources?.some((source) => source.id === 'audius' && source.active) === true,
      )
      .catch(() => false),
    fetch('/api/music/jamendo?q=test', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (body: { outcome?: string } | null) =>
          Boolean(body?.outcome) && body?.outcome !== 'not_configured',
      )
      .catch(() => false),
  ]).then(([audius, jamendo]) => audius || jamendo);
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
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void backgroundSourcesAvailable().then((value) => !cancelled && setAvailable(value));
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
      if (found && found !== 'error') {
        await player.playTrack(found.track, found.path, [found.track]);
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

  return { available, searching, start };
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
