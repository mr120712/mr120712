// @polsia:user-owned — "Musica globale": brani completi dal catalogo Jamendo, gratis per tutti.
'use client';

import { Pause, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { jamendoToTrack } from '@/components/custom/music/live-tracks';
import { trackStreamPath, useMusicPlayer } from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import {
  type JamendoListResponse,
  JamendoListResponseSchema,
  type JamendoTrack,
} from '@/lib/contracts/library';
import styles from './discover.module.css';

function duration(seconds: number | null) {
  if (!seconds) return null;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function JamendoSection({
  query,
  contained = false,
}: {
  query?: string;
  contained?: boolean;
}) {
  const player = useMusicPlayer();
  const [response, setResponse] = useState<JamendoListResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResponse(null);
    const path = query ? `/api/music/jamendo?q=${encodeURIComponent(query)}` : '/api/music/jamendo';
    apiFetch(path, { schema: JamendoListResponseSchema })
      .then((value) => !cancelled && setResponse(value))
      .catch(() => !cancelled && setResponse({ outcome: 'unavailable', tracks: [] }));
    return () => {
      cancelled = true;
    };
  }, [query]);

  // Hide the section entirely until the owner configures Jamendo.
  if (response?.outcome === 'not_configured') return null;

  const tracks = response?.tracks.slice(0, 12) ?? [];
  const queue = tracks.map(jamendoToTrack);
  const play = (track: JamendoTrack) => {
    const item = jamendoToTrack(track);
    if (player.currentTrack?.qualifiedId === item.qualifiedId) {
      void player.togglePlayback();
      return;
    }
    const path = trackStreamPath(item);
    if (path) void player.playTrack(item, path, queue);
  };

  return (
    <section
      className={`${styles.section} ${contained ? styles.contained : ''}`}
      id="musica-globale"
      aria-labelledby="jamendo-heading"
    >
      <header className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>CATALOGO GLOBALE · GRATIS</p>
          <h2 id="jamendo-heading">{query ? 'Brani completi' : 'Musica globale senza limiti'}</h2>
        </div>
      </header>
      {!response ? (
        <p className={styles.state}>Caricamento del catalogo…</p>
      ) : tracks.length === 0 ? (
        <p className={styles.state}>
          {response.outcome === 'unavailable'
            ? 'Il catalogo globale non è raggiungibile in questo momento.'
            : 'Nessun brano trovato.'}
        </p>
      ) : (
        <ol className={styles.list}>
          {tracks.map((track) => {
            const playing =
              player.currentTrack?.qualifiedId === `jamendo:${track.id}` &&
              player.status === 'playing';
            return (
              <li key={track.id} className={styles.row}>
                <div className={styles.rowArt}>
                  <FallbackArt src={track.artworkUrl} label={track.title} size={104} />
                </div>
                <div className={styles.rowCopy}>
                  <strong title={track.title}>{track.title}</strong>
                  <span>
                    {[track.artistName, duration(track.durationSeconds)]
                      .filter(Boolean)
                      .join(' · ')}
                    {track.licenseUrl ? (
                      <>
                        {' · '}
                        <a href={track.licenseUrl} target="_blank" rel="noreferrer">
                          Licenza CC
                        </a>
                      </>
                    ) : null}
                  </span>
                </div>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={`${styles.iconButton} ${styles.playButton}`}
                    onClick={() => play(track)}
                    aria-label={
                      playing ? `Metti in pausa ${track.title}` : `Riproduci ${track.title}`
                    }
                  >
                    {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <p className={styles.state}>
        Brani completi e senza pubblicità da Jamendo: musica indipendente da tutto il mondo in
        licenza Creative Commons. Gratis per tutti, anche in background.
      </p>
    </section>
  );
}
