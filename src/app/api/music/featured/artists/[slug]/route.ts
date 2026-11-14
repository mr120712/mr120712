// @polsia:user-owned — GET /api/music/featured/artists/<slug>: la pagina d'artista dei "brani in
// evidenza". Elenca SOLO i brani con i diritti dichiarati in diritti.json (indice in cache di
// featured-search.server, ~5 minuti, lo stesso della ricerca): lo store contiene anche brani
// commerciali senza licenza, che qui non compaiono mai, nemmeno dello stesso artista. I brani hanno
// gli stessi dati della Home (copertina, streamUrl), così la riproduzione è identica.
// Serve una sessione (come l'ascolto e i testi); limite per utente con lo stesso bucket della
// ricerca globale (music.search). Mai in cache (private, no-store): una revoca vale alla
// ricostruzione successiva dell'indice.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import {
  FeaturedArtistResponseSchema,
  FeaturedArtistSlugSchema,
} from '@/lib/contracts/featured-artists';
import { getFeaturedArtist } from '@/lib/music/featured-search.server';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: privateHeaders });
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  let userId: string;
  try {
    const user = await requireAuth(request);
    userId = user.id;
  } catch (error) {
    // requireAuth lancia una Response 401; qualsiasi altro errore (sessione non verificabile) è
    // un problema temporaneo, non un "non sei entrato".
    return error instanceof Response && error.status === 401
      ? json({ error: 'unauthorized' }, 401)
      : json({ error: 'unavailable' }, 503);
  }

  // Forma prima di tutto: uno slug malformato non tocca né il limite né l'indice.
  const slug = FeaturedArtistSlugSchema.safeParse((await params).slug);
  if (!slug.success) return json({ errors: { slug: 'Artista non valido.' } }, 400);

  const identity = getRateLimitIdentity(userId, request.headers);
  if (identity) {
    const limited = await enforceRateLimit('music.search', identity);
    if (limited) {
      limited.headers.set('Cache-Control', 'private, no-store');
      return limited;
    }
  }

  const result = await getFeaturedArtist(slug.data);
  if (result.outcome !== 'found') {
    return result.outcome === 'unavailable'
      ? json({ error: 'unavailable' }, 503)
      : json({ error: 'not_found' }, 404);
  }

  // Una forma inattesa non arriva mai al client.
  const body = FeaturedArtistResponseSchema.safeParse({
    artist: result.artist,
    tracks: result.tracks,
  });
  if (!body.success || body.data.tracks.length === 0) return json({ error: 'not_found' }, 404);
  return json(body.data);
}
