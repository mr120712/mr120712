// @polsia:user-owned — copertina dei "brani in evidenza" servita da Solco:
// - un'immagine dello store Blob (stesso nome del brano o copertina della cartella), anche privata:
//   il server la legge con il token;
// - la copertina INCORPORATA in un file MP3/FLAC: si scaricano solo i byte del tag (richieste
//   Range), mai il brano intero.
// In ogni caso l'immagine viene ridotta (al massimo 512 px, JPEG) e ricodificata: niente originali
// da molti MB per una miniatura, niente dati estranei nascosti nel file. Solo percorsi che sarebbero
// brani o immagini in evidenza (mai gli upload degli utenti, mai "../"), solo immagini raster.
// La lettura vive in home-track-cover.server (la usa anche il link diretto /evidenza/<id>).
// Risposta in cache sulla CDN: lo store viene letto di rado.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { env } from '@/lib/env';
import {
  homeCoverSourceFromParams,
  loadHomeCoverThumbnail,
} from '@/lib/music/home-track-cover.server';

export const dynamic = 'force-dynamic';

const FOUND_CACHE = 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800';
/** Il file non ha (o non è) una copertina: risposta stabile, in cache per un'ora. */
const MISSING_CACHE = 'public, max-age=3600, s-maxage=3600';
/** Errore temporaneo dello storage: mai in cache, il prossimo tentativo può riuscire. */
const ERROR_CACHE = 'no-store';

function safetyHeaders(cache: string, contentType?: string): Headers {
  const headers = new Headers({
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
    // Aperta da sola, la risposta non può eseguire nulla.
    'content-security-policy': "default-src 'none'; img-src 'self'; sandbox",
  });
  if (contentType) headers.set('content-type', contentType);
  return headers;
}

function noCover(cache = MISSING_CACHE): Response {
  return new Response(null, { status: 404, headers: safetyHeaders(cache) });
}

export async function GET(request: Request) {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return new NextResponse(null, { status: 404 });

  const source = homeCoverSourceFromParams(new URL(request.url).searchParams);
  if (!source) return noCover();

  // Solo le richieste che arrivano fin qui (non servite dalla CDN) leggono lo store.
  const identity = getRateLimitIdentity(null, request.headers);
  const limited = identity ? await enforceRateLimit('music.cover', identity) : null;
  if (limited) return limited;

  const cover = await loadHomeCoverThumbnail(source, token);
  if (cover.status === 'error') return noCover(ERROR_CACHE);
  if (cover.status === 'missing') return noCover();
  return new Response(cover.data, {
    status: 200,
    headers: safetyHeaders(FOUND_CACHE, 'image/jpeg'),
  });
}
