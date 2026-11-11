// @polsia:user-owned
'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AudiusLicenseNotice } from '@/components/custom/music/audius-license-notice';
import { type MusicPlayerTrack, useMusicPlayer } from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import {
  type AudiusAlbumDetail,
  AudiusAlbumDetailSchema,
  type AudiusAlbumTrack,
} from '@/lib/contracts/music';
import { getAudiusPlaybackReasonText } from '@/lib/music/audius';
import styles from './album-detail.module.css';

function playbackLabel(track: AudiusAlbumTrack) {
  // Alternative licence (not the Audius Open Music License): listen on Audius only.
  if (track.fullAccess !== 'available' && track.playbackReason === 'license_not_allowed') {
    return getAudiusPlaybackReasonText('license_not_allowed');
  }
  switch (track.fullAccess) {
    case 'available':
      return 'Audius conferma lo streaming pubblico';
    case 'rights_unverified':
      return 'Fonte o diritti Solco non verificati';
    case 'unavailable':
      return 'Ascolto integrale non disponibile';
    case 'pro_required':
      return 'Richiede un accesso Audius non disponibile';
  }
}

function playerTrack(track: AudiusAlbumTrack, album: AudiusAlbumDetail['album']): MusicPlayerTrack {
  return {
    qualifiedId: track.qualifiedId,
    albumId: album.id,
    playbackMode: 'audius',
    title: track.title,
    artistName: track.artistName,
    artistUrl: track.artistUrl,
    artworkUrl: track.artworkUrl,
    sourceLabel: 'Solco · Audius',
    sourceUrl: track.trackUrl,
    sourceUrlLabel: 'Apri il brano su Audius',
    durationSeconds: track.durationSeconds,
  };
}

export function AlbumDetail({ albumId }: { albumId: string }) {
  const [detail, setDetail] = useState<AudiusAlbumDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const player = useMusicPlayer();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setUnavailable(false);
    void apiFetch(`/api/music/albums/${encodeURIComponent(albumId)}`, {
      schema: AudiusAlbumDetailSchema,
    })
      .then((result) => {
        if (active) setDetail(result);
      })
      .catch(() => {
        if (active) {
          setDetail(null);
          setUnavailable(true);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [albumId]);

  async function play(track: AudiusAlbumTrack) {
    if (!detail || track.fullAccess !== 'available') return;
    const queue = detail.tracks
      .filter((item) => item.fullAccess === 'available')
      .map((item) => playerTrack(item, detail.album));
    const selected = playerTrack(track, detail.album);
    await player.playTrack(
      selected,
      `/api/music/audius/tracks/${encodeURIComponent(track.id)}/stream`,
      queue,
    );
  }

  return (
    <main className={styles.page}>
      <Link className={styles.backLink} href="/search">
        Torna alla ricerca
      </Link>
      {loading ? (
        <output className={styles.state}>Caricamento dei metadati e dello stato Audius…</output>
      ) : null}
      {!loading && unavailable ? (
        <section className={styles.statePanel}>
          <h1>Album non disponibile</h1>
          <p>
            Audius non ha restituito metadati e tracklist verificabili per questo album. Solco non
            mostra brani sostitutivi.
          </p>
        </section>
      ) : null}
      {!loading && detail ? (
        <>
          <header className={styles.albumHeader}>
            <div className={styles.cover}>
              {detail.album.artworkUrl ? (
                <Image
                  src={detail.album.artworkUrl}
                  alt={`Copertina di ${detail.album.title}`}
                  width={480}
                  height={480}
                  unoptimized
                  priority
                />
              ) : (
                <span aria-hidden="true">S</span>
              )}
            </div>
            <div className={styles.albumCopy}>
              <p className={styles.eyebrow}>ALBUM · AUDIUS</p>
              <h1>{detail.album.title}</h1>
              <p>{detail.album.artistName ?? 'Artista non indicato da Audius'}</p>
              <div className={styles.albumMeta}>
                {detail.album.releaseDate ? <span>Uscita · {detail.album.releaseDate}</span> : null}
                {detail.album.trackCount !== null ? (
                  <span>{detail.album.trackCount} brani</span>
                ) : null}
              </div>
              <a href={detail.album.albumUrl} target="_blank" rel="noreferrer">
                Scheda originale su Audius
              </a>
            </div>
          </header>

          <section className={styles.trackSection} aria-labelledby="tracklist-title">
            <div className={styles.sectionHeading}>
              <div>
                <p className={styles.eyebrow}>METADATI DEL CATALOGO</p>
                <h2 id="tracklist-title">Tracklist</h2>
              </div>
              <p>
                Audius viene consultato dal server prima di ogni ascolto e richiesta audio. I brani
                pubblici e riproducibili non richiedono Solco Pro né un album verificato.
              </p>
            </div>
            {detail.tracks.length === 0 ? (
              <p className={styles.state}>
                Il catalogo non ha restituito una tracklist per questo album.
              </p>
            ) : (
              <ol className={styles.trackList}>
                {detail.tracks.map((track, index) => (
                  <li className={styles.track} key={track.id}>
                    <span className={styles.trackNumber}>{String(index + 1).padStart(2, '0')}</span>
                    <span className={styles.trackArtwork}>
                      <Image
                        src={track.artworkUrl}
                        alt={`Copertina di ${track.title}`}
                        width={52}
                        height={52}
                        unoptimized
                      />
                    </span>
                    <div className={styles.trackCopy}>
                      <strong>{track.title}</strong>
                      <a href={track.artistUrl} target="_blank" rel="noreferrer">
                        {track.artistName}
                      </a>
                      <span
                        className={
                          track.fullAccess === 'available' ? styles.available : styles.blocked
                        }
                      >
                        {playbackLabel(track)}
                      </span>
                      {track.fullAccess !== 'available' &&
                      track.playbackReason === 'license_not_allowed' ? (
                        <a href={track.trackUrl} target="_blank" rel="noreferrer">
                          Ascolta su Audius
                        </a>
                      ) : (
                        <AudiusLicenseNotice track={track} showTrackLink />
                      )}
                    </div>
                    {track.fullAccess === 'available' ? (
                      <button
                        className={styles.playButton}
                        type="button"
                        onClick={() => {
                          if (player.currentTrack?.qualifiedId === track.qualifiedId) {
                            void player.togglePlayback();
                            return;
                          }
                          void play(track);
                        }}
                        disabled={
                          player.status === 'loading' &&
                          player.currentTrack?.qualifiedId === track.qualifiedId
                        }
                      >
                        {player.currentTrack?.qualifiedId === track.qualifiedId
                          ? player.status === 'playing'
                            ? 'Pausa'
                            : 'Riprendi'
                          : 'Ascolta'}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      ) : null}
    </main>
  );
}
