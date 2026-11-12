// @polsia:user-owned — pagina di un genere o di una playlist: brani YouTube, radio e catalogo Jamendo.
'use client';

import { Play, Shuffle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AudiusSection } from '@/components/custom/music/audius-section';
import { JamendoSection } from '@/components/custom/music/jamendo-section';
import { videoToTrack } from '@/components/custom/music/live-tracks';
import { trackStreamPath, useMusicPlayer } from '@/components/custom/music/music-player';
import { StationTile } from '@/components/custom/music/radio-station-tile';
import { TikTokClips } from '@/components/custom/music/tiktok-clips';
import {
  describeYouTubeSearch,
  YOUTUBE_RETRY_DELAY_MS,
  YouTubeLinkRow,
  YouTubeSearchNoticeBox,
  youtubeStatusText,
} from '@/components/custom/music/youtube-search-notice';
import { YouTubeVideoList } from '@/components/custom/music/youtube-video-list';
import { ShareButton } from '@/components/custom/share-button';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { type RadioListResponse, RadioListResponseSchema } from '@/lib/contracts/library';
import {
  type YouTubeMusicSearchResponse,
  YouTubeMusicSearchResponseSchema,
} from '@/lib/contracts/youtube-search';
import type { GenreEntry } from '@/lib/music/genre-catalog';
import styles from './discover.module.css';

export function GenreDetail({ genre }: { genre: GenreEntry }) {
  const player = useMusicPlayer();
  const [videos, setVideos] = useState<YouTubeMusicSearchResponse | null>(null);
  // The genre's tracks could not be loaded at all (network, server error).
  const [failed, setFailed] = useState(false);
  // Bumped by "Riprova" to load the tracks again.
  const [attempt, setAttempt] = useState(0);
  const [radio, setRadio] = useState<RadioListResponse | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is an explicit retry trigger.
  useEffect(() => {
    let cancelled = false;
    setVideos(null);
    setFailed(false);
    apiFetch(`/api/music/genres/${genre.slug}`, { schema: YouTubeMusicSearchResponseSchema })
      .then((value) => !cancelled && setVideos(value))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [genre.slug, attempt]);

  useEffect(() => {
    let cancelled = false;
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
  }, [genre.radioTag]);

  const list = videos?.videos ?? [];
  const youtube = videos ? describeYouTubeSearch(videos, new Date(), 'genre') : null;
  const retry = () => {
    setAttempt((value) => value + 1);
    headingRef.current?.focus();
  };
  const failedText = 'I brani non si caricano in questo momento.';
  const status = failed
    ? failedText
    : !youtube
      ? 'Caricamento dei brani…'
      : youtube.kind !== 'blocked' && list.length === 0
        ? 'I brani non sono disponibili in questo momento.'
        : youtubeStatusText(youtube, list.length);
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
          <h2 id="genre-tracks" ref={headingRef} tabIndex={-1}>
            Brani
          </h2>
        </header>
        {/* Always mounted, so screen readers announce each change (loading, tracks, notice). */}
        <output className="sr-only" aria-live="polite">
          {status}
        </output>
        {failed ? (
          <>
            <p className={styles.state}>{failedText}</p>
            <YouTubeLinkRow query={genre.query} onRetry={retry} />
          </>
        ) : !videos || !youtube ? (
          <p className={styles.state}>Caricamento dei brani…</p>
        ) : youtube.kind === 'blocked' ? (
          <YouTubeSearchNoticeBox
            query={genre.query}
            text={youtube.text}
            quotaOut={youtube.quotaOut}
            signIn={youtube.signIn}
            onRetry={youtube.retry ? retry : undefined}
            retryDelayMs={YOUTUBE_RETRY_DELAY_MS}
          />
        ) : list.length === 0 ? (
          <>
            <p className={styles.state}>I brani non sono disponibili in questo momento.</p>
            <YouTubeLinkRow query={genre.query} />
          </>
        ) : (
          <>
            {youtube.kind === 'saved' ? (
              <YouTubeSearchNoticeBox
                query={genre.query}
                label={youtube.label}
                text={youtube.text}
                signIn={youtube.signIn}
                onRetry={youtube.retry ? retry : undefined}
                retryDelayMs={YOUTUBE_RETRY_DELAY_MS}
              />
            ) : null}
            <YouTubeVideoList videos={list} />
          </>
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

      <TikTokClips genre={genre.slug} />
      <AudiusSection query={genre.query} />
      {genre.jamendoTag ? <JamendoSection tag={genre.jamendoTag} /> : null}
    </div>
  );
}
