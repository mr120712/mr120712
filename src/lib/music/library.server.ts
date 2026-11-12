// @polsia:user-owned — Libreria: radio salvate, podcast seguiti, cartelle, cronologia, elementi nascosti.
import 'server-only';
import type { HistoryEntry, LibraryMutation, LibraryResponse } from '@/lib/contracts/library';
import { prisma } from '@/lib/db';
import {
  currentYouTubeHistoryIds,
  isYouTubeHistoryId,
  recordYouTubeHistoryFetch,
} from '@/lib/music/youtube-history.server';

const HISTORY_LIMIT = 50;
/** Righe massime per utente: oltre il limite non se ne creano di nuove e le letture restano limitate. */
export const LIBRARY_LIMITS = {
  stations: 500,
  podcasts: 500,
  folders: 100,
  hidden: 500,
  /** Cronologia conservata: gli ascolti più vecchi vengono eliminati. */
  history: 200,
} as const;
/** Playlist dentro cartelle lette per comporre `folders[].playlistIds`. */
const FOLDER_PLAYLISTS_READ_LIMIT = 500;
const HISTORY_PRUNE_BATCH = 100;

export class LibraryError extends Error {
  constructor(
    readonly code: 'not_found' | 'duplicate_name' | 'limit_reached',
    message: string,
  ) {
    super(message);
    this.name = 'LibraryError';
  }
}

export async function getLibrary(userId: string): Promise<LibraryResponse> {
  const [stations, podcasts, folders, playlists, history, hidden] = await Promise.all([
    prisma.userSavedStation.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: LIBRARY_LIMITS.stations,
    }),
    prisma.userPodcastFollow.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: LIBRARY_LIMITS.podcasts,
    }),
    prisma.userMusicFolder.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      take: LIBRARY_LIMITS.folders,
    }),
    prisma.userMusicCollection.findMany({
      where: { userId, kind: 'playlist', folderId: { not: null } },
      select: { id: true, folderId: true },
      take: FOLDER_PLAYLISTS_READ_LIMIT,
    }),
    prisma.userPlaybackHistory.findMany({
      where: { userId },
      orderBy: { lastPlayedAt: 'desc' },
      take: HISTORY_LIMIT,
    }),
    prisma.userHiddenItem.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: LIBRARY_LIMITS.hidden,
    }),
  ]);
  // YouTube entries are shown only while their YouTube data is less than 28 days old (counted
  // from when YouTube sent it, not from the last play), even if the daily cleanup was missed.
  const currentYouTube = await currentYouTubeHistoryIds(
    userId,
    history.map((entry) => entry.qualifiedId),
  );
  const visibleHistory = history.filter(
    (entry) => !isYouTubeHistoryId(entry.qualifiedId) || currentYouTube.has(entry.qualifiedId),
  );

  return {
    stations: stations.map((station) => ({
      stationId: station.stationId,
      name: station.name,
      artworkUrl: station.artworkUrl,
      country: station.country,
      tags: station.tags,
      homepage: station.homepage,
    })),
    podcasts: podcasts.map((podcast) => ({
      podcastId: podcast.podcastId,
      title: podcast.title,
      author: podcast.author,
      artworkUrl: podcast.artworkUrl,
    })),
    folders: folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      playlistIds: playlists.filter((item) => item.folderId === folder.id).map((item) => item.id),
    })),
    history: visibleHistory.map(
      (entry): HistoryEntry => ({
        qualifiedId: entry.qualifiedId,
        playbackMode: entry.playbackMode as HistoryEntry['playbackMode'],
        title: entry.title,
        artistName: entry.artistName,
        artworkUrl: entry.artworkUrl,
        sourceLabel: entry.sourceLabel,
        sourceUrl: entry.sourceUrl,
        albumId: entry.albumId,
        durationSeconds: entry.durationSeconds,
        playCount: entry.playCount,
        lastPlayedAt: entry.lastPlayedAt.toISOString(),
      }),
    ),
    hidden: hidden.map((item) => ({
      kind: item.kind as LibraryResponse['hidden'][number]['kind'],
      itemId: item.itemId,
      label: item.label,
    })),
  };
}

async function ownedFolder(userId: string, folderId: string) {
  const folder = await prisma.userMusicFolder.findFirst({ where: { id: folderId, userId } });
  if (!folder) throw new LibraryError('not_found', 'Cartella non trovata.');
  return folder;
}

/**
 * Blocca una nuova riga quando l'utente è al limite; `exists` permette di aggiornare
 * comunque una riga già salvata (gli upsert non aumentano il conteggio).
 */
async function ensureRoom(
  count: () => Promise<number>,
  limit: number,
  exists: (() => Promise<unknown>) | null,
  message: string,
) {
  if ((await count()) < limit) return;
  if (exists && (await exists())) return;
  throw new LibraryError('limit_reached', message);
}

async function pruneHistory(userId: string) {
  const stale = await prisma.userPlaybackHistory.findMany({
    where: { userId },
    orderBy: { lastPlayedAt: 'desc' },
    skip: LIBRARY_LIMITS.history,
    take: HISTORY_PRUNE_BATCH,
    select: { id: true },
  });
  if (stale.length === 0) return;
  await prisma.userPlaybackHistory.deleteMany({
    where: { userId, id: { in: stale.map((entry) => entry.id) } },
  });
}

async function uniqueFolderName(userId: string, name: string, exceptId?: string) {
  const existing = await prisma.userMusicFolder.findFirst({ where: { userId, name } });
  if (existing && existing.id !== exceptId) {
    throw new LibraryError('duplicate_name', 'Esiste già una cartella con questo nome.');
  }
}

export async function applyLibraryMutation(userId: string, action: LibraryMutation) {
  switch (action.action) {
    case 'record_play': {
      const { track } = action;
      const data = {
        playbackMode: track.playbackMode,
        title: track.title,
        artistName: track.artistName,
        artworkUrl: track.artworkUrl,
        sourceLabel: track.sourceLabel,
        sourceUrl: track.sourceUrl,
        albumId: track.albumId,
        durationSeconds: track.durationSeconds,
      };
      // YouTube data: dated (by the server) before the entry is written, never on replays.
      await recordYouTubeHistoryFetch(userId, track.qualifiedId);
      await prisma.userPlaybackHistory.upsert({
        where: { userId_qualifiedId: { userId, qualifiedId: track.qualifiedId } },
        create: { userId, qualifiedId: track.qualifiedId, ...data },
        update: { ...data, playCount: { increment: 1 }, lastPlayedAt: new Date() },
      });
      await pruneHistory(userId);
      return;
    }
    case 'clear_history':
      await prisma.userPlaybackHistory.deleteMany({ where: { userId } });
      await prisma.youTubeHistoryFetch.deleteMany({ where: { userId } });
      return;
    case 'save_station': {
      const { stationId, ...station } = action.station;
      await ensureRoom(
        () => prisma.userSavedStation.count({ where: { userId } }),
        LIBRARY_LIMITS.stations,
        () =>
          prisma.userSavedStation.findUnique({
            where: { userId_stationId: { userId, stationId } },
            select: { id: true },
          }),
        `Hai raggiunto il limite di ${LIBRARY_LIMITS.stations} radio salvate. Rimuovine una per salvarne altre.`,
      );
      await prisma.userSavedStation.upsert({
        where: { userId_stationId: { userId, stationId } },
        create: { userId, stationId, ...station },
        update: station,
      });
      return;
    }
    case 'unsave_station':
      await prisma.userSavedStation.deleteMany({ where: { userId, stationId: action.stationId } });
      return;
    case 'follow_podcast': {
      const { podcastId, ...podcast } = action.podcast;
      await ensureRoom(
        () => prisma.userPodcastFollow.count({ where: { userId } }),
        LIBRARY_LIMITS.podcasts,
        () =>
          prisma.userPodcastFollow.findUnique({
            where: { userId_podcastId: { userId, podcastId } },
            select: { id: true },
          }),
        `Hai raggiunto il limite di ${LIBRARY_LIMITS.podcasts} podcast seguiti. Smetti di seguirne uno per aggiungerne altri.`,
      );
      await prisma.userPodcastFollow.upsert({
        where: { userId_podcastId: { userId, podcastId } },
        create: { userId, podcastId, ...podcast },
        update: podcast,
      });
      return;
    }
    case 'unfollow_podcast':
      await prisma.userPodcastFollow.deleteMany({ where: { userId, podcastId: action.podcastId } });
      return;
    case 'create_folder':
      await uniqueFolderName(userId, action.name);
      await ensureRoom(
        () => prisma.userMusicFolder.count({ where: { userId } }),
        LIBRARY_LIMITS.folders,
        null,
        `Hai raggiunto il limite di ${LIBRARY_LIMITS.folders} cartelle. Eliminane una per crearne una nuova.`,
      );
      await prisma.userMusicFolder.create({ data: { userId, name: action.name } });
      return;
    case 'rename_folder':
      await ownedFolder(userId, action.folderId);
      await uniqueFolderName(userId, action.name, action.folderId);
      await prisma.userMusicFolder.update({
        where: { id: action.folderId },
        data: { name: action.name },
      });
      return;
    case 'delete_folder':
      await ownedFolder(userId, action.folderId);
      // Le playlist tornano nella radice della Libreria: non vengono eliminate.
      await prisma.userMusicCollection.updateMany({
        where: { userId, folderId: action.folderId },
        data: { folderId: null },
      });
      await prisma.userMusicFolder.delete({ where: { id: action.folderId } });
      return;
    case 'move_playlist': {
      if (action.folderId) await ownedFolder(userId, action.folderId);
      const moved = await prisma.userMusicCollection.updateMany({
        where: { id: action.collectionId, userId, kind: 'playlist' },
        data: { folderId: action.folderId },
      });
      if (moved.count === 0) throw new LibraryError('not_found', 'Playlist non trovata.');
      return;
    }
    case 'hide': {
      const { kind, itemId, label } = action.item;
      await ensureRoom(
        () => prisma.userHiddenItem.count({ where: { userId } }),
        LIBRARY_LIMITS.hidden,
        () =>
          prisma.userHiddenItem.findUnique({
            where: { userId_kind_itemId: { userId, kind, itemId } },
            select: { id: true },
          }),
        `Hai raggiunto il limite di ${LIBRARY_LIMITS.hidden} elementi nascosti. Mostrane di nuovo uno per nasconderne altri.`,
      );
      await prisma.userHiddenItem.upsert({
        where: { userId_kind_itemId: { userId, kind, itemId } },
        create: { userId, kind, itemId, label },
        update: { label },
      });
      return;
    }
    case 'unhide':
      await prisma.userHiddenItem.deleteMany({
        where: { userId, kind: action.kind, itemId: action.itemId },
      });
      return;
  }
}
