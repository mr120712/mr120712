// @polsia:user-owned — GET /api/music/featured/tracks/<shareId>: il brano del link diretto
// /evidenza/<shareId>. Esiste SOLO per i brani con i diritti dichiarati in diritti.json (indice in
// cache di featured-search.server, ~5 minuti, lo stesso di ricerca e pagina d'artista): lo store
// contiene anche brani commerciali senza licenza, che qui non hanno mai un link.
// - Senza sessione: solo i metadati pubblici (titolo, artista, link all'artista, copertina servita
//   per id). QUESTA risposta non contiene mai lo stream né il pathname del file nello store.
// - Con una sessione: anche il brano della Home (`homeTrack`, con streamUrl) da riprodurre.
// Non è un limite d'accesso all'audio: il proxy dello stream (/api/music/home-tracks/stream) non
// chiede la sessione e la Home e la ricerca pubbliche mandano già lo streamUrl a chiunque. Qui si
// evita solo di legare l'id condiviso allo stream per chi non ha fatto l'accesso.
// Un id malformato, sconosciuto o di un brano non (più) dichiarato riceve la STESSA risposta 404.
// Limite per identità (utente o IP) con il bucket delle letture di catalogo (music.catalog). Mai in
// cache (private, no-store): una revoca vale alla ricostruzione successiva dell'indice.
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { FeaturedShareResponseSchema } from '@/lib/contracts/featured-share';
import { getFeaturedShare } from '@/lib/music/featured-search.server';
import { featuredShareCoverPath, isFeaturedShareId } from '@/lib/music/featured-share';
import { homeCoverSourceFromArtworkUrl } from '@/lib/music/home-track-cover.server';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: privateHeaders });
}

/** La stessa risposta per id malformati, sconosciuti e brani non dichiarati. */
function notFound() {
  return json({ error: 'not_found' }, 404);
}

export async function GET(request: Request, { params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  // Forma prima di tutto: un id malformato non tocca né il limite né l'indice.
  if (!isFeaturedShareId(shareId)) return notFound();

  // La sessione è facoltativa: senza (o se non si riesce a verificarla) solo i metadati.
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  const userId = session?.user?.id ?? null;

  const identity = getRateLimitIdentity(userId, request.headers);
  if (identity) {
    const limited = await enforceRateLimit('music.catalog', identity);
    if (limited) {
      limited.headers.set('Cache-Control', 'private, no-store');
      return limited;
    }
  }

  const result = await getFeaturedShare(shareId);
  if (result.outcome === 'unavailable') return json({ error: 'unavailable' }, 503);
  if (result.outcome !== 'found') return notFound();

  const { track } = result;
  // Una forma inattesa non arriva mai al client.
  const body = FeaturedShareResponseSchema.safeParse({
    track: {
      shareId,
      title: track.title,
      artist: track.artist || null,
      artistSlug: track.artistSlug ?? null,
      // La copertina passa dall'id, mai dal pathname (che rivelerebbe il file e il suo stream).
      coverPath: homeCoverSourceFromArtworkUrl(track.artworkUrl)
        ? featuredShareCoverPath(shareId)
        : null,
    },
    homeTrack: userId ? track : null,
  });
  if (!body.success) return notFound();
  return json(body.data);
}
