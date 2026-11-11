// @polsia:user-owned — identificativo stabile di un brano importato (artista + titolo) e creazione
// di una playlist di "song" (cercati su YouTube solo quando si ascoltano, vedi /api/music/resolve-song).
// Usato dall'importazione di un elenco/CSV e dal trasferimento da Spotify.
import 'server-only';
import { createHash } from 'node:crypto';
import { type ImportedTrack, songIdentity } from '@/lib/business/track-list-import';
import { prisma } from '@/lib/db';
import { isFavoritesName } from '@/lib/music/collections.server';

/** Same artist + title → same id, whatever the spelling, accents or punctuation. */
export function songSourceId(title: string, artist: string | null) {
  return createHash('sha256').update(songIdentity(title, artist)).digest('hex').slice(0, 32);
}

/** `wanted`, or a numbered variant when the person already has a playlist with that name. */
export async function availableCollectionName(userId: string, wanted: string) {
  const base = isFavoritesName(wanted) ? `${wanted} (importata)` : wanted;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base.slice(0, 44)} (${attempt + 1})`;
    const existing = await prisma.userMusicCollection.findFirst({
      where: { userId, name: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }
  return `${base.slice(0, 40)} ${Date.now().toString(36)}`;
}

function isUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

/**
 * Creates a playlist of imported songs, in the given order. `tracks` must already be unique by
 * songIdentity (parseTrackList and the Spotify import both dedupe). The caller checks the
 * per-user playlist cap.
 */
export async function createSongPlaylist(
  userId: string,
  wantedName: string,
  tracks: ImportedTrack[],
): Promise<{ collectionId: string; name: string }> {
  for (let attempt = 0; ; attempt += 1) {
    const name = await availableCollectionName(userId, wantedName);
    const now = Date.now();
    try {
      const collection = await prisma.userMusicCollection.create({
        data: {
          userId,
          name,
          kind: 'playlist',
          items: {
            create: tracks.map((track, index) => ({
              source: 'song',
              sourceId: songSourceId(track.title, track.artist),
              title: track.title,
              creatorName: track.artist,
              artworkUrl: null,
              sourceUrl: track.sourceUrl,
              artistUrl: null,
              durationSeconds: track.durationSeconds,
              // Items are listed newest first: decreasing timestamps keep the list's order.
              createdAt: new Date(now - index),
              expiresAt: null,
            })),
          },
        },
      });
      return { collectionId: collection.id, name };
    } catch (error) {
      // Another import took the same name in the meantime: pick the next free one.
      if (attempt < 2 && isUniqueViolation(error)) continue;
      throw error;
    }
  }
}
