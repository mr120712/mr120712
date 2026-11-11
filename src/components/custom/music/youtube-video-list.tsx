// @polsia:user-owned — elenco di video musicali YouTube riprodotti nel player Solco.
'use client';

import { Heart, Pause, Play } from 'lucide-react';
import { toast } from 'sonner';
import { FallbackArt } from '@/components/custom/music/fallback-art';
import { useLibrary } from '@/components/custom/music/library-context';
import { videoToTrack, type YouTubeVideoLike } from '@/components/custom/music/live-tracks';
import { trackStreamPath, useMusicPlayer } from '@/components/custom/music/music-player';
import { apiFetch } from '@/lib/api-client';
import styles from './discover.module.css';

function duration(seconds: number | null | undefined) {
  if (!seconds) return null;
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, '0')}`;
}

export function useVideoPlayback(videos: YouTubeVideoLike[]) {
  const player = useMusicPlayer();
  const queue = videos.map(videoToTrack);
  return {
    isPlaying: (video: YouTubeVideoLike) =>
      player.currentTrack?.qualifiedId === `youtube:${video.videoId}` &&
      (player.status === 'playing' || player.status === 'loading'),
    play: (video: YouTubeVideoLike) => {
      const track = videoToTrack(video);
      if (player.currentTrack?.qualifiedId === track.qualifiedId) {
        void player.togglePlayback();
        return;
      }
      const path = trackStreamPath(track);
      if (path) void player.playTrack(track, path, queue);
    },
  };
}

export function YouTubeVideoList({
  videos,
  ranked = false,
}: {
  videos: YouTubeVideoLike[];
  ranked?: boolean;
}) {
  const library = useLibrary();
  const playback = useVideoPlayback(videos);

  const favorite = async (video: YouTubeVideoLike) => {
    try {
      await apiFetch('/api/music/collections', {
        method: 'POST',
        body: JSON.stringify({ action: 'favorite', source: 'youtube', sourceId: video.videoId }),
      });
      toast.success('Aggiunto ai Preferiti.');
    } catch {
      toast.error('Non è stato possibile aggiungerlo ai Preferiti.');
    }
  };

  return (
    <ol className={styles.list}>
      {videos.map((video, index) => {
        const playing = playback.isPlaying(video);
        return (
          <li key={video.videoId} className={`${styles.row} ${ranked ? styles.rankedRow : ''}`}>
            {ranked ? <span className={styles.rank}>{index + 1}</span> : null}
            <button
              type="button"
              className={`${styles.rowArt} ${styles.videoArt}`}
              onClick={() => playback.play(video)}
              aria-label={playing ? `Metti in pausa ${video.title}` : `Riproduci ${video.title}`}
            >
              <FallbackArt src={video.thumbnailUrl} label={video.title} size={160} />
              <span className={styles.videoArtIcon} aria-hidden="true">
                {playing ? <Pause /> : <Play />}
              </span>
            </button>
            <div className={styles.rowCopy}>
              <strong title={video.title}>{video.title}</strong>
              <span>
                {[video.channelTitle, duration(video.durationSeconds)].filter(Boolean).join(' · ')}
              </span>
            </div>
            <div className={styles.rowActions}>
              {library.signedIn ? (
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() => void favorite(video)}
                  aria-label={`Aggiungi ${video.title} ai Preferiti`}
                >
                  <Heart aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
