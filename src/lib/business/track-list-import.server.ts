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

/** Dati di un item "song" per una collection (per create/mirror). */
function songItemData(track: ImportedTrack, createdAt: Date) {
  return {
    source: 'song',
    sourceId: songSourceId(track.title, track.artist),
    title: track.title,
    creatorName: track.artist,
    artworkUrl: null,
    sourceUrl: track.sourceUrl,
    artistUrl: null,
    durationSeconds: track.durationSeconds,
    // Items are listed newest first: decreasing timestamps keep the list's order.
    createdAt,
    expiresAt: null,
  };
}

/**
 * Creates a playlist of imported songs, in the given order. `tracks` must already be unique by
 * songIdentity (parseTrackList and the Spotify import both dedupe). The caller checks the
 * per-user playlist cap. `spotifySource` marks the playlist as imported from Spotify ('saved' or
 * 'playlist:<id>') so "Aggiorna da Spotify" può risincronizzarla.
 */
export async function createSongPlaylist(
  userId: string,
  wantedName: string,
  tracks: ImportedTrack[],
  spotifySource: string | null = null,
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
          spotifySource,
          items: {
            create: tracks.map((track, index) => songItemData(track, new Date(now - index))),
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

export type UpsertResult = {
  collectionId: string;
  name: string;
  /** true quando la playlist Solco è stata creata adesso; false quando è stata aggiornata. */
  created: boolean;
  /** Brani aggiunti rispetto a prima. */
  added: number;
  /** Brani rimossi perché non più nella sorgente (0 per una nuova playlist). */
  removed: number;
};

/**
 * Upsert di una playlist importata da Spotify, identificata da `spotifySource`. Se non esiste la
 * crea; se esiste la aggiorna a SPECCHIO ESATTO: i suoi item "song" diventano esattamente `tracks`
 * (aggiunge i nuovi, rimuove quelli non più presenti), preservando l'id della playlist (quindi
 * condivisione/cartella) ed eventuali item non-"song" aggiunti a mano. `tracks` è già deduplicato.
 */
export async function upsertSpotifySongPlaylist(
  userId: string,
  spotifySource: string,
  wantedName: string,
  tracks: ImportedTrack[],
): Promise<UpsertResult> {
  const existing = await prisma.userMusicCollection.findFirst({
    where: { userId, spotifySource },
    select: { id: true, name: true },
  });
  if (!existing) {
    const { collectionId, name } = await createSongPlaylist(
      userId,
      wantedName,
      tracks,
      spotifySource,
    );
    return { collectionId, name, created: true, added: tracks.length, removed: 0 };
  }

  const current = await prisma.userMusicCollectionItem.findMany({
    where: { collectionId: existing.id, source: 'song' },
    select: { sourceId: true },
  });
  const oldIds = new Set(current.map((item) => item.sourceId));
  const newIds = new Set(tracks.map((track) => songSourceId(track.title, track.artist)));
  const added = [...newIds].filter((id) => !oldIds.has(id)).length;
  const removed = [...oldIds].filter((id) => !newIds.has(id)).length;

  const now = Date.now();
  // Specchio esatto in un'unica transazione (forma ad array: compatibile con il pooler): via tutti
  // gli item "song", poi ricrea l'insieme nuovo nell'ordine della sorgente.
  await prisma.$transaction([
    prisma.userMusicCollectionItem.deleteMany({
      where: { collectionId: existing.id, source: 'song' },
    }),
    prisma.userMusicCollectionItem.createMany({
      data: tracks.map((track, index) => ({
        collectionId: existing.id,
        ...songItemData(track, new Date(now - index)),
      })),
    }),
    prisma.userMusicCollection.update({
      where: { id: existing.id },
      data: { updatedAt: new Date() },
    }),
  ]);

  return { collectionId: existing.id, name: existing.name, created: false, added, removed };
}
