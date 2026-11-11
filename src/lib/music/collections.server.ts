// @polsia:user-owned
import 'server-only';
import { prisma } from '@/lib/db';
import {
  getAudiusPlaybackReasonText,
  isAudiusOpenMusicLicense,
  normalizeAudiusTracks,
} from '@/lib/music/audius';
import { createAudiusApiClient } from '@/lib/music/audius-api.server';
import { getAudiusActivation } from '@/lib/music/audius-source.server';
import { readYouTubeApiKey } from '@/lib/music/music-api.server';
import { getYouTubeVideoDetails } from '@/lib/music/youtube-search.server';

export const YOUTUBE_METADATA_RETENTION_DAYS = 29;
const DAY_MS = 24 * 60 * 60 * 1000;
const FAVORITES_NAME = 'Preferiti';
/** Limiti per utente: playlist create (Preferiti escluso) ed elementi per raccolta. */
export const MAX_PLAYLISTS_PER_USER = 100;
export const MAX_ITEMS_PER_COLLECTION = 500;

export class MusicCollectionError extends Error {
  constructor(
    readonly code:
      | 'invalid_source'
      | 'source_inactive'
      | 'metadata_unavailable'
      | 'license_not_allowed'
      | 'duplicate_name'
      | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'MusicCollectionError';
  }
}

export function youtubeMetadataExpiry(now = new Date()) {
  return new Date(now.getTime() + YOUTUBE_METADATA_RETENTION_DAYS * DAY_MS);
}

export async function expireYouTubeCollectionMetadata(now = new Date(), userId?: string) {
  return prisma.userMusicCollectionItem.updateMany({
    where: {
      source: 'youtube',
      expiresAt: { lte: now },
      ...(userId ? { collection: { userId } } : {}),
    },
    data: {
      title: null,
      creatorName: null,
      artworkUrl: null,
      sourceUrl: null,
      artistUrl: null,
      durationSeconds: null,
      expiresAt: null,
    },
  });
}

export async function getUserMusicCollections(userId: string) {
  await expireYouTubeCollectionMetadata(new Date(), userId);
  await prisma.userMusicCollection.upsert({
    where: { userId_name: { userId, name: FAVORITES_NAME } },
    create: { userId, name: FAVORITES_NAME, kind: 'favorites' },
    update: {},
  });
  const rows = await prisma.userMusicCollection.findMany({
    where: { userId },
    include: { items: { orderBy: { createdAt: 'desc' } } },
    orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map((collection) => ({
    id: collection.id,
    name: collection.name,
    kind: collection.kind,
    folderId: collection.folderId,
    createdAt: collection.createdAt.toISOString(),
    items: collection.items.map((item) => ({
      id: item.id,
      source: item.source,
      sourceId: item.sourceId,
      title: item.title,
      creatorName: item.creatorName,
      artworkUrl: item.artworkUrl,
      sourceUrl: item.sourceUrl,
      artistUrl: item.artistUrl,
      durationSeconds: item.durationSeconds,
      createdAt: item.createdAt.toISOString(),
      expiresAt: item.expiresAt?.toISOString() ?? null,
    })),
  }));
}

async function collectionMetadata(source: 'audius' | 'youtube', sourceId: string) {
  if (source === 'youtube') {
    const key = readYouTubeApiKey();
    if (!key)
      throw new MusicCollectionError(
        'source_inactive',
        'Manca il segreto server-side YOUTUBE_DATA_API_KEY.',
      );
    const result = await getYouTubeVideoDetails(sourceId, key);
    if (result.outcome !== 'found') {
      throw new MusicCollectionError(
        'metadata_unavailable',
        'YouTube non ha confermato i metadati correnti del video.',
      );
    }
    const video = result.details.video;
    return {
      source,
      sourceId,
      title: video.title,
      creatorName: video.channelTitle,
      artworkUrl: video.thumbnailUrl,
      sourceUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`,
      artistUrl: null,
      durationSeconds: null,
      expiresAt: youtubeMetadataExpiry(),
    };
  }

  const activation = getAudiusActivation();
  if (!activation.active) {
    throw new MusicCollectionError(
      'source_inactive',
      'Audius non è configurata: manca AUDIUS_API_KEY lato server.',
    );
  }
  const client = createAudiusApiClient({ apiKey: activation.apiKey });
  let payload: unknown;
  try {
    payload = await client.getTrack(sourceId);
  } catch {
    throw new MusicCollectionError(
      'metadata_unavailable',
      'Audius non ha confermato i metadati correnti del brano.',
    );
  }
  const track = normalizeAudiusTracks(payload, true).find((item) => item.id === sourceId);
  if (!track?.artistName || !track.artistUrl) {
    throw new MusicCollectionError(
      'metadata_unavailable',
      'Audius non ha restituito attribuzione completa per questo brano.',
    );
  }
  // Only Open Music License tracks play on Solco: a track under another licence is not saved
  // (its play button could only fail). The stream route re-checks the licence on every play.
  if (track.playbackReason === 'license_not_allowed' || !isAudiusOpenMusicLicense(track.license)) {
    throw new MusicCollectionError(
      'license_not_allowed',
      getAudiusPlaybackReasonText('license_not_allowed'),
    );
  }
  return {
    source,
    sourceId,
    title: track.title,
    creatorName: track.artistName,
    artworkUrl: track.artworkUrl,
    sourceUrl: track.trackUrl,
    artistUrl: track.artistUrl,
    durationSeconds: track.durationSeconds,
    expiresAt: null,
  };
}

export async function resolveCollectionItem(source: 'audius' | 'youtube', sourceId: string) {
  if (source === 'youtube' && !/^[A-Za-z0-9_-]{11}$/.test(sourceId)) {
    throw new MusicCollectionError('invalid_source', 'ID video YouTube non valido.');
  }
  if (source === 'audius' && !/^[A-Za-z0-9_-]{1,128}$/.test(sourceId)) {
    throw new MusicCollectionError('invalid_source', 'ID brano Audius non valido.');
  }
  return collectionMetadata(source, sourceId);
}

export async function ensureFavoritesCollection(userId: string) {
  return prisma.userMusicCollection.upsert({
    where: { userId_name: { userId, name: FAVORITES_NAME } },
    create: { userId, name: FAVORITES_NAME, kind: 'favorites' },
    update: {},
  });
}

export function isFavoritesName(name: string) {
  return name.trim().toLocaleLowerCase('it-IT') === FAVORITES_NAME.toLocaleLowerCase('it-IT');
}
