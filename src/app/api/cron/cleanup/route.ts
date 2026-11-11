// @polsia:user-owned — pulizia giornaliera (Vercel Cron, vedi vercel.json): dati YouTube scaduti
// (norme API: meno di 30 giorni), cache delle ricerche oltre 7 giorni, piani AI scaduti.
// Vercel invia "Authorization: Bearer <CRON_SECRET>"; senza segreto valido risponde 401.
import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { expireYouTubeCollectionMetadata } from '@/lib/music/collections.server';

export const dynamic = 'force-dynamic';

const SEARCH_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 24) return false;
  const given = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const now = new Date();
  const [collections, resolutions, searches, plans] = await Promise.all([
    expireYouTubeCollectionMetadata(now),
    prisma.songResolution.deleteMany({ where: { expiresAt: { lte: now } } }),
    prisma.youTubeSearchCache.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - SEARCH_CACHE_MAX_AGE_MS) } },
    }),
    prisma.aiMusicSearchCache.deleteMany({ where: { expiresAt: { lte: now } } }),
  ]);
  return NextResponse.json(
    {
      youtubeCollectionItems: collections.count,
      songResolutions: resolutions.count,
      youtubeSearches: searches.count,
      aiPlans: plans.count,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
