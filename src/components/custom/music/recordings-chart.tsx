// @polsia:user-owned — "Classifica ascolti locali": i brani che l'utente ha caricato (le sue
// registrazioni) ordinati per numero di ascolti. Solo con accesso; nascosta se non ce ne sono.
'use client';

import { Pause, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
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
    artistName: 'La tua registrazione',
    artworkUrl: null,
    sourceLabel: 'Registrazione',
    sourceUrl: null,
    durationSeconds: item.durationSeconds,
    playbackMode: 'recording',
  };
}

export function RecordingsChart() {
  const library = useLibrary();
  const player = useMusicPlayer();
  const [items, setItems] = useState<RecordingChartItem[] | null>(null);

  useEffect(() => {
    if (!library.signedIn) {
      setItems(null);
      return;
    }
    let cancelled = false;
    apiFetch('/api/music/recordings/chart', { schema: RecordingChartResponseSchema })
      .then((value) => {
        if (!cancelled) setItems(value.items);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [library.signedIn]);

  if (!library.signedIn || !items || items.length === 0) return null;

  const queue = items.map(toTrack);
  const play = (item: RecordingChartItem) => {
    const track = toTrack(item);
    if (player.currentTrack?.qualifiedId === track.qualifiedId) {
      void player.togglePlayback();
      return;
    }
    const path = trackStreamPath(track);
    if (path) void player.playTrack(track, path, queue);
  };

  return (
    <section className={styles.section} aria-labelledby="rec-chart-heading">
      <header className={styles.header}>
        <p className={styles.eyebrow}>I TUOI BRANI CARICATI</p>
        <h2 id="rec-chart-heading">Classifica ascolti locali</h2>
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
            </li>
          );
        })}
      </ol>
    </section>
  );
}
