// @polsia:user-owned
'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { YouTubeVideoSearchResult } from '@/lib/contracts/music';
import styles from './music.module.css';

export function YouTubePlayer({ videoId, title }: { videoId: string; title: string }) {
  const [pageVisible, setPageVisible] = useState(true);
  const [suspended, setSuspended] = useState(false);

  useEffect(() => {
    const updateVisibility = () => {
      const visible = document.visibilityState === 'visible';
      setPageVisible(visible);
      if (!visible) setSuspended(true);
    };
    const suspendOnPageHide = () => setSuspended(true);
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    window.addEventListener('pagehide', suspendOnPageHide);
    return () => {
      document.removeEventListener('visibilitychange', updateVisibility);
      window.removeEventListener('pagehide', suspendOnPageHide);
    };
  }, []);

  if (!pageVisible || suspended) {
    return (
      <div className={styles.youtubePlayerState} aria-live="polite" aria-atomic="true">
        <p>
          Player sospeso quando Solco è in background. Premi per caricare di nuovo il player
          ufficiale senza avvio automatico.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => setSuspended(false)}
          disabled={!pageVisible}
        >
          Ricarica player YouTube
        </Button>
      </div>
    );
  }

  return (
    <div className={styles.youtubeFrame} data-youtube-official-frame>
      <iframe
        src={`https://www.youtube.com/embed/${videoId}?enablejsapi=1&controls=1&playsinline=1`}
        title={`Player YouTube ufficiale: ${title}`}
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
        allow="encrypted-media; web-share"
        allowFullScreen
      />
    </div>
  );
}

export function YouTubeVideoCard({
  video,
  selected,
  onSelect,
  onFavorite,
  hasPlaylists,
  onAddToPlaylist,
  inlinePlayer = true,
}: {
  video: YouTubeVideoSearchResult;
  selected: boolean;
  onSelect: () => void;
  onFavorite: () => void;
  hasPlaylists: boolean;
  onAddToPlaylist: () => void;
  /** false quando il video viene riprodotto dalla coda YouTube condivisa della pagina. */
  inlinePlayer?: boolean;
}) {
  const publishedDate = video.publishedAt
    ? new Date(video.publishedAt).toLocaleDateString('it-IT')
    : null;

  return (
    <article
      className={`${styles.resultCard} ${styles.youtubeCard} ${selected && inlinePlayer ? styles.youtubeCardPlaying : ''} ${selected && !inlinePlayer ? styles.youtubeCardQueued : ''}`}
    >
      <div className={`${styles.artwork} ${styles.youtubeArtwork}`}>
        {video.thumbnailUrl ? (
          <Image
            src={video.thumbnailUrl}
            alt={`Miniatura del video ${video.title}`}
            width={160}
            height={90}
            unoptimized
          />
        ) : (
          <span>YouTube</span>
        )}
      </div>
      <div className={styles.resultContent}>
        <div className={styles.resultHeading}>
          <div>
            <span className={`${styles.sourcePill} ${styles.youtubePill}`}>YouTube</span>
            <h3>{video.title}</h3>
            <p className={styles.artistLine}>
              {video.channelId ? (
                <a
                  href={`https://www.youtube.com/channel/${encodeURIComponent(video.channelId)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {video.channelTitle}
                </a>
              ) : (
                video.channelTitle
              )}
              {publishedDate ? <span> · Pubblicato il {publishedDate}</span> : null}
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onFavorite}>
            Salva nei preferiti
          </Button>
        </div>
        {video.description ? <p className={styles.videoDescription}>{video.description}</p> : null}
        <div className={styles.attribution}>
          <span>Metadati restituiti da YouTube Data API v3.</span>
          <a
            href={`https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`}
            target="_blank"
            rel="noreferrer"
          >
            Apri il video su YouTube
          </a>
        </div>
        <Button type="button" variant="secondary" onClick={onSelect}>
          {inlinePlayer
            ? selected
              ? 'Ricarica player YouTube ufficiale'
              : 'Apri player YouTube ufficiale'
            : selected
              ? 'In riproduzione nella coda YouTube'
              : 'Riproduci nella coda YouTube'}
        </Button>
        {hasPlaylists ? (
          <Button type="button" variant="ghost" size="sm" onClick={onAddToPlaylist}>
            Aggiungi alla playlist
          </Button>
        ) : null}
        {selected && inlinePlayer ? (
          <div className={styles.youtubePlayerState} aria-live="polite">
            <p>
              Player YouTube ufficiale. Controlli, marchio e annunci restano gestiti da YouTube.
            </p>
            <YouTubePlayer videoId={video.videoId} title={video.title} />
          </div>
        ) : null}
      </div>
    </article>
  );
}
