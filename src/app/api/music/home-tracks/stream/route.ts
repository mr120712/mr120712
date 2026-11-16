// @polsia:user-owned — proxy di streaming dei "brani in evidenza" dello store Vercel Blob, e il
// loro UNICO punto d'ascolto: la Home e la ricerca mandano sempre questo percorso same-origin, anche
// per un file pubblico (vedi home-tracks.server), così l'accesso ha le stesse regole per tutti:
// - serve una SESSIONE (401 senza): gli ospiti non ascoltano né scaricano nulla;
// - niente hotlinking né download diretto (403): solo richieste del player di Solco (stesso sito,
//   destinazione audio), vedi featured-stream-access.ts; la web app iOS (profilo), che WebKit può
//   marcare cross-site, passa con Origin/Referer di Solco (own-site-request.ts); ogni rifiuto lascia
//   nel log del server le sole categorie delle intestazioni (mai IP, User-Agent, URL o cookie);
// - limite per ACCOUNT sugli avvii (music.featured.stream: 60 ogni 10 minuti, 600 al giorno), non
//   sui blocchi: seek e riproduzione a blocchi non contano;
// - limite FREE dei brani in evidenza (FEATURED_FREE_MONTHLY_PLAYS, 30 avvii al mese; Premium
//   senza limite): la stessa decisione del permesso del player (play-quota.server), presa su OGNI
//   richiesta prima di leggere un byte e registrata solo quando lo store ha risposto con l'audio.
//   Riprendere o cercare nello stesso brano entro 30 minuti è ammesso e non conta (finestra di
//   riascolto); un client che saltasse il primo byte per non farsi contare resta fermo al limite.
// Un blob privato non è leggibile dal browser dal suo URL diretto: il server lo legge con il token
// e lo ritrasmette (inoltrando l'header Range, così funzionano seek e riproduzione a blocchi); un
// blob pubblico si legge dal suo URL del CDN, trovato nell'elenco condiviso dello store (nessuna
// list() in più), e si ritrasmette allo stesso modo. Risposte mai in cache condivisa.
import 'server-only';
import { get } from '@vercel/blob';
import { NextResponse } from 'next/server';
import type { PlayDecision } from '@/lib/business/play-quota';
import { playDeniedResponse } from '@/lib/business/play-quota.server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { env } from '@/lib/env';
import { loadFeaturedCatalogState } from '@/lib/music/featured-catalog.server';
import { isFeaturedPlayerRequest, isFeaturedStreamStart } from '@/lib/music/featured-stream-access';
import { featuredQualifiedId } from '@/lib/music/featured-track-id';
import {
  encodeBlobPathname,
  isHomeAudioBlob,
  isPublicBlobUrl,
} from '@/lib/music/home-tracks.server';
import {
  checkStreamPlayFor,
  recordStreamPlay,
  type StreamPlayCheck,
} from '@/lib/music/stream-play.server';
import { getSessionUser } from '@/lib/require-auth';
import { describeSiteHeaders, ownSiteOrigins } from '@/lib/security/own-site-request';

export const dynamic = 'force-dynamic';

const UPSTREAM_TIMEOUT_MS = 20_000;
const PRIVATE_NO_STORE = { 'cache-control': 'private, no-store' };

function abortAfter(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

/** L'URL pubblico del CDN se il file è pubblico secondo l'elenco condiviso dello store, altrimenti null. */
async function publicBlobUrlOf(pathname: string): Promise<string | null> {
  const state = await loadFeaturedCatalogState().catch(() => null);
  const blob = state?.listing.audio.find((item) => item.pathname === pathname);
  return blob && isPublicBlobUrl(blob.url) ? blob.url : null;
}

/** La risposta al player: stato 200/206, tipo, lunghezza, Range e mai cache condivisa. */
function relay(
  stream: ReadableStream<Uint8Array>,
  upstream: Headers,
  contentType: string | null,
): Response {
  const contentRange = upstream.get('content-range');
  const headers = new Headers({
    'content-type': contentType || 'audio/mpeg',
    'accept-ranges': 'bytes',
    // Mai in cache condivisa: è un file servito a QUESTO ascoltatore, con la sua sessione.
    'cache-control': 'private, max-age=0, must-revalidate',
  });
  const contentLength = upstream.get('content-length');
  if (contentLength) headers.set('content-length', contentLength);
  if (contentRange) headers.set('content-range', contentRange);
  return new Response(stream, { status: contentRange ? 206 : 200, headers });
}

/**
 * Registra l'ascolto ora che lo store ha risposto con l'audio (come le route Audius e podcast):
 * il rifiuto da mandare al posto dell'audio (stream dello store chiuso), o null se l'audio può
 * partire. Un riascolto entro 30 minuti non si conta di nuovo; se il registro degli ascolti non
 * risponde si fallisce chiusi (503, nessun byte).
 */
async function recordOrRefuse(
  play: StreamPlayCheck,
  audio: ReadableStream<Uint8Array>,
): Promise<Response | null> {
  let recorded: PlayDecision;
  try {
    recorded = await recordStreamPlay(play);
  } catch {
    await audio.cancel().catch(() => undefined);
    return NextResponse.json(
      { error: 'stream_unavailable' },
      { status: 503, headers: PRIVATE_NO_STORE },
    );
  }
  if (!recorded.allowed) {
    await audio.cancel().catch(() => undefined);
    return playDeniedResponse(recorded);
  }
  return null;
}

export async function GET(request: Request) {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return new NextResponse(null, { status: 404 });

  const pathname = new URL(request.url).searchParams.get('p');
  // Solo i percorsi che sarebbero brani in evidenza (audio, non upload utenti): impedisce di usare
  // questo proxy per leggere un oggetto arbitrario dello store.
  if (!pathname || !isHomeAudioBlob(pathname)) {
    return new NextResponse(null, { status: 404 });
  }

  // Hotlinking da altri siti o URL aperto in una scheda: non è il player di Solco. La web app iOS
  // (profilo) può arrivare marcata cross-site da WebKit: passa se Origin/Referer sono di Solco.
  const ownOrigins = ownSiteOrigins(
    {
      NEXT_PUBLIC_APP_URL: env.NEXT_PUBLIC_APP_URL,
      BETTER_AUTH_TRUSTED_ORIGINS: process.env.BETTER_AUTH_TRUSTED_ORIGINS,
    },
    request,
  );
  if (!isFeaturedPlayerRequest(request.headers, ownOrigins)) {
    // biome-ignore lint/suspicious/noConsole: diagnosi dei rifiuti con le sole categorie delle intestazioni (mai IP, User-Agent, URL, cookie o host).
    console.warn(
      `[featured-stream] richiesta rifiutata (403): ${describeSiteHeaders(request.headers, ownOrigins)}`,
    );
    return NextResponse.json(
      { error: 'forbidden_player' },
      { status: 403, headers: PRIVATE_NO_STORE },
    );
  }

  // Solo con un account: gli ospiti non ascoltano né scaricano i brani in evidenza.
  const user = await getSessionUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: PRIVATE_NO_STORE });
  }

  const range = request.headers.get('range') ?? undefined;
  // Il limite per account conta gli avvii, non i blocchi del Range (seek, Safari).
  if (isFeaturedStreamStart(range)) {
    const limited = await enforceRateLimit('music.featured.stream', `user:${user.id}`);
    if (limited) {
      limited.headers.set('cache-control', 'private, no-store');
      return limited;
    }
  }

  // Limite Free dei brani in evidenza (30 avvii al mese; Premium senza limite), con lo stesso id
  // che usa il player (`upload:<pathname>`): verificato senza scrivere, prima di ogni byte. Un
  // account oltre il limite riceve il 402 del permesso; l'ascolto si registra sotto, con l'audio.
  const play = await checkStreamPlayFor(user, featuredQualifiedId(pathname));
  if (!play.decision.allowed) return playDeniedResponse(play.decision);

  // File pubblico: dal CDN, con lo stesso Range.
  const publicUrl = await publicBlobUrlOf(pathname);
  if (publicUrl) {
    let response: Response;
    try {
      response = await fetch(publicUrl, {
        headers: range ? { range } : {},
        redirect: 'error',
        cache: 'no-store',
        signal: abortAfter(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      return new NextResponse(null, { status: 404 });
    }
    const body = response.body;
    if (!response.ok || !body) {
      await body?.cancel().catch(() => undefined);
      return new NextResponse(null, { status: 404 });
    }
    const refused = await recordOrRefuse(play, body);
    if (refused) return refused;
    return relay(body, response.headers, response.headers.get('content-type'));
  }

  // File privato: letto con il token dello store.
  let result: Awaited<ReturnType<typeof get>>;
  try {
    // Ogni cartella codificata: "?" o "#" in un nome non diventano query o frammento dell'URL.
    result = await get(encodeBlobPathname(pathname), {
      access: 'private',
      token,
      abortSignal: abortAfter(UPSTREAM_TIMEOUT_MS),
      ...(range ? { headers: { range } } : {}),
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
  if (!result || result.statusCode === 304 || !result.stream) {
    return new NextResponse(null, { status: 404 });
  }
  const refused = await recordOrRefuse(play, result.stream);
  if (refused) return refused;
  return relay(result.stream, result.headers, result.blob.contentType);
}
