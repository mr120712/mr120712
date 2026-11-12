// @polsia:user-owned — lettura pubblica di una playlist condivisa (/playlist/<shareId>). Nessun
// login: risponde solo con nome, prima parola del nome del proprietario e i campi del player.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { SharedPlaylistSchema } from '@/lib/contracts/shared-playlist';
import { isShareId } from '@/lib/music/playlist-share';
import { getSharedPlaylist } from '@/lib/music/shared-playlists.server';

export const dynamic = 'force-dynamic';

// Public data, but never for search engines (the page itself is noindex too).
const robotsHeaders = { 'X-Robots-Tag': 'noindex, nofollow' };
// The same answer for everyone (no cookies read): the CDN may keep it for a minute and serve it
// stale for 5 more, so after "Smetti di condividere" a 200 can still go out for up to ~6 minutes
// (the UI and the privacy page say so).
const publicHeaders = {
  'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
  ...robotsHeaders,
};
// 404s and errors are never cached.
const noStoreHeaders = { 'Cache-Control': 'no-store', ...robotsHeaders };

function notShared() {
  return NextResponse.json(
    { error: 'not_found', message: 'Questa playlist non è più condivisa.' },
    { status: 404, headers: noStoreHeaders },
  );
}

export async function GET(request: Request, { params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  // Format first: a malformed id never reaches the database (rate limit included).
  if (!isShareId(shareId)) return notShared();
  const identity = getRateLimitIdentity(null, request.headers);
  const limited = identity ? await enforceRateLimit('music.catalog', identity) : null;
  if (limited) return limited;

  try {
    const playlist = await getSharedPlaylist(shareId);
    if (!playlist) return notShared();
    return NextResponse.json(SharedPlaylistSchema.parse(playlist), { headers: publicHeaders });
  } catch {
    return NextResponse.json(
      { error: 'shared_playlist_unavailable', message: 'Playlist non disponibile. Riprova.' },
      { status: 503, headers: noStoreHeaders },
    );
  }
}
