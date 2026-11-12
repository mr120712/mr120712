// @polsia:user-owned — cronologia di ascolto e dati dell'API YouTube. Titolo, canale e miniatura di
// un video sono dati dell'API: vanno cancellati entro 30 giorni da quando YouTube li ha inviati
// (qui 28, con la pulizia giornaliera). L'età si misura da quell'invio, mai dall'ultimo ascolto:
// alla prima riproduzione il server data i dati con la copia più vecchia che conserva di quel
// video (ricerche e classifiche salvate, brani risolti, raccolte) e la data non si sposta più
// quando il brano viene riascoltato. Senza nessuna copia i dati non si possono datare (possono
// venire da una coda salvata nel browser settimane prima): la voce non viene mostrata. Le voci
// YouTube senza data valida non vengono mostrate e la pulizia giornaliera le cancella (anche
// quelle salvate prima che la data esistesse).
import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';

const DAY_MS = 24 * 60 * 60 * 1000;
/** YouTube entries of the listening history are deleted 28 days after YouTube sent their data. */
export const YOUTUBE_HISTORY_MAX_AGE_MS = 28 * DAY_MS;
/** Collections keep YouTube metadata 29 days from their videos.list call (collections.server). */
const COLLECTION_METADATA_RETENTION_MS = 29 * DAY_MS;
const YOUTUBE_PREFIX = 'youtube:';

export type YouTubeHistoryDb = Pick<
  PrismaClient,
  | 'youTubeHistoryFetch'
  | 'youTubeSearchCache'
  | 'songResolution'
  | 'userMusicCollectionItem'
  | '$executeRaw'
>;

export function isYouTubeHistoryId(qualifiedId: string) {
  return qualifiedId.startsWith(YOUTUBE_PREFIX);
}

/** Dates at or before this are too old to keep. */
export function youtubeHistoryCutoff(now: Date = new Date()) {
  return new Date(now.getTime() - YOUTUBE_HISTORY_MAX_AGE_MS);
}

/** A saved search re-checked with videos.list carries data as recent as that re-check. */
function savedDataTime(row: { createdAt: Date; payload: Prisma.JsonValue }) {
  const payload = row.payload;
  const checkedAt =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Date.parse(String((payload as { checkedAt?: unknown }).checkedAt ?? ''))
      : Number.NaN;
  return Math.max(row.createdAt.getTime(), Number.isFinite(checkedAt) ? checkedAt : 0);
}

/**
 * When YouTube sent the data a listener plays for this video, as far as the server can tell: the
 * oldest copy it keeps (saved search or chart, matched song, collection item). The listener may
 * have got the title from any of them, so the oldest is the safe date. Without any copy the age
 * is unknown (every server source is stored, so the browser most likely kept old data, such as
 * a player queue restored weeks later): the date is the cutoff, so the entry is not shown and
 * the next cleanup removes it; a later play dates it again once a copy exists.
 * Database errors are not hidden: a play that cannot be dated is not recorded.
 */
export async function youtubeDataFetchedAt(
  videoId: string,
  now: Date = new Date(),
  db: Omit<YouTubeHistoryDb, 'youTubeHistoryFetch' | '$executeRaw'> = prisma,
): Promise<Date> {
  const [searches, song, collection] = await Promise.all([
    db.youTubeSearchCache.findMany({
      where: { payload: { path: ['videos'], array_contains: [{ videoId }] } },
      select: { createdAt: true, payload: true },
    }),
    db.songResolution.findFirst({
      where: { videoId },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    db.userMusicCollectionItem.findFirst({
      where: { source: 'youtube', sourceId: videoId, expiresAt: { not: null } },
      orderBy: { expiresAt: 'asc' },
      select: { expiresAt: true },
    }),
  ]);
  const times = searches.map(savedDataTime);
  if (song) times.push(song.createdAt.getTime());
  if (collection?.expiresAt) {
    times.push(collection.expiresAt.getTime() - COLLECTION_METADATA_RETENTION_MS);
  }
  if (times.length === 0) return youtubeHistoryCutoff(now);
  return new Date(Math.min(now.getTime(), ...times));
}

/**
 * Called before a YouTube play is written to the history. A replay keeps the date it already has
 * (never moved forward); a first play, or one whose date expired, is dated again
 * (youtubeDataFetchedAt).
 */
export async function recordYouTubeHistoryFetch(
  userId: string,
  qualifiedId: string,
  now: Date = new Date(),
  db: Omit<YouTubeHistoryDb, '$executeRaw'> = prisma,
) {
  if (!isYouTubeHistoryId(qualifiedId)) return;
  const where = { userId_qualifiedId: { userId, qualifiedId } };
  const existing = await db.youTubeHistoryFetch.findUnique({
    where,
    select: { fetchedAt: true },
  });
  if (existing && existing.fetchedAt > youtubeHistoryCutoff(now)) return;
  const fetchedAt = await youtubeDataFetchedAt(qualifiedId.slice(YOUTUBE_PREFIX.length), now, db);
  await db.youTubeHistoryFetch.upsert({
    where,
    create: { userId, qualifiedId, fetchedAt },
    update: { fetchedAt },
  });
}

/** The YouTube entries (of those given) that may still be shown: dated less than 28 days ago. */
export async function currentYouTubeHistoryIds(
  userId: string,
  qualifiedIds: string[],
  now: Date = new Date(),
  db: Pick<YouTubeHistoryDb, 'youTubeHistoryFetch'> = prisma,
): Promise<Set<string>> {
  const wanted = qualifiedIds.filter(isYouTubeHistoryId);
  if (wanted.length === 0) return new Set();
  const rows = await db.youTubeHistoryFetch.findMany({
    where: { userId, qualifiedId: { in: wanted }, fetchedAt: { gt: youtubeHistoryCutoff(now) } },
    select: { qualifiedId: true },
  });
  return new Set(rows.map((row) => row.qualifiedId));
}

/**
 * Daily cleanup: dates older than 28 days go, then every YouTube history entry without a date
 * (its data expired, or it was saved before dates were kept and cannot be dated). The plain SQL
 * has no parameters; record_play writes the date before the entry, so a new play is never caught
 * in between.
 */
export async function deleteExpiredYouTubeHistory(
  now: Date = new Date(),
  db: Pick<YouTubeHistoryDb, 'youTubeHistoryFetch' | '$executeRaw'> = prisma,
) {
  const dates = await db.youTubeHistoryFetch.deleteMany({
    where: { fetchedAt: { lte: youtubeHistoryCutoff(now) } },
  });
  const entries = await db.$executeRaw`
    DELETE FROM "UserPlaybackHistory" AS h
    WHERE h."qualifiedId" LIKE 'youtube:%'
      AND NOT EXISTS (
        SELECT 1 FROM "YouTubeHistoryFetch" AS f
        WHERE f."userId" = h."userId" AND f."qualifiedId" = h."qualifiedId"
      )`;
  return { count: entries, dates: dates.count };
}
