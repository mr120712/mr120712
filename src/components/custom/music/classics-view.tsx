// @polsia:user-owned — "Classici per decennio": playlist a tema (Anni 60/70/80/90) costruite dal
// catalogo lecito di Solco (Audius, artisti indie/CC). Scoperta e ascolto; NON sono le incisioni
// originali protette. Per gli hit originali rimanda alle radio oldies.
'use client';

import { Music2, Pause, Play, Radio } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { type MusicPlayerTrack, useMusicPlayer } from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import { type ClassicsResponse, ClassicsResponseSchema } from '@/lib/contracts/classics';
import type { AudiusTrackSearchResult } from '@/lib/contracts/music';
import { CLASSICS_DECADES } from '@/lib/music/classics';
import styles from './classics-view.module.css';

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

export function ClassicsView() {
  const player = useMusicPlayer();
  const [decade, setDecade] = useState<string>(CLASSICS_DECADES[0]?.slug ?? '60s');
  const [data, setData] = useState<ClassicsResponse | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setData(null);
    apiFetch(`/api/music/classics?decade=${encodeURIComponent(decade)}`, {
      schema: ClassicsResponseSchema,
    })
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
  }, [decade]);

  const play = (track: AudiusTrackSearchResult, playlistTracks: AudiusTrackSearchResult[]) => {
    if (player.currentTrack?.qualifiedId === track.qualifiedId) {
      void player.togglePlayback();
      return;
    }
    const queue = playlistTracks.map(toTrack);
    const selected = queue.find((item) => item.qualifiedId === track.qualifiedId);
    if (!selected) return;
    void player.playTrack(
      selected,
      `/api/music/audius/tracks/${encodeURIComponent(track.id)}/stream`,
      queue,
    );
  };

  const playlists = data?.playlists ?? [];

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.pageTitle}>Classici per decennio</h1>
        <p className={styles.lead}>
          Playlist che ripercorrono i suoni di ogni decennio, dal catalogo musicale lecito di Solco
          (artisti indipendenti e Creative Commons). Non sono le incisioni originali protette.
        </p>
        <p className={styles.radioNote}>
          <Radio aria-hidden="true" />
          <span>
            Per gli hit originali, ascolta le <Link href="/radio">radio dal vivo</Link> dedicate
            agli anni d’oro.
          </span>
        </p>
      </header>

      <fieldset className={styles.tabs}>
        <legend className={styles.srOnly}>Scegli il decennio</legend>
        {CLASSICS_DECADES.map((entry) => (
          <button
            key={entry.slug}
            type="button"
            className={`${styles.tab} ${decade === entry.slug ? styles.tabActive : ''}`.trim()}
            aria-pressed={decade === entry.slug}
            onClick={() => setDecade(entry.slug)}
          >
            {entry.label}
          </button>
        ))}
      </fieldset>

      {data?.tagline ? <p className={styles.tagline}>{data.tagline}</p> : null}

      {state === 'loading' ? (
        <p className={styles.state}>Caricamento…</p>
      ) : state === 'error' || data?.outcome === 'unavailable' ? (
        <p className={styles.state}>
          I classici non sono raggiungibili in questo momento. Riprova.
        </p>
      ) : data?.outcome === 'inactive' ? (
        <p className={styles.state}>La sorgente musicale non è attiva al momento.</p>
      ) : playlists.length === 0 ? (
        <p className={styles.state}>Nessuna playlist disponibile per questo decennio adesso.</p>
      ) : (
        <div className={styles.playlists}>
          {playlists.map((playlist) => (
            <section key={playlist.id} className={styles.section} aria-label={playlist.title}>
              <header className={styles.sectionHead}>
                <h2 className={styles.sectionTitle}>{playlist.title}</h2>
                <p className={styles.sectionDesc}>{playlist.description}</p>
              </header>
              <ul className={styles.list}>
                {playlist.tracks.map((track) => {
                  const playing =
                    player.currentTrack?.qualifiedId === track.qualifiedId &&
                    player.status === 'playing';
                  return (
                    <li key={track.id} className={styles.row}>
                      <button
                        type="button"
                        className={styles.playButton}
                        onClick={() => play(track, playlist.tracks)}
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
                            width={44}
                            height={44}
                            unoptimized
                          />
                        ) : (
                          <Music2 aria-hidden="true" />
                        )}
                      </div>
                      <div className={styles.copy}>
                        <strong title={track.title}>{track.title}</strong>
                        <span>{track.artistName}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
