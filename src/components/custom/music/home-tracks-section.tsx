// @polsia:user-owned — sezione "In evidenza" in Home: i file audio messi dall'amministratore
// direttamente nello store Vercel Blob (dal pannello), riproducibili con il player. Si nasconde
// del tutto se non ce ne sono (nessun ingombro in Home).
'use client';

import { Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { homeTrackToTrack } from '@/components/custom/music/live-tracks';
import { useMusicPlayer } from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import { type HomeTrack, HomeTracksResponseSchema } from '@/lib/contracts/home-tracks';
import styles from './home-tracks-section.module.css';

export function HomeTracksSection() {
  const player = useMusicPlayer();
  const [items, setItems] = useState<HomeTrack[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(async () => {
    try {
      const { items: list } = await apiFetch('/api/music/home-tracks', {
        schema: HomeTracksResponseSchema,
      });
      setItems(list);
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const play = (item: HomeTrack) => {
    const track = homeTrackToTrack(item);
    if (player.currentTrack?.qualifiedId === track.qualifiedId) {
      void player.togglePlayback();
      return;
    }
    const queue = items.map(homeTrackToTrack);
    void player.playTrack(track, track.streamUrl ?? '', queue);
  };

  // Si nasconde finché carica, in errore o se vuota: nessun ingombro in Home.
  if (state !== 'ready' || items.length === 0) return null;

  return (
    <section id="in-evidenza" className={styles.section} aria-labelledby="in-evidenza-heading">
      <div className={styles.head}>
        <p className={styles.eyebrow}>IN EVIDENZA</p>
        <h2 id="in-evidenza-heading" className={styles.title}>
          Ascolta ora
        </h2>
      </div>
      <ul className={styles.list}>
        {items.map((item) => {
          const qualifiedId = `upload:${item.id}`;
          const playing =
            player.currentTrack?.qualifiedId === qualifiedId && player.status === 'playing';
          return (
            <li key={item.id} className={styles.row}>
              <button
                type="button"
                className={styles.playButton}
                onClick={() => play(item)}
                aria-label={playing ? `Metti in pausa ${item.title}` : `Riproduci ${item.title}`}
              >
                {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              </button>
              <div className={styles.copy}>
                <strong className={styles.title2} title={item.title}>
                  {item.title}
                </strong>
                <span className={styles.meta}>{item.artist ?? 'Solco'}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
