// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { AudiusAlbumDetailSchema } from '@/lib/contracts/music';
import { getAudiusAlbumCatalogDetail } from '@/lib/music/audius-source.server';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  Vary: 'Cookie',
};

export async function GET(request: Request, { params }: { params: Promise<{ albumId: string }> }) {
  const { albumId } = await params;
  // Route anonima sulla coda Audius condivisa: limite per IP d'ingresso (senza IP affidabile non limita).
  const identity = getRateLimitIdentity(null, request.headers);
  const limited = identity ? await enforceRateLimit('music.catalog', identity) : null;
  if (limited) {
    for (const [name, value] of Object.entries(privateHeaders)) limited.headers.set(name, value);
    return limited;
  }
  const catalog = await getAudiusAlbumCatalogDetail(albumId);
  if (catalog.state !== 'available') {
    const status = catalog.state === 'not_found' ? 404 : 503;
    return NextResponse.json({ error: catalog.reason }, { status, headers: privateHeaders });
  }

  const tracks = catalog.tracks.map((track) => ({
    ...track,
    albumId,
    fullAccess: track.playbackEligible ? ('available' as const) : ('unavailable' as const),
  }));

  const body = AudiusAlbumDetailSchema.parse({ album: catalog.album, tracks });
  return NextResponse.json(body, { headers: privateHeaders });
}
