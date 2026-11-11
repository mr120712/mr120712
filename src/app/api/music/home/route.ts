// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { MusicHomeResponseSchema } from '@/lib/contracts/music';
import { getAudiusHomeCatalog } from '@/lib/music/audius-source.server';
import { sourceStatus } from '@/lib/music/source-policy';

export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store, no-cache, must-revalidate' };
const publicCatalogHeaders = {
  'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=300',
};

export async function GET() {
  try {
    const body = MusicHomeResponseSchema.parse(await getAudiusHomeCatalog());
    // Same catalogue for everyone: the CDN absorbs repeats, so Audius is not asked on every visit.
    return NextResponse.json(body, {
      headers:
        body.sourceStatus.searchOutcome === 'unavailable' ? privateHeaders : publicCatalogHeaders,
    });
  } catch {
    const body = MusicHomeResponseSchema.parse({
      sourceStatus: sourceStatus({ id: 'audius', active: true, outcome: 'unavailable' }),
      trending: { outcome: 'unavailable', tracks: [] },
      releases: { outcome: 'unavailable', albums: [] },
      playlists: { outcome: 'unavailable', playlists: [] },
      artists: { outcome: 'unavailable', artists: [] },
    });
    return NextResponse.json(body, { headers: privateHeaders });
  }
}
