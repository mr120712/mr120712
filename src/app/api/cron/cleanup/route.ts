// @polsia:user-owned — pulizia giornaliera (Vercel Cron, vedi vercel.json): dati YouTube scaduti
// (norme API: meno di 30 giorni), cache delle ricerche oltre 7 giorni, piani AI scaduti, esiti
// dei controlli automatici oltre 30 giorni. A fine lavoro salva il battito 'cleanup', letto dal
// controllo "Pulizia giornaliera". Vercel invia "Authorization: Bearer <CRON_SECRET>"; senza
// segreto valido risponde 401.
import 'server-only';
import { NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/business/cron-auth.server';
import { prisma } from '@/lib/db';
import { CLEANUP_HEARTBEAT } from '@/lib/monitoring/checks.server';
import { recordHeartbeat } from '@/lib/monitoring/monitor.server';
import { expireYouTubeCollectionMetadata } from '@/lib/music/collections.server';

export const dynamic = 'force-dynamic';

const SEARCH_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MONITOR_RUN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const now = new Date();
  const [collections, resolutions, searches, plans, monitorRuns] = await Promise.all([
    expireYouTubeCollectionMetadata(now),
    prisma.songResolution.deleteMany({ where: { expiresAt: { lte: now } } }),
    prisma.youTubeSearchCache.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - SEARCH_CACHE_MAX_AGE_MS) } },
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
    aiPlans: plans.count,
    monitorRuns: monitorRuns.count,
  };
  await recordHeartbeat(
    CLEANUP_HEARTBEAT,
    `Rimossi: ${removed.youtubeCollectionItems} dati YouTube, ${removed.songResolutions} brani risolti, ` +
      `${removed.youtubeSearches} ricerche salvate, ${removed.aiPlans} piani AI, ` +
      `${removed.monitorRuns} controlli vecchi`,
  );
  return NextResponse.json(removed, { headers: { 'Cache-Control': 'no-store' } });
}
