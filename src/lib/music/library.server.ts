// @polsia:user-owned — Libreria: radio salvate, podcast seguiti, cartelle, cronologia, elementi nascosti.
import 'server-only';
import type { HistoryEntry, LibraryMutation, LibraryResponse } from '@/lib/contracts/library';
import { prisma } from '@/lib/db';

const HISTORY_LIMIT = 50;

export class LibraryError extends Error {
  constructor(
    readonly code: 'not_found' | 'duplicate_name',
    message: string,
  ) {
    super(message);
    this.name = 'LibraryError';
  }
}

export async function getLibrary(userId: string): Promise<LibraryResponse> {
  const [stations, podcasts, folders, playlists, history, hidden] = await Promise.all([
    prisma.userSavedStation.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } }),
    prisma.userPodcastFollow.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } }),
    prisma.userMusicFolder.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    prisma.userMusicCollection.findMany({
      where: { userId, kind: 'playlist', folderId: { not: null } },
      select: { id: true, folderId: true },
    }),
    prisma.userPlaybackHistory.findMany({
      where: { userId },
      orderBy: { lastPlayedAt: 'desc' },
      take: HISTORY_LIMIT,
    }),
    prisma.userHiddenItem.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } }),
  ]);

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
    history: history.map(
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
      await prisma.userPlaybackHistory.upsert({
        where: { userId_qualifiedId: { userId, qualifiedId: track.qualifiedId } },
        create: { userId, qualifiedId: track.qualifiedId, ...data },
        update: { ...data, playCount: { increment: 1 }, lastPlayedAt: new Date() },
      });
      return;
    }
    case 'clear_history':
      await prisma.userPlaybackHistory.deleteMany({ where: { userId } });
      return;
    case 'save_station': {
      const { stationId, ...station } = action.station;
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
