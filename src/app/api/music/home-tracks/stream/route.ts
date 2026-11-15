// @polsia:user-owned — proxy di streaming dei "brani in evidenza" dello store Vercel Blob, e il
// loro UNICO punto d'ascolto: la Home e la ricerca mandano sempre questo percorso same-origin, anche
// per un file pubblico (vedi home-tracks.server), così l'accesso ha le stesse regole per tutti:
// - serve una SESSIONE (401 senza): gli ospiti non ascoltano né scaricano nulla;
// - niente hotlinking né download diretto (403): solo richieste del player di Solco (stesso sito,
//   destinazione audio), vedi featured-stream-access.ts;
// - limite per ACCOUNT sugli avvii (music.featured.stream: 60 ogni 10 minuti, 600 al giorno), non
//   sui blocchi: seek e riproduzione a blocchi non contano.
// Un blob privato non è leggibile dal browser dal suo URL diretto: il server lo legge con il token
// e lo ritrasmette (inoltrando l'header Range, così funzionano seek e riproduzione a blocchi); un
// blob pubblico si legge dal suo URL del CDN, trovato nell'elenco condiviso dello store (nessuna
// list() in più), e si ritrasmette allo stesso modo. Risposte mai in cache condivisa.
import 'server-only';
import { get } from '@vercel/blob';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { env } from '@/lib/env';
import { loadFeaturedCatalogState } from '@/lib/music/featured-catalog.server';
import { isFeaturedPlayerRequest, isFeaturedStreamStart } from '@/lib/music/featured-stream-access';
import {
  encodeBlobPathname,
  isHomeAudioBlob,
  isPublicBlobUrl,
} from '@/lib/music/home-tracks.server';
import { getSessionUser } from '@/lib/require-auth';

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

export async function GET(request: Request) {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return new NextResponse(null, { status: 404 });

  const pathname = new URL(request.url).searchParams.get('p');
  // Solo i percorsi che sarebbero brani in evidenza (audio, non upload utenti): impedisce di usare
  // questo proxy per leggere un oggetto arbitrario dello store.
  if (!pathname || !isHomeAudioBlob(pathname)) {
    return new NextResponse(null, { status: 404 });
  }

  // Hotlinking da altri siti o URL aperto in una scheda: non è il player di Solco.
  if (!isFeaturedPlayerRequest(request.headers)) {
    return new NextResponse(null, { status: 403, headers: PRIVATE_NO_STORE });
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
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return new NextResponse(null, { status: 404 });
    }
    return relay(response.body, response.headers, response.headers.get('content-type'));
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
  return relay(result.stream, result.headers, result.blob.contentType);
}
