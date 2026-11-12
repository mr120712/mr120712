// @polsia:user-owned — elementi di una raccolta (Preferiti, playlist, playlist condivise) → brani del
// player Solco. Una sola conversione per la Libreria e per la pagina pubblica /playlist/<id>.
import {
  type MusicPlayerTrack,
  trackStreamPath,
  type useMusicPlayer,
} from '@/components/custom/music/music-player';
import type { MusicCollectionItem } from '@/lib/contracts/music';
import { videoToTrack } from './live-tracks';

export type CollectionTrackItem = Pick<
  MusicCollectionItem,
  | 'source'
  | 'sourceId'
  | 'title'
  | 'creatorName'
  | 'artworkUrl'
  | 'sourceUrl'
  | 'artistUrl'
  | 'durationSeconds'
>;

type CollectionPlayer = Pick<
  ReturnType<typeof useMusicPlayer>,
  'currentTrack' | 'togglePlayback' | 'playTrack'
>;

export function collectionItemQualifiedId(item: Pick<CollectionTrackItem, 'source' | 'sourceId'>) {
  return `${item.source}:${item.sourceId}`;
}

/**
 * The player track of a saved item, or null when it cannot start: YouTube metadata removed after
 * expiry, or an Audius item without complete attribution (the stream route re-checks rights).
 */
export function collectionItemToTrack(item: CollectionTrackItem): MusicPlayerTrack | null {
  if (item.source === 'song') {
    return item.title && /^[a-f0-9]{32}$/.test(item.sourceId)
      ? {
          qualifiedId: `song:${item.sourceId}`,
          title: item.title,
          artistName: item.creatorName ?? '',
          artworkUrl: null,
          sourceLabel: 'YouTube',
          sourceUrl: item.sourceUrl,
          sourceUrlLabel: item.sourceUrl ? 'Apri su Spotify' : undefined,
          durationSeconds: item.durationSeconds,
          playbackMode: 'song',
        }
      : null;
  }
  if (item.source === 'youtube') {
    return item.title && /^[A-Za-z0-9_-]{11}$/.test(item.sourceId)
      ? videoToTrack({
          videoId: item.sourceId,
          title: item.title,
          channelTitle: item.creatorName ?? 'YouTube',
          thumbnailUrl: item.artworkUrl,
        })
      : null;
  }
  if (
    item.source !== 'audius' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(item.sourceId) ||
    !item.title ||
    !item.creatorName ||
    !item.artworkUrl ||
    !item.artistUrl ||
    !item.sourceUrl
  ) {
    return null;
  }
  return {
    qualifiedId: `audius:${item.sourceId}`,
    title: item.title,
    artistName: item.creatorName,
    artistUrl: item.artistUrl,
    artworkUrl: item.artworkUrl,
    sourceLabel: 'Solco · Audius',
    sourceUrl: item.sourceUrl,
    sourceUrlLabel: 'Apri il brano su Audius',
    durationSeconds: item.durationSeconds,
    playbackMode: 'audius',
  };
}

/** The playable items of a collection, in order: the queue of the shared player. */
export function collectionQueue(items: readonly CollectionTrackItem[]): MusicPlayerTrack[] {
  return items.flatMap((item) => {
    const track = collectionItemToTrack(item);
    return track ? [track] : [];
  });
}

export function isCollectionItemCurrent(
  player: Pick<CollectionPlayer, 'currentTrack'>,
  item: Pick<CollectionTrackItem, 'source' | 'sourceId'>,
) {
  const qualifiedId = collectionItemQualifiedId(item);
  return (
    player.currentTrack?.qualifiedId === qualifiedId ||
    player.currentTrack?.importedFrom === qualifiedId
  );
}

/** Plays one item inside its collection's queue; on the current item it pauses or resumes. */
export function playCollectionItem(
  player: CollectionPlayer,
  item: Pick<CollectionTrackItem, 'source' | 'sourceId'>,
  queue: MusicPlayerTrack[],
) {
  const qualifiedId = collectionItemQualifiedId(item);
  const current = queue.find((track) => track.qualifiedId === qualifiedId);
  if (!current) return;
  if (isCollectionItemCurrent(player, item)) {
    void player.togglePlayback();
    return;
  }
  const path = trackStreamPath(current);
  if (path) void player.playTrack(current, path, queue);
}

function shuffledCopy<T>(items: readonly T[]) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}

/** "Riproduci tutto" / "Casuale": starts the queue from its first item (shuffled for Casuale). */
export function playCollectionQueue(
  player: Pick<CollectionPlayer, 'playTrack'>,
  queue: MusicPlayerTrack[],
  shuffle = false,
) {
  const ordered = shuffle ? shuffledCopy(queue) : queue;
  const first = ordered[0];
  const path = first ? trackStreamPath(first) : null;
  if (first && path) void player.playTrack(first, path, ordered);
}
