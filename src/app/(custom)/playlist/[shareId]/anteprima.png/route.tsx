// @polsia:user-owned — vecchio indirizzo (PNG) dell'anteprima social di una playlist condivisa:
// i link già pubblicati e le anteprime già in cache dei social puntano ancora qui. Non legge e
// non disegna nulla: reindirizza (308) alla scheda JPEG canonica (anteprima.jpg, senza query).
// Location relativa (dietro il proxy request.url può avere l'host interno); in cache sulla CDN.
import { isShareId, sharedPlaylistImagePath } from '@/lib/music/playlist-share';

export const dynamic = 'force-dynamic';

const robotsHeaders = { 'X-Robots-Tag': 'noindex, nofollow' };

export async function GET(_request: Request, { params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  // A malformed id is never shared.
  if (!isShareId(shareId)) {
    return new Response(null, {
      status: 404,
      headers: { 'Cache-Control': 'no-store', ...robotsHeaders },
    });
  }
  return new Response(null, {
    status: 308,
    headers: {
      Location: sharedPlaylistImagePath(shareId),
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      ...robotsHeaders,
    },
  });
}
