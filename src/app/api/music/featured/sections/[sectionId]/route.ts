// @polsia:user-owned — GET /api/music/featured/sections/<id>: la pagina «Mostra tutti» di una sezione
// dei "brani in evidenza" (una cartella dello store; la radice è "In evidenza"). Elenca SOLO i brani
// della cartella con i diritti dichiarati in diritti.json (indice in cache di featured-search.server,
// lo stesso della ricerca e della pagina d'artista, che segue la versione del catalogo: di solito
// ~30-90 secondi, al più ~5 minuti): lo store contiene anche brani commerciali senza licenza, che qui
// non compaiono mai né si contano. I brani hanno gli stessi dati della Home (copertina, streamUrl),
// così la riproduzione è identica. La Home non cambia: le sue sezioni restano di al massimo 24 brani.
// Serve una sessione (come la pagina d'artista); limite per utente con lo stesso bucket della pagina
// d'artista e della ricerca globale (music.search). Mai in cache (private, no-store): una revoca vale
// alla ricostruzione successiva dell'indice.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import {
  FeaturedSectionIdSchema,
  FeaturedSectionResponseSchema,
} from '@/lib/contracts/featured-sections';
import { getFeaturedSection } from '@/lib/music/featured-search.server';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: privateHeaders });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sectionId: string }> },
) {
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

  // Forma prima di tutto: un id malformato non tocca né il limite né l'indice.
  const sectionId = FeaturedSectionIdSchema.safeParse((await params).sectionId);
  if (!sectionId.success) return json({ errors: { sectionId: 'Sezione non valida.' } }, 400);

  const identity = getRateLimitIdentity(userId, request.headers);
  if (identity) {
    const limited = await enforceRateLimit('music.search', identity);
    if (limited) {
      limited.headers.set('Cache-Control', 'private, no-store');
      return limited;
    }
  }

  const result = await getFeaturedSection(sectionId.data);
  if (result.outcome !== 'found') {
    return result.outcome === 'unavailable'
      ? json({ error: 'unavailable' }, 503)
      : json({ error: 'not_found' }, 404);
  }

  // Una forma inattesa non arriva mai al client.
  const body = FeaturedSectionResponseSchema.safeParse({
    section: result.section,
    tracks: result.tracks,
  });
  if (!body.success || body.data.tracks.length === 0) return json({ error: 'not_found' }, 404);
  return json(body.data);
}
