// @polsia:user-owned — playlist condivise con un link pubblico (/playlist/<shareId>): creazione
// dell'id, lettura anonima (solo i campi del player, metadati YouTube scaduti omessi) e copertine
// Audius per l'anteprima social (mai miniature YouTube).
import 'server-only';
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import {
  MAX_ITEMS_PER_COLLECTION,
  withoutExpiredYouTubeMetadata,
} from '@/lib/music/collections.server';
import { isShareId, sharedPlaylistOwnerName, sharedPlaylistPath } from '@/lib/music/playlist-share';
import { isShareableCoverUrl } from '@/lib/music/shareable-cover';
import { siteUrl } from '@/lib/site';

/** 16 byte da crypto in base64url: 22 caratteri, non indovinabili né enumerabili. */
export function generateShareId() {
  return randomBytes(16).toString('base64url');
}

export function sharedPlaylistUrl(shareId: string) {
  return `${siteUrl}${sharedPlaylistPath(shareId)}`;
}

// No row id: the public page keys items by `source:sourceId` (unique in a collection).
const sharedItemSelect = {
  source: true,
  sourceId: true,
  title: true,
  creatorName: true,
  artworkUrl: true,
  sourceUrl: true,
  artistUrl: true,
  durationSeconds: true,
  createdAt: true,
  expiresAt: true,
} as const;

/**
 * La playlist condivisa con questo id, con gli elementi nello stesso ordine della Libreria del
 * proprietario (più recenti prima) e i metadati YouTube scaduti già rimossi. null se l'id non ha
 * il formato giusto (nessuna query), non esiste, la playlist non è più condivisa oppure il
 * proprietario non esiste più o è stato bannato (come findAvailableUsers della community).
 */
export async function findSharedCollection(shareId: string, now = new Date()) {
  if (!isShareId(shareId)) return null;
  const collection = await prisma.userMusicCollection.findFirst({
    where: { shareId },
    select: {
      name: true,
      kind: true,
      userId: true,
      sharedAt: true,
      updatedAt: true,
      items: {
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: MAX_ITEMS_PER_COLLECTION,
        select: sharedItemSelect,
      },
    },
  });
  if (!collection || collection.kind !== 'playlist' || !collection.sharedAt) return null;
  const owner = await prisma.user.findUnique({
    where: { id: collection.userId },
    select: { name: true, banned: true },
  });
  if (!owner || owner.banned === true) return null;
  return {
    ...collection,
    ownerName: owner.name,
    items: collection.items.map((item) => withoutExpiredYouTubeMetadata(item, now)),
  };
}

/** Fonti che il player e la pagina pubblica sanno mostrare (come la Libreria). */
const PUBLIC_SOURCES = new Set(['audius', 'youtube', 'song']);

/**
 * Risposta pubblica di GET /api/music/shared/[shareId]: nessun userId, email, id della raccolta o
 * dei suoi elementi.
 */
export async function getSharedPlaylist(shareId: string, now = new Date()) {
  const collection = await findSharedCollection(shareId, now);
  if (!collection) return null;
  // Adding or removing a song does not touch the playlist row: the newest item counts too.
  const newestItem = collection.items.reduce<Date | null>(
    (latest, item) => (!latest || item.createdAt > latest ? item.createdAt : latest),
    null,
  );
  const updatedAt =
    newestItem && newestItem > collection.updatedAt ? newestItem : collection.updatedAt;
  const items = collection.items.filter((item) => PUBLIC_SOURCES.has(item.source));
  return {
    name: collection.name,
    owner: sharedPlaylistOwnerName(collection.ownerName),
    itemCount: items.length,
    items: items.map((item) => ({
      source: item.source,
      sourceId: item.sourceId,
      title: item.title,
      creatorName: item.creatorName,
      artworkUrl: item.artworkUrl,
      sourceUrl: item.sourceUrl,
      artistUrl: item.artistUrl,
      durationSeconds: item.durationSeconds,
    })),
    updatedAt: updatedAt.toISOString(),
  };
}

// La regola delle copertine condivisibili vive in un modulo comune (client e server): la usano
// anche la condivisione di un brano e la sua anteprima social.
export { isShareableCoverUrl } from '@/lib/music/shareable-cover';

/** Fino a `limit` copertine Audius diverse, nell'ordine della playlist: mai elementi YouTube. */
export function sharedPlaylistCovers(
  items: ReadonlyArray<{ source: string; artworkUrl: string | null }>,
  limit = 4,
): string[] {
  const covers: string[] = [];
  for (const item of items) {
    if (covers.length >= limit) break;
    if (
      item.source === 'audius' &&
      isShareableCoverUrl(item.artworkUrl) &&
      !covers.includes(item.artworkUrl)
    ) {
      covers.push(item.artworkUrl);
    }
  }
  return covers;
}
