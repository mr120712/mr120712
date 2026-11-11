// @polsia:user-owned
'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { AlbumCard } from '@/components/custom/music/album-card';
import { type MusicPlayerTrack, useMusicPlayer } from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import {
  type AudiusTrackSearchResult,
  type MusicTrendingResponse,
  MusicTrendingResponseSchema,
} from '@/lib/contracts/music';
import { getAudiusPlaybackReasonText } from '@/lib/music/audius';
import styles from './home-trending.module.css';

export function HomeTrending() {
  const player = useMusicPlayer();
  const [response, setResponse] = useState<MusicTrendingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    void apiFetch('/api/music/trending', { schema: MusicTrendingResponseSchema })
      .then((value) => {
        if (active) setResponse(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const tracks = response?.tracks ?? [];
  const albums = response?.albums ?? [];
  const queue: MusicPlayerTrack[] = tracks
    .filter((track) => track.playbackEligible)
    .map((track) => ({
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
    }));
  const playTrack = (track: AudiusTrackSearchResult) => {
    if (!track.playbackEligible) return;
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
  const message = failed
    ? 'Le tendenze Audius non sono disponibili in questo momento.'
    : response?.outcome === 'unavailable'
      ? response.sourceStatus.unavailableReason === 'not_configured'
        ? 'Configura AUDIUS_API_KEY nei segreti server-side per caricare le tendenze Audius.'
        : 'Audius non ha restituito le tendenze. Riprova più tardi.'
      : response?.outcome === 'no_results'
        ? 'Audius non ha restituito brani di tendenza.'
        : null;

  return (
    <div className={styles.content}>
      {loading ? <output className={styles.state}>Caricamento tendenze Audius…</output> : null}
      {!loading && message ? (
        <output className={styles.state}>
          <p>{message}</p>
          <button type="button" onClick={() => window.location.reload()}>
            Riprova
          </button>
        </output>
      ) : null}
      {albums.length ? (
        <div className={styles.albums}>
          <h3>Album da esplorare</h3>
          <div className={styles.albumGrid}>
            {albums.map((album) => (
              <AlbumCard key={album.id} album={album} />
            ))}
          </div>
        </div>
      ) : null}
      {tracks.length ? (
        <ul className={styles.trackList}>
          {tracks.map((track, index) => {
            return (
              <li className={styles.track} key={track.qualifiedId}>
                <span className={styles.index}>{String(index + 1).padStart(2, '0')}</span>
                <span className={styles.artwork}>
                  <Image
                    src={track.artworkUrl}
                    alt={`Copertina di ${track.title}`}
                    width={72}
                    height={72}
                    unoptimized
                  />
                </span>
                <span className={styles.trackCopy}>
                  <span className={styles.source}>Solco · Audius</span>
                  <strong>{track.title}</strong>
                  {track.artistUrl ? (
                    <a href={track.artistUrl} target="_blank" rel="noreferrer">
                      {track.artistName ?? track.artistHandle ?? 'Artista Audius'}
                    </a>
                  ) : (
                    <span>{track.artistName ?? track.artistHandle ?? 'Artista Audius'}</span>
                  )}
                  <a href={track.trackUrl} target="_blank" rel="noreferrer">
                    Apri il brano su Audius
                  </a>
                  {track.playbackEligible ? (
                    <button
                      type="button"
                      disabled={player.status === 'loading'}
                      onClick={() => playTrack(track)}
                    >
                      {player.currentTrack?.qualifiedId === track.qualifiedId
                        ? player.status === 'playing'
                          ? 'Pausa'
                          : 'Riprendi'
                        : 'Riproduci'}
                    </button>
                  ) : (
                    <span className={styles.unavailable}>
                      {getAudiusPlaybackReasonText(track.playbackReason)}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
