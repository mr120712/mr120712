// @polsia:user-owned — scheda Podcast: podcast seguiti, classifica e ricerca.
'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { useLibrary } from '@/components/custom/music/library-context';
import { PodcastTile } from '@/components/custom/music/podcast-tile';
import { apiFetch } from '@/lib/api-client';
import { type PodcastListResponse, PodcastListResponseSchema } from '@/lib/contracts/library';
import styles from './discover.module.css';

export function PodcastDirectory({ initialQuery = '' }: { initialQuery?: string }) {
  const library = useLibrary();
  const [query, setQuery] = useState(initialQuery);
  const [draft, setDraft] = useState(initialQuery);
  const [response, setResponse] = useState<PodcastListResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setResponse(null);
    setFailed(false);
    const path = query
      ? `/api/music/podcasts?q=${encodeURIComponent(query)}`
      : '/api/music/podcasts';
    apiFetch(path, { schema: PodcastListResponseSchema })
      .then((value) => {
        if (!cancelled) setResponse(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setQuery(draft.trim());
  };

  const podcasts = (response?.podcasts ?? []).filter(
    (podcast) => !library.isHidden('podcast', podcast.id),
  );
  const followed = library.library.podcasts.map((podcast) => ({
    id: podcast.podcastId,
    title: podcast.title,
    author: podcast.author,
    artworkUrl: podcast.artworkUrl,
    genre: null,
  }));

  return (
    <div className={styles.page}>
      <header>
        <h1 className={styles.pageTitle}>Podcast</h1>
        <p className={styles.lead}>Show ed episodi dai feed pubblici dei podcast.</p>
      </header>

      {followed.length > 0 ? (
        <section className={styles.section} aria-labelledby="followed-heading">
          <header className={styles.sectionHeader}>
            <h2 id="followed-heading">Podcast che segui</h2>
          </header>
          <div className={styles.rail}>
            {followed.map((podcast) => (
              <PodcastTile key={podcast.id} podcast={podcast} allowHide={false} />
            ))}
          </div>
        </section>
      ) : null}

      <form className={styles.searchRow} onSubmit={submit}>
        <label className="sr-only" htmlFor="podcast-query">
          Cerca un podcast
        </label>
        <input
          id="podcast-query"
          type="search"
          value={draft}
          maxLength={80}
          placeholder="Cerca un podcast"
          onChange={(event) => setDraft(event.target.value)}
        />
      </form>

      <section className={styles.section} aria-labelledby="podcast-results-heading">
        <header className={styles.sectionHeader}>
          <h2 id="podcast-results-heading">
            {query ? `Risultati per “${query}”` : 'Podcast in classifica'}
          </h2>
        </header>
        {failed || response?.outcome === 'unavailable' ? (
          <p className={styles.state}>
            I podcast non sono raggiungibili in questo momento. Riprova.
          </p>
        ) : !response ? (
          <p className={styles.state}>Caricamento dei podcast…</p>
        ) : podcasts.length === 0 ? (
          <p className={styles.state}>Nessun podcast trovato.</p>
        ) : (
          <div className={styles.grid}>
            {podcasts.map((podcast) => (
              <PodcastTile key={podcast.id} podcast={podcast} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
