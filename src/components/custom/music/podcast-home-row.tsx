// @polsia:user-owned — riga "Podcast in classifica" della Home.
'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useLibrary } from '@/components/custom/music/library-context';
import { PodcastTile } from '@/components/custom/music/podcast-tile';
import { apiFetch } from '@/lib/api-client';
import { type PodcastListResponse, PodcastListResponseSchema } from '@/lib/contracts/library';
import styles from './discover.module.css';

export function PodcastHomeRow() {
  const library = useLibrary();
  const [response, setResponse] = useState<PodcastListResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/music/podcasts', { schema: PodcastListResponseSchema })
      .then((value) => {
        if (!cancelled) setResponse(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const podcasts = (response?.podcasts ?? []).filter(
    (podcast) => !library.isHidden('podcast', podcast.id),
  );

  return (
    <section className={styles.section} id="podcast" aria-labelledby="home-podcast-heading">
      <header className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>PODCAST</p>
          <h2 id="home-podcast-heading">Podcast in classifica</h2>
        </div>
        <Link href="/podcasts">Tutti i podcast</Link>
      </header>
      {failed || response?.outcome === 'unavailable' ? (
        <p className={styles.state}>I podcast non sono raggiungibili in questo momento.</p>
      ) : !response ? (
        <p className={styles.state}>Caricamento dei podcast…</p>
      ) : podcasts.length === 0 ? (
        <p className={styles.state}>Nessun podcast da consigliare per ora.</p>
      ) : (
        <div className={styles.rail}>
          {podcasts.map((podcast) => (
            <PodcastTile key={podcast.id} podcast={podcast} />
          ))}
        </div>
      )}
    </section>
  );
}
