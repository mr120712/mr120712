// @polsia:user-owned — pagina di un genere o di una playlist: brani YouTube, radio e catalogo Jamendo.
'use client';

import { Play, Shuffle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { JamendoSection } from '@/components/custom/music/jamendo-section';
import { videoToTrack } from '@/components/custom/music/live-tracks';
import { trackStreamPath, useMusicPlayer } from '@/components/custom/music/music-player';
import { StationTile } from '@/components/custom/music/radio-station-tile';
import { YouTubeVideoList } from '@/components/custom/music/youtube-video-list';
import { ShareButton } from '@/components/custom/share-button';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { type RadioListResponse, RadioListResponseSchema } from '@/lib/contracts/library';
import { type MusicSearchResponse, MusicSearchResponseSchema } from '@/lib/contracts/music';
import type { GenreEntry } from '@/lib/music/genre-catalog';
import styles from './discover.module.css';

export function GenreDetail({ genre }: { genre: GenreEntry }) {
  const player = useMusicPlayer();
  const [videos, setVideos] = useState<MusicSearchResponse | null>(null);
  const [radio, setRadio] = useState<RadioListResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/music/genres/${genre.slug}`, { schema: MusicSearchResponseSchema })
      .then((value) => !cancelled && setVideos(value))
      .catch(() => !cancelled && setVideos(null));
    if (genre.radioTag) {
      apiFetch(`/api/music/radio?tag=${encodeURIComponent(genre.radioTag)}&limit=16`, {
        schema: RadioListResponseSchema,
      })
        .then((value) => !cancelled && setRadio(value))
        .catch(() => !cancelled && setRadio({ outcome: 'unavailable', stations: [] }));
    }
    return () => {
      cancelled = true;
    };
  }, [genre.radioTag, genre.slug]);

  const list = videos?.videos ?? [];
  const playAll = (shuffled: boolean) => {
    const queue = list.map(videoToTrack);
    if (shuffled) queue.sort(() => Math.random() - 0.5);
    const first = queue[0];
    const path = first ? trackStreamPath(first) : null;
    if (first && path) void player.playTrack(first, path, queue);
  };

  return (
    <div className={styles.page}>
      <header>
        <p className={styles.eyebrow}>
          <Link href="/generi">GENERI E PLAYLIST</Link>
        </p>
        <h1 className={styles.pageTitle}>{genre.name}</h1>
        <p className={styles.lead}>{genre.description}</p>
        <div className={styles.headerActions}>
          <Button type="button" onClick={() => playAll(false)} disabled={list.length === 0}>
            <Play aria-hidden="true" /> Riproduci tutto
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => playAll(true)}
            disabled={list.length === 0}
          >
            <Shuffle aria-hidden="true" /> Casuale
          </Button>
          <ShareButton
            title={`${genre.name} su Solco`}
            text={`Ascolta ${genre.name}: brani, radio e playlist gratis su Solco.`}
            path={`/generi/${genre.slug}`}
          />
        </div>
      </header>

      <section className={styles.section} aria-labelledby="genre-tracks">
        <header className={styles.sectionHeader}>
          <h2 id="genre-tracks">Brani</h2>
        </header>
        {!videos ? (
          <p className={styles.state}>Caricamento dei brani…</p>
        ) : list.length === 0 ? (
          <p className={styles.state}>I brani non sono disponibili in questo momento.</p>
        ) : (
          <YouTubeVideoList videos={list} />
        )}
      </section>

      {genre.radioTag && radio && radio.stations.length > 0 ? (
        <section className={styles.section} aria-labelledby="genre-radio">
          <header className={styles.sectionHeader}>
            <h2 id="genre-radio">Radio {genre.name}</h2>
          </header>
          <div className={styles.rail}>
            {radio.stations.map((station) => (
              <StationTile key={station.id} station={station} queue={radio.stations} />
            ))}
          </div>
        </section>
      ) : null}

      {genre.jamendoTag ? <JamendoSection tag={genre.jamendoTag} /> : null}
    </div>
  );
}
