// @polsia:user-owned — riga "Ascoltati di recente" (cronologia della Libreria, solo con accesso).
'use client';

import { Pause, Play } from 'lucide-react';
import Link from 'next/link';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { useLibrary } from '@/components/custom/music/library-context';
import { historyToTrack } from '@/components/custom/music/live-tracks';
import { trackStreamPath, useMusicPlayer } from '@/components/custom/music/music-player';
import type { HistoryEntry } from '@/lib/contracts/library';
import styles from './discover.module.css';

export function useHistoryPlayback() {
  const player = useMusicPlayer();
  return {
    isPlaying: (entry: HistoryEntry) =>
      player.currentTrack?.qualifiedId === entry.qualifiedId && player.status === 'playing',
    play: (entry: HistoryEntry, queue: HistoryEntry[] = [entry]) => {
      if (player.currentTrack?.qualifiedId === entry.qualifiedId) {
        void player.togglePlayback();
        return;
      }
      const track = historyToTrack(entry);
      const path = trackStreamPath(track);
      if (path) void player.playTrack(track, path, queue.map(historyToTrack));
    },
  };
}

export function RecentlyPlayedRow() {
  const library = useLibrary();
  const playback = useHistoryPlayback();
  const entries = library.library.history.slice(0, 12);
  if (!library.signedIn || entries.length === 0) return null;

  return (
    <section
      className={`${styles.section} ${styles.contained}`}
      id="recenti"
      aria-labelledby="recent-heading"
    >
      <header className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>LA TUA MUSICA</p>
          <h2 id="recent-heading">Ascoltati di recente</h2>
        </div>
        <Link href="/library?tab=cronologia">Cronologia</Link>
      </header>
      <div className={styles.rail}>
        {entries.map((entry) => {
          const playing = playback.isPlaying(entry);
          return (
            <article key={entry.qualifiedId} className={styles.tile}>
              <div className={styles.tileArt}>
                <FallbackArt src={entry.artworkUrl} label={entry.title} size={240} />
                <button
                  type="button"
                  className={styles.tilePlay}
                  onClick={() => playback.play(entry, entries)}
                  aria-label={
                    playing ? `Metti in pausa ${entry.title}` : `Riproduci ${entry.title}`
                  }
                >
                  {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                </button>
              </div>
              <strong className={styles.tileTitle} title={entry.title}>
                {entry.title}
              </strong>
              <span className={styles.tileMeta}>
                {entry.artistName} · {entry.sourceLabel}
              </span>
            </article>
          );
        })}
      </div>
    </section>
  );
}
