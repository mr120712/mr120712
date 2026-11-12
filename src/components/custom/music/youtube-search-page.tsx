// @polsia:user-owned — Cerca: video musicali YouTube (player Solco) + catalogo Premium, radio e podcast.
'use client';

import { Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { AiMusicSearch } from '@/components/custom/music/ai-music-search';
import { AudiusSection } from '@/components/custom/music/audius-section';
import { ListenInSolco } from '@/components/custom/music/listen-in-solco';
import { SearchExtras } from '@/components/custom/music/search-extras';
import {
  describeYouTubeSearch,
  YOUTUBE_RETRY_DELAY_MS,
  YouTubeLinkRow,
  YouTubeSearchNoticeBox,
  youtubeStatusText,
} from '@/components/custom/music/youtube-search-notice';
import { YouTubeVideoList } from '@/components/custom/music/youtube-video-list';
import { apiFetch } from '@/lib/api-client';
import {
  type YouTubeMusicSearchResponse,
  YouTubeMusicSearchResponseSchema,
} from '@/lib/contracts/youtube-search';
import { genreCatalog } from '@/lib/music/genre-catalog';
import styles from './discover.module.css';

type SearchError = { text: string; retryAfterMs: number };

function searchError(error: unknown): SearchError {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { error?: unknown; message?: unknown; retryAfterSeconds?: unknown })
      : null;
  if (cause?.error === 'rate_limited') {
    const seconds =
      typeof cause.retryAfterSeconds === 'number' && cause.retryAfterSeconds > 0
        ? Math.min(cause.retryAfterSeconds, 120)
        : 10;
    return {
      text:
        typeof cause.message === 'string'
          ? cause.message
          : `Troppe ricerche ravvicinate. Riprova tra ${seconds} secondi.`,
      retryAfterMs: seconds * 1000,
    };
  }
  return { text: 'La ricerca non è riuscita. Riprova tra poco.', retryAfterMs: 0 };
}

export function YouTubeSearchPage({
  initialQuery,
  initialAi = false,
}: {
  initialQuery: string;
  initialAi?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [draft, setDraft] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery.trim());
  const [response, setResponse] = useState<YouTubeMusicSearchResponse | null>(null);
  const [error, setError] = useState<SearchError | null>(null);
  // Bumped by "Riprova" to run the same search again.
  const [attempt, setAttempt] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    setDraft(initialQuery);
    setQuery(initialQuery.trim());
  }, [initialQuery]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is an explicit retry trigger.
  useEffect(() => {
    if (!query) {
      setResponse(null);
      return;
    }
    let cancelled = false;
    setResponse(null);
    setError(null);
    const params = new URLSearchParams({ source: 'youtube', q: query, youtubeConsent: 'accepted' });
    apiFetch(`/api/music/search?${params.toString()}`, { schema: YouTubeMusicSearchResponseSchema })
      .then((value) => !cancelled && setResponse(value))
      .catch((reason) => !cancelled && setError(searchError(reason)));
    return () => {
      cancelled = true;
    };
  }, [query, attempt]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const term = draft.trim().slice(0, 80);
    if (!term) return;
    router.replace(`${pathname}?q=${encodeURIComponent(term)}`, { scroll: false });
    setQuery(term);
  };

  const videos = response?.videos ?? [];
  const youtube = response ? describeYouTubeSearch(response) : null;
  // The notice (and its button) is replaced while searching again: keep the focus in the section.
  const retry = () => {
    setAttempt((value) => value + 1);
    headingRef.current?.focus();
  };
  const status = error
    ? error.text
    : !youtube
      ? `Cerco “${query}”…`
      : youtubeStatusText(youtube, videos.length);

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
      <AiMusicSearch initiallyOpen={initialAi} />
      <ListenInSolco />

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
              <h2 id="videos-heading" ref={headingRef} tabIndex={-1}>
                Brani
              </h2>
            </header>
            {/* Always mounted, so screen readers announce each change (searching, results, notice). */}
            <output className="sr-only" aria-live="polite">
              {status}
            </output>
            {error ? (
              <>
                <p className={styles.state}>{error.text}</p>
                <YouTubeLinkRow query={query} onRetry={retry} retryDelayMs={error.retryAfterMs} />
              </>
            ) : !response || !youtube ? (
              <p className={styles.state}>Cerco “{query}”…</p>
            ) : youtube.kind === 'no_results' ? (
              <>
                <p className={styles.state}>Nessun risultato.</p>
                <YouTubeLinkRow query={query} />
              </>
            ) : youtube.kind === 'blocked' ? (
              <YouTubeSearchNoticeBox
                query={query}
                text={youtube.text}
                quotaOut={youtube.quotaOut}
                signIn={youtube.signIn}
                onRetry={youtube.retry ? retry : undefined}
                retryDelayMs={YOUTUBE_RETRY_DELAY_MS}
              />
            ) : (
              <>
                {youtube.kind === 'saved' ? (
                  <YouTubeSearchNoticeBox
                    query={query}
                    label={youtube.label}
                    text={youtube.text}
                    signIn={youtube.signIn}
                    onRetry={youtube.retry ? retry : undefined}
                    retryDelayMs={YOUTUBE_RETRY_DELAY_MS}
                  />
                ) : null}
                <YouTubeVideoList videos={videos} />
              </>
            )}
          </section>
          <AudiusSection key={`audius-${query}`} query={query} />
          <SearchExtras key={query} query={query} />
        </>
      )}
    </div>
  );
}
