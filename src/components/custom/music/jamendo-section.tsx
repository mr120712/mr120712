// @polsia:user-owned — brani completi dal catalogo Jamendo. Il catalogo è spento finché manca una
// licenza commerciale Jamendo (src/lib/music/jamendo-license.ts): da spento l'API risponde
// "not_configured" e questa sezione non mostra nulla, nemmeno un invito a Premium. Anche se la
// richiesta fallisce (rete, 429, 5xx) la sezione resta vuota: non si sa se il catalogo è acceso.
'use client';

import { Pause, Play } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
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
  tag,
  contained = false,
  anchor = true,
}: {
  query?: string;
  /** Tag Jamendo (genere) invece di una ricerca libera. */
  tag?: string;
  contained?: boolean;
  /** false: no page anchor id (when the section is rendered more than once on a page). */
  anchor?: boolean;
}) {
  const player = useMusicPlayer();
  const headingId = useId();
  const [response, setResponse] = useState<JamendoListResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResponse(null);
    const path = query
      ? `/api/music/jamendo?q=${encodeURIComponent(query)}`
      : tag
        ? `/api/music/jamendo?tag=${encodeURIComponent(tag)}`
        : '/api/music/jamendo';
    apiFetch(path, { schema: JamendoListResponseSchema })
      .then((value) => !cancelled && setResponse(value))
      .catch(() => !cancelled && setResponse({ outcome: 'not_configured', tracks: [] }));
    return () => {
      cancelled = true;
    };
  }, [query, tag]);

  // Nothing at all (no heading, no loading state, no Premium teaser) until the API confirms the
  // catalogue is on: Jamendo stays off until the owner has a commercial licence.
  if (!response || response.outcome === 'not_configured') return null;

  const tracks = response.tracks.slice(0, 12);
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
      id={anchor ? 'musica-globale' : undefined}
      aria-labelledby={headingId}
    >
      <header className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>CATALOGO GLOBALE</p>
          <h2 id={headingId}>
            {query || tag ? 'Brani completi' : 'Musica indipendente da tutto il mondo'}
          </h2>
        </div>
      </header>
      {tracks.length === 0 ? (
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
        Musica indipendente da tutto il mondo (Jamendo, licenza Creative Commons). Brani completi e
        anche in background: con Free contano nei 40 ascolti del mese, con Premium sono illimitati.
      </p>
    </section>
  );
}
