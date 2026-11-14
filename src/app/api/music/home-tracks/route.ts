// @polsia:user-owned — elenco pubblico dei "brani in evidenza" della Home: i file audio messi
// dall'amministratore direttamente nello store Vercel Blob. Sola lettura, nessun login.
// Ogni brano porta `artistSlug` (link alla pagina /artista/<slug>) SOLO se il suo artista
// principale ha almeno un brano con i diritti dichiarati in diritti.json, e `shareId` (link
// diretto «Condividi» /evidenza/<shareId>) SOLO se il brano stesso è dichiarato: lo dice l'indice in
// cache della ricerca (featured-search.server, ~5 minuti), mai un elenco in più a ogni richiesta.
// Per il resto la Home resta com'è (stessi brani, sezioni e ordine).
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import type { HomeTrack } from '@/lib/contracts/home-tracks';
import { linkDeclaredArtists } from '@/lib/music/featured-artists';
import { type FeaturedHomeLinks, loadFeaturedHomeLinks } from '@/lib/music/featured-search.server';
import { listHomeTrackSections } from '@/lib/music/home-tracks.server';

export const dynamic = 'force-dynamic';

/**
 * Attesa massima dell'indice (artisti e link diretti) DOPO che l'elenco della Home è pronto.
 * L'indice parte insieme all'elenco ed è quasi sempre già in cache; se va ricostruito e tarda, la
 * Home risponde senza link (la ricostruzione prosegue e serve le richieste successive) invece di
 * rallentare.
 */
const ARTIST_INDEX_GRACE_MS = 1500;

/** Il valore della promessa se arriva entro `ms`, altrimenti null. */
function withinGrace<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise.catch(() => null), deadline]).finally(() => clearTimeout(timer));
}

/** Link all'artista (artisti dichiarati) e link diretto (SOLO brani dichiarati); null = nessuno. */
function withLinks(tracks: readonly HomeTrack[], links: FeaturedHomeLinks | null) {
  return linkDeclaredArtists(tracks, links?.artists ?? null).map((track) => ({
    ...track,
    shareId: links?.shareIds.get(track.id) ?? null,
  }));
}

export async function GET(request: Request) {
  // Ogni richiesta interroga l'API (a consumo) di Vercel Blob: come le altre letture di catalogo
  // anonime (radio/podcast), si applica il rate-limit per identità, così una cache aggirata con
  // query-string diverse non moltiplica all'infinito le chiamate a list() sullo stesso token.
  const identity = getRateLimitIdentity(null, request.headers);
  const limited = identity ? await enforceRateLimit('music.catalog', identity) : null;
  if (limited) return limited;

  // listHomeTracks non fa mai throw (ritorna [] su qualsiasi problema), ma per sicurezza la Home
  // non deve mai rompersi per questa sezione.
  try {
    // Parte subito, in parallelo all'elenco: loadFeaturedHomeLinks non fa mai throw.
    const declaredLinks = loadFeaturedHomeLinks();
    const { items, sections } = await listHomeTrackSections();
    const links = items.length > 0 ? await withinGrace(declaredLinks, ARTIST_INDEX_GRACE_MS) : null;
    return NextResponse.json(
      {
        items: withLinks(items, links),
        sections: sections.map((section) => ({
          ...section,
          items: withLinks(section.items, links),
        })),
      },
      {
        headers: {
          // Cache breve sulla CDN: un file aggiunto nel pannello Blob compare entro ~1 minuto.
          'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
        },
      },
    );
  } catch {
    return NextResponse.json({ items: [], sections: [] });
  }
}
