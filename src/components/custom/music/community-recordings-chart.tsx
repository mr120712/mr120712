// @polsia:user-owned — "Classifica della community": i brani che gli utenti hanno PUBBLICATO,
// ordinati per ascolti totali. Visibile a tutti; l'ascolto e la segnalazione richiedono il login.
'use client';

import { Flag, Pause, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useLibrary } from '@/components/custom/music/library-context';
import {
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import { type RecordingChartItem, RecordingChartResponseSchema } from '@/lib/contracts/recordings';
import styles from './recordings-chart.module.css';

function toTrack(item: RecordingChartItem): MusicPlayerTrack {
  return {
    qualifiedId: `recording:${item.id}`,
    title: item.title,
    artistName: 'Caricato dalla community',
    artworkUrl: null,
    sourceLabel: 'Registrazione',
    sourceUrl: null,
    durationSeconds: item.durationSeconds,
    playbackMode: 'recording',
  };
}

export function CommunityRecordingsChart() {
  const library = useLibrary();
  const player = useMusicPlayer();
  const [items, setItems] = useState<RecordingChartItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/music/recordings/chart/public', { schema: RecordingChartResponseSchema })
      .then((value) => {
        if (!cancelled) setItems(value.items);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!items || items.length === 0) return null;

  const queue = items.map(toTrack);
  const play = (item: RecordingChartItem) => {
    if (!library.signedIn) {
      toast.error('Accedi per ascoltare i brani della community.');
      return;
    }
    const track = toTrack(item);
    if (player.currentTrack?.qualifiedId === track.qualifiedId) {
      void player.togglePlayback();
      return;
    }
    const path = trackStreamPath(track);
    if (path) void player.playTrack(track, path, queue);
  };

  const report = async (item: RecordingChartItem) => {
    if (!library.signedIn) {
      toast.error('Accedi per segnalare un brano.');
      return;
    }
    try {
      await apiFetch(`/api/music/recordings/${item.id}/report`, { method: 'POST' });
      toast.success('Segnalazione inviata. Grazie per l’aiuto.');
    } catch {
      toast.error('Non è stato possibile inviare la segnalazione.');
    }
  };

  return (
    <section className={styles.section} aria-labelledby="community-chart-heading">
      <header className={styles.header}>
        <p className={styles.eyebrow}>DALLA COMMUNITY</p>
        <h2 id="community-chart-heading">Classifica dei brani pubblicati</h2>
      </header>
      <ol className={styles.list}>
        {items.map((item, index) => {
          const qualifiedId = `recording:${item.id}`;
          const playing =
            player.currentTrack?.qualifiedId === qualifiedId && player.status === 'playing';
          return (
            <li key={item.id} className={styles.row}>
              <span className={styles.rank}>{index + 1}</span>
              <button
                type="button"
                className={styles.play}
                onClick={() => play(item)}
                aria-label={playing ? `Metti in pausa ${item.title}` : `Riproduci ${item.title}`}
              >
                {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              </button>
              <div className={styles.copy}>
                <strong title={item.title}>{item.title}</strong>
                <span>{item.playCount === 1 ? '1 ascolto' : `${item.playCount} ascolti`}</span>
              </div>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.report}
                  onClick={() => void report(item)}
                  aria-label={`Segnala ${item.title}`}
                  title="Segnala"
                >
                  <Flag aria-hidden="true" size={16} />
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
