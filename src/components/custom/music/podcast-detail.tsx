// @polsia:user-owned — scheda di un podcast: segui lo show e ascolta gli episodi.
'use client';

import { Check, Pause, Play, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLibrary } from '@/components/custom/music/library-context';
import { episodeToTrack } from '@/components/custom/music/live-tracks';
import { trackStreamPath, useMusicPlayer } from '@/components/custom/music/music-player';
import { PodcastArt } from '@/components/custom/music/podcast-tile';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  type PodcastDetailResponse,
  PodcastDetailResponseSchema,
  type PodcastEpisode,
} from '@/lib/contracts/library';
import styles from './discover.module.css';

function formatDuration(seconds: number | null) {
  if (seconds === null) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

function formatDate(value: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleDateString('it-IT', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function PodcastDetail({ podcastId }: { podcastId: string }) {
  const library = useLibrary();
  const player = useMusicPlayer();
  const [response, setResponse] = useState<PodcastDetailResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/music/podcasts/${encodeURIComponent(podcastId)}`, {
      schema: PodcastDetailResponseSchema,
    })
      .then((value) => {
        if (!cancelled) setResponse(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [podcastId]);

  const podcast = response?.podcast ?? null;
  if (failed || response?.outcome === 'unavailable') {
    return (
      <div className={styles.page}>
        <p className={styles.state}>Il podcast non è raggiungibile in questo momento. Riprova.</p>
      </div>
    );
  }
  if (!response) {
    return (
      <div className={styles.page}>
        <p className={styles.state}>Caricamento del podcast…</p>
      </div>
    );
  }
  if (!podcast) {
    return (
      <div className={styles.page}>
        <p className={styles.state}>Podcast non trovato.</p>
      </div>
    );
  }

  const followed = library.isPodcastFollowed(podcast.id);
  const queue = response.episodes.map((episode) => episodeToTrack(podcast, episode));
  const playEpisode = (episode: PodcastEpisode) => {
    const track = episodeToTrack(podcast, episode);
    if (player.currentTrack?.qualifiedId === track.qualifiedId) {
      void player.togglePlayback();
      return;
    }
    const path = trackStreamPath(track);
    if (path) void player.playTrack(track, path, queue);
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.tileArt}>
          <PodcastArt podcast={podcast} />
        </div>
        <div>
          <p className={styles.eyebrow}>
            PODCAST{podcast.genre ? ` · ${podcast.genre.toUpperCase()}` : ''}
          </p>
          <h1 className={styles.pageTitle}>{podcast.title}</h1>
          {podcast.author ? <p className={styles.lead}>{podcast.author}</p> : null}
          <div className={styles.headerActions}>
            {response.episodes[0] ? (
              <Button
                type="button"
                onClick={() => response.episodes[0] && playEpisode(response.episodes[0])}
              >
                <Play aria-hidden="true" /> Ultimo episodio
              </Button>
            ) : null}
            <Button
              type="button"
              variant={followed ? 'secondary' : 'outline'}
              aria-pressed={followed}
              onClick={() =>
                void library.mutate(
                  followed
                    ? { action: 'unfollow_podcast', podcastId: podcast.id }
                    : {
                        action: 'follow_podcast',
                        podcast: {
                          podcastId: podcast.id,
                          title: podcast.title,
                          author: podcast.author,
                          artworkUrl: podcast.artworkUrl,
                        },
                      },
                  followed ? 'Non segui più questo podcast.' : 'Podcast aggiunto alla Libreria.',
                )
              }
            >
              {followed ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}
              {followed ? 'Segui già' : 'Segui'}
            </Button>
          </div>
        </div>
      </header>

      <section className={styles.section} aria-labelledby="episodes-heading">
        <header className={styles.sectionHeader}>
          <h2 id="episodes-heading">Episodi</h2>
        </header>
        {response.episodes.length === 0 ? (
          <p className={styles.state}>Il feed non contiene episodi audio riproducibili.</p>
        ) : (
          <ol className={styles.list}>
            {response.episodes.map((episode) => {
              const qualifiedId = `podcast:${podcast.id}~${episode.key}`;
              const playing =
                player.currentTrack?.qualifiedId === qualifiedId && player.status === 'playing';
              const meta = [
                formatDate(episode.publishedAt),
                formatDuration(episode.durationSeconds),
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <li key={episode.key} className={styles.row}>
                  <div className={styles.rowArt}>
                    <PodcastArt
                      podcast={{
                        title: episode.title,
                        artworkUrl: episode.artworkUrl ?? podcast.artworkUrl,
                      }}
                    />
                  </div>
                  <div className={styles.rowCopy}>
                    <strong title={episode.title}>{episode.title}</strong>
                    {meta ? <span>{meta}</span> : null}
                    {episode.description ? <p>{episode.description}</p> : null}
                  </div>
                  <div className={styles.rowActions}>
                    <button
                      type="button"
                      className={`${styles.iconButton} ${styles.playButton}`}
                      onClick={() => playEpisode(episode)}
                      aria-label={
                        playing ? `Metti in pausa ${episode.title}` : `Riproduci ${episode.title}`
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
      </section>
    </div>
  );
}
