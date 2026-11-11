// @polsia:user-owned — risultati Radio e Podcast sotto la ricerca musicale.
'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { JamendoSection } from '@/components/custom/music/jamendo-section';
import { useLibrary } from '@/components/custom/music/library-context';
import { PodcastTile } from '@/components/custom/music/podcast-tile';
import { StationTile } from '@/components/custom/music/radio-station-tile';
import { apiFetch } from '@/lib/api-client';
import {
  type PodcastListResponse,
  PodcastListResponseSchema,
  type RadioListResponse,
  RadioListResponseSchema,
} from '@/lib/contracts/library';
import styles from './discover.module.css';

export function SearchExtras({ query }: { query: string }) {
  const library = useLibrary();
  const [radio, setRadio] = useState<RadioListResponse | null>(null);
  const [podcasts, setPodcasts] = useState<PodcastListResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRadio(null);
    setPodcasts(null);
    const term = encodeURIComponent(query);
    apiFetch(`/api/music/radio?q=${term}&limit=12`, { schema: RadioListResponseSchema })
      .then((value) => !cancelled && setRadio(value))
      .catch(() => !cancelled && setRadio({ outcome: 'unavailable', stations: [] }));
    apiFetch(`/api/music/podcasts?q=${term}`, { schema: PodcastListResponseSchema })
      .then((value) => !cancelled && setPodcasts(value))
      .catch(() => !cancelled && setPodcasts({ outcome: 'unavailable', podcasts: [] }));
    return () => {
      cancelled = true;
    };
  }, [query]);

  const stations = (radio?.stations ?? []).filter((item) => !library.isHidden('station', item.id));
  const shows = (podcasts?.podcasts ?? []).filter((item) => !library.isHidden('podcast', item.id));

  return (
    <>
      <JamendoSection query={query} />

      <section className={styles.section} aria-labelledby="search-radio-heading">
        <header className={styles.sectionHeader}>
          <h2 id="search-radio-heading">Radio</h2>
          <Link href={`/radio?q=${encodeURIComponent(query)}`}>Altre radio</Link>
        </header>
        {!radio ? (
          <p className={styles.state}>Cerco stazioni radio…</p>
        ) : stations.length === 0 ? (
          <p className={styles.state}>
            {radio.outcome === 'unavailable'
              ? 'Le radio non sono raggiungibili in questo momento.'
              : 'Nessuna stazione radio per questa ricerca.'}
          </p>
        ) : (
          <div className={styles.rail}>
            {stations.map((station) => (
              <StationTile key={station.id} station={station} queue={stations} />
            ))}
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby="search-podcast-heading">
        <header className={styles.sectionHeader}>
          <h2 id="search-podcast-heading">Podcast</h2>
          <Link href={`/podcasts?q=${encodeURIComponent(query)}`}>Altri podcast</Link>
        </header>
        {!podcasts ? (
          <p className={styles.state}>Cerco podcast…</p>
        ) : shows.length === 0 ? (
          <p className={styles.state}>
            {podcasts.outcome === 'unavailable'
              ? 'I podcast non sono raggiungibili in questo momento.'
              : 'Nessun podcast per questa ricerca.'}
          </p>
        ) : (
          <div className={styles.rail}>
            {shows.map((podcast) => (
              <PodcastTile key={podcast.id} podcast={podcast} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
