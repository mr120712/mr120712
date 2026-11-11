// @polsia:user-owned — "Ascolta in background": cerca lo stesso brano di un video YouTube su
// Audius o Jamendo (licenze che consentono l'ascolto in background) e lo avvia nel player audio.
// Il video YouTube resta nel suo player ufficiale e si ferma in background, come vuole YouTube.
'use client';

import { Headphones, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { audiusToTrack } from '@/components/custom/music/audius-section';
import { jamendoToTrack } from '@/components/custom/music/live-tracks';
import { trackStreamPath, useMusicPlayer } from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import { JamendoListResponseSchema } from '@/lib/contracts/library';
import { MusicSearchResponseSchema } from '@/lib/contracts/music';
import { backgroundSearchQuery, bestMatch } from '@/lib/music/background-match';
import styles from './discover.module.css';

export type BackgroundVideo = { videoId: string; title: string; channelTitle: string };

async function findAudius(video: BackgroundVideo, query: string) {
  const response = await apiFetch(
    `/api/music/search?source=audius&q=${encodeURIComponent(query)}`,
    { schema: MusicSearchResponseSchema },
  ).catch(() => null);
  const candidates = (response?.tracks ?? []).filter((track) => track.playbackEligible);
  const match = bestMatch(video, candidates);
  if (!match) return null;
  return {
    track: audiusToTrack(match),
    path: `/api/music/audius/tracks/${encodeURIComponent(match.id)}/stream`,
  };
}

async function findJamendo(video: BackgroundVideo, query: string) {
  const response = await apiFetch(`/api/music/jamendo?q=${encodeURIComponent(query)}`, {
    schema: JamendoListResponseSchema,
  }).catch(() => null);
  const match = bestMatch(video, response?.tracks ?? []);
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

export function BackgroundListenButton({
  video,
  compact = true,
}: {
  video: BackgroundVideo;
  /** true: solo icona (elenchi); false: pulsante con testo (player). */
  compact?: boolean;
}) {
  const player = useMusicPlayer();
  const [searching, setSearching] = useState(false);
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void backgroundSourcesAvailable().then((value) => !cancelled && setAvailable(value));
    return () => {
      cancelled = true;
    };
  }, []);

  const listen = async () => {
    setSearching(true);
    try {
      const query = backgroundSearchQuery(video.title, video.channelTitle);
      const found = (await findAudius(video, query)) ?? (await findJamendo(video, query));
      if (!found) {
        toast('Questo brano non è disponibile per l’ascolto in background.', {
          description: 'Lo trovi solo come video YouTube, che si ferma quando chiudi Solco.',
        });
        return;
      }
      await player.playTrack(found.track, found.path, [found.track]);
      toast.success(`In background: ${found.track.title} · ${found.track.sourceLabel}`);
    } finally {
      setSearching(false);
    }
  };

  // Hidden until Audius or Jamendo is configured: nothing to switch to before that.
  if (!available) return null;

  const label = `Ascolta ${video.title} in background`;
  return (
    <button
      type="button"
      className={compact ? styles.iconButton : styles.backgroundButton}
      onClick={() => void listen()}
      disabled={searching}
      aria-label={label}
      title="Ascolta in background"
    >
      {searching ? (
        <Loader2 aria-hidden="true" className={styles.spin} />
      ) : (
        <Headphones aria-hidden="true" />
      )}
      {compact ? null : <span>{searching ? 'Cerco…' : 'Ascolta in background'}</span>}
    </button>
  );
}
