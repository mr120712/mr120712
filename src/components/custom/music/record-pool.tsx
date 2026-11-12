// @polsia:user-owned — Record Pool: brani royalty-free (Open Music License) che l'artista ha
// reso scaricabili su Audius. Si ascoltano e si scaricano dentro Solco; ogni brano mostra la
// licenza. Niente servizi esterni al download: la rotta Audius riverifica la scaricabilità.
'use client';

import { Music2, Pause, Play } from 'lucide-react';
import Image from 'next/image';
import { useEffect, useState } from 'react';
import { useLibrary } from '@/components/custom/music/library-context';
import { type MusicPlayerTrack, useMusicPlayer } from '@/components/custom/music/music-player';
import { SingleOfflineDownloadButton } from '@/components/custom/music/offline-download-button';
import { apiFetch } from '@/lib/api-client';
import type { AudiusTrackSearchResult } from '@/lib/contracts/music';
import { type RecordPoolResponse, RecordPoolResponseSchema } from '@/lib/contracts/record-pool';
import { RECORD_POOL_GENRES } from '@/lib/music/record-pool';
import styles from './record-pool.module.css';

function toTrack(track: AudiusTrackSearchResult): MusicPlayerTrack {
  return {
    qualifiedId: track.qualifiedId,
    title: track.title,
    artistName: track.artistName,
    artistUrl: track.artistUrl,
    artworkUrl: track.artworkUrl,
    sourceLabel: 'Solco · Audius',
    sourceUrl: track.trackUrl,
    sourceUrlLabel: 'Apri il brano su Audius',
    durationSeconds: track.durationSeconds,
    playbackMode: 'audius',
  };
}

function formatDuration(seconds: number | null) {
  if (seconds === null || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function RecordPool() {
  const library = useLibrary();
  const player = useMusicPlayer();
  const [genre, setGenre] = useState<string | null>(null);
  const [data, setData] = useState<RecordPoolResponse | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setData(null);
    const query = genre ? `?genre=${encodeURIComponent(genre)}` : '';
    apiFetch(`/api/music/pool${query}`, { schema: RecordPoolResponseSchema })
      .then((value) => {
        if (!cancelled) {
          setData(value);
          setState('ready');
        }
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [genre]);

  const tracks = data?.tracks ?? [];
  const queue = tracks.map(toTrack);

  const play = (track: AudiusTrackSearchResult) => {
    if (player.currentTrack?.qualifiedId === track.qualifiedId) {
      void player.togglePlayback();
      return;
    }
    const selected = queue.find((item) => item.qualifiedId === track.qualifiedId);
    if (!selected) return;
    void player.playTrack(
      selected,
      `/api/music/audius/tracks/${encodeURIComponent(track.id)}/stream`,
      queue,
    );
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.pageTitle}>Record Pool</h1>
        <p className={styles.lead}>
          Brani royalty-free che gli artisti hanno reso scaricabili su Audius (Open Music License).
          Ascoltali e scaricali dentro Solco: niente servizi esterni, nessun problema di diritti.
        </p>
      </header>

      <fieldset className={styles.chips}>
        <legend className={styles.srOnly}>Filtra per genere</legend>
        <button
          type="button"
          className={`${styles.chip} ${genre === null ? styles.chipActive : ''}`.trim()}
          aria-pressed={genre === null}
          onClick={() => setGenre(null)}
        >
          Tutti
        </button>
        {RECORD_POOL_GENRES.map((entry) => (
          <button
            key={entry.slug}
            type="button"
            className={`${styles.chip} ${genre === entry.slug ? styles.chipActive : ''}`.trim()}
            aria-pressed={genre === entry.slug}
            onClick={() => setGenre(entry.slug)}
          >
            {entry.label}
          </button>
        ))}
      </fieldset>

      {state === 'loading' ? (
        <p className={styles.state}>Caricamento del pool…</p>
      ) : state === 'error' || data?.outcome === 'unavailable' ? (
        <p className={styles.state}>Il pool non è raggiungibile in questo momento. Riprova.</p>
      ) : data?.outcome === 'inactive' ? (
        <p className={styles.state}>La sorgente musicale non è attiva al momento.</p>
      ) : tracks.length === 0 ? (
        <p className={styles.state}>
          Nessun brano scaricabile per questo genere adesso. Prova un altro genere.
        </p>
      ) : (
        <ul className={styles.list}>
          {tracks.map((track) => {
            const playing =
              player.currentTrack?.qualifiedId === track.qualifiedId && player.status === 'playing';
            const duration = formatDuration(track.durationSeconds);
            return (
              <li key={track.id} className={styles.row}>
                <button
                  type="button"
                  className={styles.playButton}
                  onClick={() => play(track)}
                  aria-label={
                    playing ? `Metti in pausa ${track.title}` : `Riproduci ${track.title}`
                  }
                >
                  {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                </button>
                <div className={styles.cover}>
                  {track.artworkUrl ? (
                    <Image
                      src={track.artworkUrl}
                      alt={`Copertina di ${track.title}`}
                      width={48}
                      height={48}
                      unoptimized
                    />
                  ) : (
                    <Music2 aria-hidden="true" />
                  )}
                </div>
                <div className={styles.copy}>
                  <strong title={track.title}>{track.title}</strong>
                  <span className={styles.artist}>{track.artistName}</span>
                  <div className={styles.badges}>
                    {track.genre ? <span className={styles.badge}>{track.genre}</span> : null}
                    {typeof track.bpm === 'number' && track.bpm > 0 ? (
                      <span className={styles.badge}>{Math.round(track.bpm)} BPM</span>
                    ) : null}
                    {track.musicalKey ? (
                      <span className={styles.badge}>{track.musicalKey}</span>
                    ) : null}
                    {duration ? <span className={styles.badge}>{duration}</span> : null}
                  </div>
                  {track.trackUrl ? (
                    <a
                      className={styles.license}
                      href={track.trackUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {track.license ? `Licenza: ${track.license}` : 'Scheda su Audius'}
                    </a>
                  ) : null}
                </div>
                <div className={styles.actions}>
                  <SingleOfflineDownloadButton
                    target={{
                      id: track.id,
                      title: track.title,
                      endpoint: { kind: 'audius', trackId: track.id },
                    }}
                    signedIn={library.signedIn}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
