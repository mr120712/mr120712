// @polsia:user-owned — pulizia giornaliera (Vercel Cron, vedi vercel.json). Dati dell'API YouTube
// (norme: cancellati o aggiornati entro 30 giorni da quando YouTube li ha inviati; qui con
// margine, così tra due esecuzioni nulla supera circa 29 giorni): ricerche salvate oltre 28
// giorni e classifiche oltre 24 ore, brani risolti scaduti o arrivati da YouTube oltre 28 giorni
// fa, metadati delle raccolte che scadono entro la prossima pulizia, voci YouTube della
// cronologia di ascolto i cui dati sono arrivati da YouTube oltre 28 giorni fa (o senza data).
// Poi contatori della quota dei giorni passati, contatori dei limiti per azione (account o IP
// con hash) fermi da 2 giorni, piani AI scaduti ed esiti dei controlli automatici oltre 30
// giorni. A fine lavoro salva il battito 'cleanup', letto dal controllo "Pulizia giornaliera".
// Vercel invia "Authorization: Bearer <CRON_SECRET>"; senza segreto valido risponde 401.
import 'server-only';
import { NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/business/cron-auth.server';
import { prisma } from '@/lib/db';
import { CLEANUP_HEARTBEAT } from '@/lib/monitoring/checks.server';
import { recordHeartbeat } from '@/lib/monitoring/monitor.server';
import { expireYouTubeCollectionMetadata } from '@/lib/music/collections.server';
import { FOUND_TTL_MS } from '@/lib/music/song-resolve.server';
import { deleteOldYouTubeQuotaUsage } from '@/lib/music/youtube-budget.server';
import {
  YOUTUBE_CHART_KEY_PREFIX,
  YOUTUBE_CHART_STALE_MS,
} from '@/lib/music/youtube-chart-store.server';
import { deleteExpiredYouTubeHistory } from '@/lib/music/youtube-history.server';
import { YOUTUBE_STORE_MAX_AGE_MS } from '@/lib/music/youtube-search-store.server';

export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;
const MONITOR_RUN_MAX_AGE_MS = 30 * DAY_MS;
/**
 * Rate-limit rows not written for this long only hold timestamps outside every window (the
 * longest in ACTION_RATE_LIMITS is 24 h; the YouTube budget reads only today's old counters).
 */
const RATE_LIMIT_ROW_MAX_AGE_MS = 2 * DAY_MS;
/** The cleanup runs once a day: metadata expiring before the next run goes now. */
const NEXT_RUN_MS = DAY_MS;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const now = new Date();
  const [collections, resolutions, searches, history, quotaDays, rateLimits, plans, monitorRuns] =
    await Promise.all([
      expireYouTubeCollectionMetadata(new Date(now.getTime() + NEXT_RUN_MS)),
      // createdAt is when YouTube sent the data: rows written with the older 29-day expiry
      // would otherwise stay until about 30 days.
      prisma.songResolution.deleteMany({
        where: {
          OR: [
            { expiresAt: { lte: now } },
            { createdAt: { lt: new Date(now.getTime() - FOUND_TTL_MS) } },
          ],
        },
      }),
      prisma.youTubeSearchCache.deleteMany({
        where: {
          OR: [
            { createdAt: { lt: new Date(now.getTime() - YOUTUBE_STORE_MAX_AGE_MS) } },
            // A chart is never shown 24 h after YouTube sent it: no reason to keep it.
            {
              key: { startsWith: YOUTUBE_CHART_KEY_PREFIX },
              createdAt: { lt: new Date(now.getTime() - YOUTUBE_CHART_STALE_MS) },
            },
          ],
        },
      }),
      // Aged by when YouTube sent the data (YouTubeHistoryFetch), never by the last play.
      deleteExpiredYouTubeHistory(now),
      deleteOldYouTubeQuotaUsage(now),
      prisma.actionRateLimit.deleteMany({
        where: { updatedAt: { lt: new Date(now.getTime() - RATE_LIMIT_ROW_MAX_AGE_MS) } },
      }),
      prisma.aiMusicSearchCache.deleteMany({ where: { expiresAt: { lte: now } } }),
      prisma.monitorRun.deleteMany({
        where: { startedAt: { lt: new Date(now.getTime() - MONITOR_RUN_MAX_AGE_MS) } },
      }),
    ]);
  const removed = {
    youtubeCollectionItems: collections.count,
    songResolutions: resolutions.count,
    youtubeSearches: searches.count,
    youtubeHistory: history.count,
    youtubeQuotaDays: quotaDays.count,
    rateLimitRows: rateLimits.count,
    aiPlans: plans.count,
    monitorRuns: monitorRuns.count,
  };
  await recordHeartbeat(
    CLEANUP_HEARTBEAT,
    `Rimossi: ${removed.youtubeCollectionItems} dati YouTube, ${removed.songResolutions} brani risolti, ` +
      `${removed.youtubeSearches} ricerche salvate, ${removed.youtubeHistory} ascolti YouTube vecchi, ` +
      `${removed.aiPlans} piani AI, ${removed.monitorRuns} controlli vecchi`,
  );
  return NextResponse.json(removed, { headers: { 'Cache-Control': 'no-store' } });
}
