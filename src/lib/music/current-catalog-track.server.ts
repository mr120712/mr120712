// @polsia:user-owned
import 'server-only';
import { getAudiusAlbumCatalogDetail } from '@/lib/music/audius-source.server';

export type CurrentAudiusTrackCheck =
  | { state: 'current' }
  | { state: 'not_found' }
  | { state: 'unavailable' };

/** Confirms the exact album/track pair against Audius on every protected request. */
export async function checkCurrentAudiusTrack(
  albumId: string,
  trackId: string,
): Promise<CurrentAudiusTrackCheck> {
  const catalog = await getAudiusAlbumCatalogDetail(albumId);
  if (catalog.state === 'unavailable') return { state: 'unavailable' };
  if (catalog.state !== 'available') return { state: 'not_found' };
  return catalog.tracks.some((track) => track.id === trackId)
    ? { state: 'current' }
    : { state: 'not_found' };
}
