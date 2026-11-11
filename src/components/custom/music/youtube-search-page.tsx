// @polsia:user-owned — Cerca: video musicali YouTube (player Solco) + catalogo Premium, radio e podcast.
'use client';

import { Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { SearchExtras } from '@/components/custom/music/search-extras';
import { YouTubeVideoList } from '@/components/custom/music/youtube-video-list';
import { apiFetch } from '@/lib/api-client';
import { type MusicSearchResponse, MusicSearchResponseSchema } from '@/lib/contracts/music';
import { genreCatalog } from '@/lib/music/genre-catalog';
import styles from './discover.module.css';

function errorText(error: unknown) {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { error?: unknown; message?: unknown; retryAfterSeconds?: unknown })
      : null;
  if (cause?.error === 'rate_limited') {
    return typeof cause.message === 'string'
      ? cause.message
      : `Troppe ricerche ravvicinate. Riprova tra ${String(cause.retryAfterSeconds ?? 10)} secondi.`;
  }
  return 'La ricerca non è riuscita. Riprova tra poco.';
}

export function YouTubeSearchPage({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [draft, setDraft] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery.trim());
  const [response, setResponse] = useState<MusicSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(initialQuery);
    setQuery(initialQuery.trim());
  }, [initialQuery]);

  useEffect(() => {
    if (!query) {
      setResponse(null);
      return;
    }
    let cancelled = false;
    setResponse(null);
    setError(null);
    const params = new URLSearchParams({ source: 'youtube', q: query, youtubeConsent: 'accepted' });
    apiFetch(`/api/music/search?${params.toString()}`, { schema: MusicSearchResponseSchema })
      .then((value) => !cancelled && setResponse(value))
      .catch((reason) => !cancelled && setError(errorText(reason)));
    return () => {
      cancelled = true;
    };
  }, [query]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const term = draft.trim().slice(0, 80);
    if (!term) return;
    router.replace(`${pathname}?q=${encodeURIComponent(term)}`, { scroll: false });
    setQuery(term);
  };

  const videos = response?.videos ?? [];

  return (
    <div className={styles.page}>
      <header>
        <h1 className={styles.pageTitle}>Cerca</h1>
      </header>
      <form className={styles.searchRow} onSubmit={submit}>
        <label className="sr-only" htmlFor="search-query">
          Cerca brani, artisti o video musicali
        </label>
        <input
          id="search-query"
          type="search"
          value={draft}
          maxLength={80}
          placeholder="Brani, artisti, album"
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className={styles.searchButton}>
          <Search aria-hidden="true" />
          <span>Cerca</span>
        </button>
      </form>
      <p className={styles.state}>
        La ricerca dei brani usa YouTube: la tua query viene inviata a Google.{' '}
        <Link href="/privacy">Privacy</Link>
      </p>

      {!query ? (
        <section className={styles.section} aria-labelledby="moods-heading">
          <header className={styles.sectionHeader}>
            <h2 id="moods-heading">Sfoglia per genere e mood</h2>
          </header>
          <div className={styles.moodGrid}>
            {genreCatalog
              .filter((entry) => entry.family !== 'playlist')
              .slice(0, 16)
              .map((entry) => (
                <Link key={entry.slug} href={`/generi/${entry.slug}`}>
                  {entry.name}
                </Link>
              ))}
            <Link href="/generi">Tutti i generi e le playlist →</Link>
          </div>
        </section>
      ) : (
        <>
          <section className={styles.section} aria-labelledby="videos-heading">
            <header className={styles.sectionHeader}>
              <h2 id="videos-heading">Brani</h2>
            </header>
            {error ? (
              <p className={styles.state}>{error}</p>
            ) : !response ? (
              <p className={styles.state}>Cerco “{query}”…</p>
            ) : videos.length === 0 ? (
              <p className={styles.state}>
                {response.outcome === 'unavailable'
                  ? 'YouTube non è disponibile in questo momento (quota giornaliera o configurazione).'
                  : 'Nessun risultato.'}
              </p>
            ) : (
              <YouTubeVideoList videos={videos} />
            )}
          </section>
          <SearchExtras key={query} query={query} />
        </>
      )}
    </div>
  );
}
