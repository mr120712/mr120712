// @polsia:user-owned — brani Audius (caricati dagli artisti stessi): completi e anche in background.
// Free: ogni brano conta nei 40 ascolti del mese; Premium illimitato. Nascosta finché Audius
// non è configurato (AUDIUS_API_KEY).
'use client';

import { Pause, Play } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { AudiusLicenseNotice } from '@/components/custom/music/audius-license-notice';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { type MusicPlayerTrack, useMusicPlayer } from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import {
  type AudiusTrackSearchResult,
  MusicSearchResponseSchema,
  MusicTrendingResponseSchema,
} from '@/lib/contracts/music';
import styles from './discover.module.css';

type Loaded = { available: boolean; tracks: AudiusTrackSearchResult[] };

function duration(seconds: number | null) {
  if (!seconds) return null;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The fields a playable Audius row needs (player track, attribution, OML licence notice). */
export type AudiusRowTrack = Pick<
  AudiusTrackSearchResult,
  | 'id'
  | 'qualifiedId'
  | 'title'
  | 'artistName'
  | 'artistUrl'
  | 'artworkUrl'
  | 'trackUrl'
  | 'durationSeconds'
  | 'license'
  | 'copyrightNotice'
  | 'licensorName'
  | 'attributionRemovalRequested'
>;

export function audiusToTrack(track: AudiusRowTrack): MusicPlayerTrack {
  return {
    qualifiedId: track.qualifiedId,
    title: track.title,
    artistName: track.artistName,
    artistUrl: track.artistUrl,
    artworkUrl: track.artworkUrl,
    sourceLabel: 'Audius',
    sourceUrl: track.trackUrl,
    sourceUrlLabel: 'Apri il brano su Audius',
    durationSeconds: track.durationSeconds,
    playbackMode: 'audius',
  };
}

/**
 * Playable Audius rows: play/pause on the shared player, the shown tracks as the queue (or
 * `queue`, when only part of a longer list is shown), and the OML licence notice under each
 * attribution. Pass only playback-eligible tracks.
 */
export function AudiusTrackList({
  tracks,
  queue: queueTracks = tracks,
}: {
  tracks: AudiusRowTrack[];
  queue?: AudiusRowTrack[];
}) {
  const player = useMusicPlayer();
  const queue = queueTracks.map(audiusToTrack);
  const play = (track: AudiusRowTrack) => {
    if (player.currentTrack?.qualifiedId === track.qualifiedId) {
      void player.togglePlayback();
      return;
    }
    const item = audiusToTrack(track);
    void player.playTrack(
      item,
      `/api/music/audius/tracks/${encodeURIComponent(track.id)}/stream`,
      queue,
    );
  };

  return (
    <ol className={styles.list}>
      {tracks.map((track) => {
        const playing =
          player.currentTrack?.qualifiedId === track.qualifiedId && player.status === 'playing';
        return (
          <li key={track.qualifiedId} className={styles.row}>
            <div className={styles.rowArt}>
              <FallbackArt src={track.artworkUrl} label={track.title} size={104} />
            </div>
            <div className={styles.rowCopy}>
              <strong title={track.title}>{track.title}</strong>
              <span>
                {[track.artistName, duration(track.durationSeconds)].filter(Boolean).join(' · ')}
              </span>
              <AudiusLicenseNotice track={track} showTrackLink />
            </div>
            <div className={styles.rowActions}>
              <button
                type="button"
                className={`${styles.iconButton} ${styles.playButton}`}
                onClick={() => play(track)}
                aria-label={playing ? `Metti in pausa ${track.title}` : `Riproduci ${track.title}`}
              >
                {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function AudiusSection({
  query,
  contained = false,
  anchor = true,
}: {
  /** Ricerca (es. il genere); senza, le tendenze di Audius. */
  query?: string;
  contained?: boolean;
  /** false: no page anchor id (when the section is rendered more than once on a page). */
  anchor?: boolean;
}) {
  const headingId = useId();
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    const request = query
      ? apiFetch(`/api/music/search?source=audius&q=${encodeURIComponent(query.slice(0, 80))}`, {
          schema: MusicSearchResponseSchema,
        })
      : apiFetch('/api/music/trending', { schema: MusicTrendingResponseSchema });
    request
      .then((value) => {
        if (cancelled) return;
        setLoaded({
          available: value.outcome !== 'unavailable' && value.outcome !== 'inactive',
          tracks: value.tracks.filter((track) => track.playbackEligible),
        });
      })
      .catch(() => !cancelled && setLoaded({ available: false, tracks: [] }));
    return () => {
      cancelled = true;
    };
  }, [query]);

  // Hidden until Audius is configured and answering.
  if (!loaded?.available) return null;

  const tracks = loaded.tracks.slice(0, 12);
  if (tracks.length === 0) return null;

  return (
    <section
      className={`${styles.section} ${contained ? styles.contained : ''}`}
      id={anchor ? 'audius' : undefined}
      aria-labelledby={headingId}
    >
      <header className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>ANCHE IN BACKGROUND</p>
          <h2 id={headingId}>{query ? 'Dagli artisti su Audius' : 'Tendenze su Audius'}</h2>
        </div>
      </header>
      <AudiusTrackList tracks={tracks} />
      <p className={styles.state}>
        Brani pubblicati dagli artisti su Audius. Brani completi e anche a schermo bloccato: con
        Free contano nei 40 ascolti del mese, con Premium sono illimitati.
      </p>
    </section>
  );
}
