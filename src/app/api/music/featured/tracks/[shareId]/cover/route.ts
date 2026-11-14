// @polsia:user-owned — GET /api/music/featured/tracks/<shareId>/cover: la copertina quadrata (JPEG,
// al massimo 512 px) del brano del link diretto /evidenza/<shareId>, servita per id: la pagina
// pubblica la mostra senza mai rivelare il pathname del file nello store. Solo brani DICHIARATI in
// diritti.json (stesso indice di featured-search.server); la lettura e la riduzione sono quelle
// delle copertine della Home (home-track-cover.server). Nessun login (come le copertine della
// Home); limite per IP con il bucket delle copertine (music.cover); in cache sulla CDN.
import 'server-only';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { env } from '@/lib/env';
import { getFeaturedShare } from '@/lib/music/featured-search.server';
import { isFeaturedShareId } from '@/lib/music/featured-share';
import {
  homeCoverSourceFromArtworkUrl,
  loadHomeCoverThumbnail,
} from '@/lib/music/home-track-cover.server';

export const dynamic = 'force-dynamic';

/**
 * Copertina trovata: al massimo un giorno sulla CDN e un'ora nel browser, SENZA finestra «stale»:
 * dopo una revoca la copia già distribuita resta servibile al più ~1 giorno (CDN) più ~1 ora (un
 * browser che l'aveva appena presa), poi l'origine risponde 404.
 */
const FOUND_CACHE = 'public, max-age=3600, s-maxage=86400';
/** Id sconosciuto o brano senza copertina: risposta stabile, in cache per poco. */
const MISSING_CACHE = 'public, max-age=300, s-maxage=300';
/** Errore temporaneo (store, indice): mai in cache, il prossimo tentativo può riuscire. */
const ERROR_CACHE = 'no-store';

function safetyHeaders(cache: string, contentType?: string): Headers {
  const headers = new Headers({
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
    // Aperta da sola, la risposta non può eseguire nulla.
    'content-security-policy': "default-src 'none'; img-src 'self'; sandbox",
    'x-robots-tag': 'noindex, nofollow',
  });
  if (contentType) headers.set('content-type', contentType);
  return headers;
}

function noCover(cache = MISSING_CACHE): Response {
  return new Response(null, { status: 404, headers: safetyHeaders(cache) });
}

export async function GET(request: Request, { params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  if (!isFeaturedShareId(shareId)) return noCover();

  // Solo le richieste che arrivano fin qui (non servite dalla CDN) leggono indice e store.
  const identity = getRateLimitIdentity(null, request.headers);
  const limited = identity ? await enforceRateLimit('music.cover', identity) : null;
  if (limited) return limited;

  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return noCover();
  const lookup = await getFeaturedShare(shareId);
  if (lookup.outcome === 'unavailable') return noCover(ERROR_CACHE);
  if (lookup.outcome !== 'found') return noCover();

  const source = homeCoverSourceFromArtworkUrl(lookup.track.artworkUrl);
  if (!source) return noCover();
  const cover = await loadHomeCoverThumbnail(source, token);
  if (cover.status === 'error') return noCover(ERROR_CACHE);
  if (cover.status === 'missing') return noCover();
  return new Response(cover.data, {
    status: 200,
    headers: safetyHeaders(FOUND_CACHE, 'image/jpeg'),
  });
}
