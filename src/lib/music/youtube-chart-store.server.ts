// @polsia:user-owned — classifiche YouTube per paese salvate nel database, condivise da tutte le
// istanze e le regioni della CDN: ogni paese si aggiorna al massimo ogni 2 ore (1 unità di quota
// per aggiornamento, dalla quota delle classifiche nel budget delle chiamate da 1 unità). Un solo
// aggiornamento per paese alla volta, e dopo un aggiornamento non riuscito (budget finito, errore
// di YouTube) il successivo aspetta 30 minuti. Se YouTube non risponde o il budget è finito si
// mostra l'ultima classifica salvata solo se ha meno di 24 ore: una classifica dei "più popolari"
// più vecchia non è più quella attuale (la pulizia giornaliera cancella le classifiche oltre 24 ore).
import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';
import { noteYouTubeQuotaExceeded, takeYouTubeUnits } from '@/lib/music/youtube-budget.server';
import type { YouTubeChartVideo } from '@/lib/music/youtube-search.server';

export const YOUTUBE_CHART_FRESH_MS = 2 * 60 * 60 * 1000;
export const YOUTUBE_CHART_STALE_MS = 24 * 60 * 60 * 1000;
/** After a refresh that could not run or failed, the next try for that country waits this long. */
export const YOUTUBE_CHART_RETRY_MS = 30 * 60 * 1000;
/** Key prefix of saved charts in YouTubeSearchCache (the daily cleanup removes them after 24 h). */
export const YOUTUBE_CHART_KEY_PREFIX = 'chart:';

export type YouTubeChart = {
  outcome: 'results' | 'no_results' | 'unavailable';
  videos: YouTubeChartVideo[];
};
/** What the loader returns; `quotaExceeded`: YouTube said its daily quota is out. */
export type YouTubeChartLoad = YouTubeChart & { quotaExceeded?: boolean };

type Store = Pick<PrismaClient, 'youTubeSearchCache'>;
type Options = {
  now?: Date;
  db?: Store;
  takeUnit?: () => Promise<boolean>;
  /** Called when YouTube answers "quota exceeded" (blocks 1-unit calls for 30 minutes). */
  quotaExceeded?: () => Promise<void>;
};

export function youtubeChartKey(regionCode: string) {
  return `${YOUTUBE_CHART_KEY_PREFIX}${regionCode}`;
}

function readChart(value: Prisma.JsonValue): YouTubeChart | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { outcome?: unknown; videos?: unknown };
  if (
    (record.outcome !== 'results' && record.outcome !== 'no_results') ||
    !Array.isArray(record.videos)
  ) {
    return null;
  }
  return { outcome: record.outcome, videos: record.videos as YouTubeChartVideo[] };
}

/**
 * The right to refresh a country now. The row's expiresAt is the earliest time of the next try:
 * the request that moves it 30 minutes forward (one atomic UPDATE) refreshes, the others keep
 * the saved chart. Without a row, the first request creates a placeholder (no videos) that does
 * the same. A database error means no refresh (no unit is spent).
 */
async function claimRefresh(db: Store, key: string, hasRow: boolean, now: Date) {
  const next = new Date(now.getTime() + YOUTUBE_CHART_RETRY_MS);
  if (hasRow) {
    const claimed = await db.youTubeSearchCache.updateMany({
      where: { key, expiresAt: { lte: now } },
      data: { expiresAt: next },
    });
    return claimed.count > 0;
  }
  const empty: YouTubeChart = { outcome: 'unavailable', videos: [] };
  const created = await db.youTubeSearchCache.createMany({
    data: [
      { key, payload: empty as unknown as Prisma.InputJsonValue, createdAt: now, expiresAt: next },
    ],
    skipDuplicates: true,
  });
  return created.count > 0;
}

/**
 * Saved chart (2 h), else YouTube (1 budgeted unit, one request at a time, 30 minutes after a
 * failed try), else the last saved chart (24 h). `fetchedAt`: when YouTube sent the chart shown.
 */
export async function storedYouTubeChart(
  regionCode: string,
  load: () => Promise<YouTubeChartLoad>,
  options: Options = {},
): Promise<{ chart: YouTubeChart; stale: boolean; fetchedAt: Date | null }> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const key = youtubeChartKey(regionCode);
  const row = await Promise.resolve()
    .then(() => db.youTubeSearchCache.findUnique({ where: { key } }))
    .catch(() => null);
  const saved = row ? readChart(row.payload) : null;
  const age = row ? now.getTime() - row.createdAt.getTime() : Number.POSITIVE_INFINITY;
  if (row && saved && age < YOUTUBE_CHART_FRESH_MS) {
    return { chart: saved, stale: false, fetchedAt: row.createdAt };
  }

  const takeUnit = options.takeUnit ?? (() => takeYouTubeUnits(1, { purpose: 'chart', now }));
  const quotaExceeded = options.quotaExceeded ?? (() => noteYouTubeQuotaExceeded('units', now));
  let fresh: YouTubeChartLoad = { outcome: 'unavailable', videos: [] };
  const claimed = await claimRefresh(db, key, row !== null, now).catch(() => false);
  if (claimed && (await takeUnit())) {
    fresh = await load();
    if (fresh.quotaExceeded) await quotaExceeded();
  }
  if (fresh.outcome !== 'unavailable') {
    const chart: YouTubeChart = { outcome: fresh.outcome, videos: fresh.videos };
    const data = {
      payload: chart as unknown as Prisma.InputJsonValue,
      createdAt: now,
      expiresAt: new Date(now.getTime() + YOUTUBE_CHART_FRESH_MS),
    };
    await Promise.resolve()
      .then(() =>
        db.youTubeSearchCache.upsert({ where: { key }, create: { key, ...data }, update: data }),
      )
      .catch(() => undefined);
    return { chart, stale: false, fetchedAt: now };
  }
  if (row && saved && age < YOUTUBE_CHART_STALE_MS) {
    return { chart: saved, stale: true, fetchedAt: row.createdAt };
  }
  return { chart: { outcome: 'unavailable', videos: [] }, stale: false, fetchedAt: null };
}
