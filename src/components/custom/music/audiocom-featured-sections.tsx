// @polsia:user-owned — «In evidenza da audio.com» in Home: una sezione per ogni collection scelta
// dall'amministratore in /admin/audiocom (GET /api/music/audiocom/featured), con le stesse card della
// sezione «In evidenza». Un brano con licenza CC0, CC BY, CC BY-SA o CC BY-ND (mai una cover) si
// ascolta nel player di Solco, con la coda dei brani riproducibili della sezione; gli altri hanno
// «Ascolta su audio.com» (player ufficiale). Sotto ogni card l'attribuzione: licenza e link al brano
// su audio.com. Senza sezioni (nessuna scelta, nessun account collegato, errore) non mostra nulla.
'use client';

import { Pause, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  AudioComAttribution,
  AudioComEmbedDialog,
} from '@/components/custom/music/audiocom-attribution';
import { audioComToPlayerTrack } from '@/components/custom/music/audiocom-tracks';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import {
  type MusicPlayerTrack,
  trackStreamPath,
  useMusicPlayer,
} from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import {
  AudioComHomeResponseSchema,
  type AudioComHomeSection,
} from '@/lib/contracts/audiocom-collections';
import styles from './audiocom-featured-sections.module.css';
import cardStyles from './home-tracks-section.module.css';

export const AUDIOCOM_FEATURED_ENDPOINT = '/api/music/audiocom/featured';

export function AudioComFeaturedSections() {
  const [sections, setSections] = useState<AudioComHomeSection[]>([]);

  useEffect(() => {
    let active = true;
    apiFetch(AUDIOCOM_FEATURED_ENDPOINT, { schema: AudioComHomeResponseSchema })
      .then((body) => {
        if (active) setSections(body.sections);
      })
      .catch(() => {
        // Nessuna sezione: la Home resta com'è.
      });
    return () => {
      active = false;
    };
  }, []);

  if (sections.length === 0) return null;
  return (
    <>
      {sections.map((section) => (
        <AudioComSection key={section.id} section={section} />
      ))}
    </>
  );
}

function AudioComSection({ section }: { section: AudioComHomeSection }) {
  const player = useMusicPlayer();
  // La coda: solo i brani della sezione che Solco può riprodurre (licenza ammessa, non cover).
  const queue = useMemo(
    () =>
      section.tracks.flatMap((track): MusicPlayerTrack[] => {
        const playable = audioComToPlayerTrack(track);
        return playable ? [playable] : [];
      }),
    [section.tracks],
  );
  const headingId = `audiocom-section-${section.id}`;

  const play = (track: MusicPlayerTrack) => {
    if (player.currentTrack?.qualifiedId === track.qualifiedId) {
      void player.togglePlayback();
      return;
    }
    const path = trackStreamPath(track);
    if (path) void player.playTrack(track, path, queue);
  };
  // Aprendo il player ufficiale di audio.com si mette in pausa quello di Solco (mai due brani insieme).
  const pauseForEmbed = () => {
    if (player.status === 'playing') void player.togglePlayback();
  };

  return (
    <section className={cardStyles.section} aria-labelledby={headingId}>
      <div className={cardStyles.head}>
        <p className={cardStyles.eyebrow}>IN EVIDENZA · AUDIO.COM</p>
        <h2 id={headingId} className={cardStyles.title}>
          {section.title}
        </h2>
      </div>
      <ul className={cardStyles.rail}>
        {section.tracks.map((track) => {
          const playable = audioComToPlayerTrack(track);
          const isCurrent = playable
            ? player.currentTrack?.qualifiedId === playable.qualifiedId
            : false;
          const playing = isCurrent && player.status === 'playing';
          return (
            <li key={track.id} className={cardStyles.card} data-current={isCurrent || undefined}>
              {playable ? (
                <button
                  type="button"
                  className={cardStyles.cardButton}
                  onClick={() => play(playable)}
                  aria-label={
                    playing
                      ? `Metti in pausa ${track.title} di ${track.authorName}`
                      : `Riproduci ${track.title} di ${track.authorName}`
                  }
                  aria-pressed={isCurrent ? playing : undefined}
                >
                  <span className={cardStyles.art}>
                    <FallbackArt src={track.imageUrl} label={track.title} size={160} />
                    <span className={cardStyles.playBadge} aria-hidden="true">
                      {playing ? <Pause /> : <Play />}
                    </span>
                  </span>
                  <strong className={cardStyles.cardTitle} title={track.title}>
                    {track.title}
                  </strong>
                  <span className={cardStyles.meta}>{track.authorName}</span>
                </button>
              ) : (
                <div className={styles.static}>
                  <span className={cardStyles.art}>
                    <FallbackArt src={track.imageUrl} label={track.title} size={160} />
                  </span>
                  <strong className={cardStyles.cardTitle} title={track.title}>
                    {track.title}
                  </strong>
                  <span className={cardStyles.meta}>{track.authorName}</span>
                </div>
              )}
              <div className={styles.credits}>
                <AudioComAttribution track={track} />
                {playable ? null : <AudioComEmbedDialog track={track} onOpen={pauseForEmbed} />}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
