// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { MusicHomeResponseSchema } from '@/lib/contracts/music';
import { getAudiusHomeCatalog } from '@/lib/music/audius-source.server';
import { sourceStatus } from '@/lib/music/source-policy';

export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store, no-cache, must-revalidate' };

export async function GET() {
  try {
    const body = MusicHomeResponseSchema.parse(await getAudiusHomeCatalog());
    return NextResponse.json(body, { headers: privateHeaders });
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
