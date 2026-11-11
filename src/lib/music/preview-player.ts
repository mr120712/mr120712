// @polsia:user-owned
import { FREE_PREVIEW_LIMIT_SECONDS } from '@/lib/music/playback-policy';

export type PreviewMedia = {
  currentTime: number;
  duration: number;
  pause: () => void;
};

/** Stops playback and clamps seeking at the shortest verified preview boundary. */
export function enforcePreviewBoundary(media: PreviewMedia, authorizedSeconds: number) {
  if (!Number.isFinite(authorizedSeconds) || authorizedSeconds <= 0) return null;

  const boundaries = [FREE_PREVIEW_LIMIT_SECONDS, authorizedSeconds];
  if (Number.isFinite(media.duration) && media.duration > 0) boundaries.push(media.duration);
  const boundary = Math.min(...boundaries);

  if (media.currentTime >= boundary) {
    if (media.currentTime !== boundary) media.currentTime = boundary;
    media.pause();
  }
  return boundary;
}
