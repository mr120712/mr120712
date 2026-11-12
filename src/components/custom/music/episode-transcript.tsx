// @polsia:user-owned — trascrizione di un episodio podcast (tag podcast:transcript del feed).
// Mostra il testo; se è temporizzato e l'episodio è quello in ascolto, evidenzia il segmento
// corrente e un clic salta a quel punto (come "segui la trascrizione" di Spotify).
'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import {
  type PodcastTranscriptResponse,
  PodcastTranscriptResponseSchema,
} from '@/lib/contracts/library';
import styles from './episode-transcript.module.css';

type LoadState = 'loading' | 'ready' | 'empty' | 'error';

export function EpisodeTranscript({
  podcastId,
  episodeKey,
  isCurrent,
  elapsedSeconds,
  onSeek,
}: {
  podcastId: string;
  episodeKey: string;
  /** L'episodio è quello attualmente in riproduzione (abilita sincronizzazione e salto). */
  isCurrent: boolean;
  elapsedSeconds: number;
  onSeek: (seconds: number) => void;
}) {
  const [data, setData] = useState<PodcastTranscriptResponse | null>(null);
  const [state, setState] = useState<LoadState>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setData(null);
    apiFetch(
      `/api/music/podcasts/${encodeURIComponent(podcastId)}/episodes/${encodeURIComponent(
        episodeKey,
      )}/transcript`,
      { schema: PodcastTranscriptResponseSchema },
    )
      .then((value) => {
        if (cancelled) return;
        setData(value);
        setState(value.available && value.cues.length > 0 ? 'ready' : 'empty');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [podcastId, episodeKey]);

  // Segmento attivo: l'ultimo il cui inizio è già passato (solo se temporizzato e in ascolto).
  const activeIndex = useMemo(() => {
    if (!data || !data.timed || !isCurrent) return -1;
    let index = -1;
    for (let i = 0; i < data.cues.length; i += 1) {
      const start = data.cues[i]?.startSeconds;
      if (start === null || start === undefined) continue;
      if (start <= elapsedSeconds) index = i;
      else break;
    }
    return index;
  }, [data, isCurrent, elapsedSeconds]);

  if (state === 'loading') {
    return <p className={styles.state}>Caricamento della trascrizione…</p>;
  }
  if (state === 'error') {
    return <p className={styles.state}>Trascrizione non disponibile in questo momento.</p>;
  }
  if (state === 'empty' || !data) {
    return <p className={styles.state}>Questo episodio non ha una trascrizione leggibile.</p>;
  }

  const canSeek = data.timed && isCurrent;

  return (
    <div className={styles.panel}>
      {data.cues.map((cue, index) => {
        const active = index === activeIndex;
        const className = `${styles.cue} ${active ? styles.active : ''}`.trim();
        if (canSeek && cue.startSeconds !== null) {
          const seconds = cue.startSeconds;
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: i cue sono una lista statica e ordinata.
              key={index}
              type="button"
              className={className}
              aria-current={active ? 'true' : undefined}
              onClick={() => onSeek(seconds)}
            >
              {cue.text}
            </button>
          );
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: i cue sono una lista statica e ordinata.
          <p key={index} className={className}>
            {cue.text}
          </p>
        );
      })}
      <p className={styles.credit}>Trascrizione fornita dall’editore del podcast.</p>
    </div>
  );
}
