// @polsia:user-owned — elenco pubblico dei "brani in evidenza" della Home: i file audio messi
// dall'amministratore direttamente nello store Vercel Blob. Sola lettura, nessun login.
// Ogni brano porta `artistSlug` (link alla pagina /artista/<slug>) SOLO se il suo artista
// principale ha almeno un brano con i diritti dichiarati in diritti.json, e `shareId` (link
// diretto «Condividi» /evidenza/<shareId>) SOLO se il brano stesso è dichiarato; ogni sezione porta
// `sectionId` e `declaredCount` («Mostra tutti (N)», pagina /cartella/<sectionId>) SOLO se la sua
// cartella ha almeno un brano dichiarato (N = brani dichiarati: mai quelli non dichiarati), altrimenti
// null. Ogni brano DICHIARATO porta anche `offline` (copia offline consentita da diritti.json o solo
// streaming); i non dichiarati non hanno il campo. Lo dice l'indice in cache della ricerca
// (featured-search.server), mai un elenco in più a ogni richiesta. Per il resto la Home resta com'è (stessi brani, sezioni, tetti e ordine).
//
// Elenco e versione vengono dallo STESSO elenco condiviso dello store (featured-catalog.server,
// ~30 secondi per istanza): nessuna list() a ogni richiesta, qualunque sia il numero di ascoltatori.
// La Home chiede prima la versione (GET /api/music/home-tracks/version) e poi questo elenco con
// `?v=<versione>`:
// - query ESATTAMENTE `?v=<versione attuale>` e contenuto definitivo (link pronti per quella
//   versione, elenco non degradato, contatore «Aggiorna ora» già letto, diritti.json non pubblico)
//   → cache CDN lunga (un giorno + una settimana stale): il contenuto di una versione non cambia
//   mai e la versione successiva ha un altro URL. Con parametri in più l'URL è un'altra chiave per
//   la CDN (ogni variante arriva al server): vale come versione non attuale (rate-limit, cache
//   breve);
// - diritti.json PUBBLICO: la sua lettura passa dal CDN di Vercel Blob e può restituire la copia
//   precedente anche dopo il cambio di versione, quindi i link (artista, «Condividi») possono
//   cambiare a versione invariata. Niente cache lunga né `version` nel corpo: cache CDN 60 secondi
//   e il client richiede l'elenco a ogni controllo, come prima (una revoca non è mai più lenta);
// - `v` assente → come sempre (cache CDN 60 secondi), per i client meno recenti e come riserva se
//   la versione non risponde;
// - `v` sconosciuta o superata → si risponde con l'elenco ATTUALE (che porta la sua `version`) e
//   una cache brevissima. Scelto al posto di un redirect 307: ogni istanza calcola la versione dal
//   suo elenco e due istanze possono essere sfasate per qualche secondo, quindi un redirect
//   potrebbe rimbalzare fra le due (A → B → A…) ed essere anche messo in cache; così invece il
//   client riceve sempre dati validi e sa quale versione ha in mano.
// `version` nel corpo c'è SOLO se il contenuto è definitivo per quella versione: senza, il client
// lo richiede al controllo successivo (es. indice ancora in costruzione: link non ancora pronti).
// `listedAt` (quando è riuscito l'elenco dello store dietro la risposta) serve al client per non
// tornare indietro a un elenco più vecchio servito da un'istanza rimasta indietro.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import type { HomeTrack, HomeTrackSection } from '@/lib/contracts/home-tracks';
import { linkDeclaredArtists } from '@/lib/music/featured-artists';
import {
  type FeaturedCatalogState,
  loadFeaturedCatalogState,
} from '@/lib/music/featured-catalog.server';
import { type FeaturedHomeLinks, loadFeaturedHomeLinks } from '@/lib/music/featured-search.server';
import { homeTrackSectionsFromListing } from '@/lib/music/home-tracks.server';

export const dynamic = 'force-dynamic';

/**
 * Attesa massima dell'indice (artisti e link diretti) DOPO che l'elenco della Home è pronto.
 * L'indice parte insieme all'elenco ed è quasi sempre già in cache; se va ricostruito e tarda, la
 * Home risponde senza link (la ricostruzione prosegue e serve le richieste successive) invece di
 * rallentare.
 */
const ARTIST_INDEX_GRACE_MS = 1500;

/** Contenuto definitivo di una versione: non cambia mai, la CDN lo tiene a lungo. */
const HOME_TRACKS_VERSIONED_CACHE =
  'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800';
/** Senza `v` (client meno recenti o riserva): come sempre, un file nuovo compare entro ~1 minuto. */
const HOME_TRACKS_LEGACY_CACHE = 'public, s-maxage=60, stale-while-revalidate=300';
/** Versione superata o contenuto non definitivo: pochi secondi, giusto per assorbire i picchi. */
const HOME_TRACKS_SHORT_CACHE = 'public, max-age=0, s-maxage=5';
/** Versione attuale ma diritti.json pubblico (link che possono cambiare a versione invariata). */
const HOME_TRACKS_PUBLIC_MANIFEST_CACHE = 'public, max-age=0, s-maxage=60';

/** Il valore della promessa se arriva entro `ms`, altrimenti null. */
function withinGrace<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise.catch(() => null), deadline]).finally(() => clearTimeout(timer));
}

/**
 * Link all'artista (artisti dichiarati), link diretto e permesso della copia offline (SOLO brani
 * dichiarati: per gli altri `offline` non c'è nemmeno); null = nessuno.
 */
function withLinks(tracks: readonly HomeTrack[], links: FeaturedHomeLinks | null) {
  return linkDeclaredArtists(tracks, links?.artists ?? null).map((track) => {
    const offline = links?.offline?.get(track.id);
    return {
      ...track,
      shareId: links?.shareIds.get(track.id) ?? null,
      ...(offline === undefined ? {} : { offline }),
    };
  });
}

/**
 * «Mostra tutti (N)» di una sezione: id della pagina e numero di brani DICHIARATI della cartella,
 * solo se ce n'è almeno uno; null altrimenti (anche senza indice). La chiave è la cartella senza
 * maiuscole, come la raggruppa la Home (l'`id` della sezione è la sua grafia più recente).
 */
function sectionLink(section: HomeTrackSection, links: FeaturedHomeLinks | null) {
  const link = links?.sections.get(section.id.toLowerCase());
  return link && link.count > 0
    ? { sectionId: link.id, declaredCount: link.count }
    : { sectionId: null, declaredCount: null };
}

/** Come può restare in CDN la risposta: per sempre (per versione), un minuto o pochi secondi. */
type Pinning = 'definitive' | 'public_manifest' | 'provisional';

function cacheControl(requested: string | null, current: boolean, pinning: Pinning): string {
  if (requested === null) return HOME_TRACKS_LEGACY_CACHE;
  if (!current) return HOME_TRACKS_SHORT_CACHE;
  if (pinning === 'definitive') return HOME_TRACKS_VERSIONED_CACHE;
  return pinning === 'public_manifest'
    ? HOME_TRACKS_PUBLIC_MANIFEST_CACHE
    : HOME_TRACKS_SHORT_CACHE;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requested = url.searchParams.get('v');
  let state: FeaturedCatalogState;
  try {
    // Mai throw; per sicurezza la Home non deve mai rompersi per questa sezione.
    state = await loadFeaturedCatalogState();
  } catch {
    return NextResponse.json({ items: [], sections: [] });
  }
  // Attuale SOLO con la query esatta che manda la Home: `?v=<versione>` e nient'altro.
  const current = requested !== null && url.search === `?v=${state.version}`;

  // La versione attuale finisce nella cache CDN (un giorno): qui arriva una richiesta per versione
  // e regione, senza costi per lo store. Le altre (senza `v`, con `v` superata/inventata o con
  // parametri in più) restano soggette al rate-limit per identità delle letture di catalogo anonime
  // (radio/podcast), come prima: query-string sempre diverse non diventano richieste illimitate al
  // server.
  if (!current) {
    const identity = getRateLimitIdentity(null, request.headers);
    const limited = identity ? await enforceRateLimit('music.catalog', identity) : null;
    if (limited) return limited;
  }

  try {
    // Parte subito, in parallelo: loadFeaturedHomeLinks non fa mai throw. Stesso stato del
    // catalogo della risposta, così link ed elenco vengono dallo stesso elenco dello store.
    const declaredLinks = loadFeaturedHomeLinks(state);
    const { items, sections } = homeTrackSectionsFromListing(state.listing);
    const links = items.length > 0 ? await withinGrace(declaredLinks, ARTIST_INDEX_GRACE_MS) : null;
    // Pronto: elenco non degradato, contatore «Aggiorna ora» noto e (se ci sono brani) link
    // costruiti per QUESTA versione.
    const ready =
      !state.stale &&
      !state.degraded &&
      state.generationKnown &&
      (items.length === 0 || links?.version === state.version);
    // Definitivo (cache lunga, `version` nel corpo) solo se i link non possono cambiare a versione
    // invariata: con diritti.json pubblico possono (copia precedente dal CDN di Vercel Blob).
    const publicManifest = items.length > 0 && links?.manifestPublic === true;
    const pinning: Pinning = !ready
      ? 'provisional'
      : publicManifest
        ? 'public_manifest'
        : 'definitive';
    return NextResponse.json(
      {
        items: withLinks(items, links),
        sections: sections.map((section) => ({
          ...section,
          ...sectionLink(section, links),
          items: withLinks(section.items, links),
        })),
        ...(pinning === 'definitive' ? { version: state.version } : {}),
        ...(state.listedAt ? { listedAt: state.listedAt } : {}),
      },
      { headers: { 'Cache-Control': cacheControl(requested, current, pinning) } },
    );
  } catch {
    return NextResponse.json({ items: [], sections: [] });
  }
}
