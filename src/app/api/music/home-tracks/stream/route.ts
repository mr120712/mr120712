// @polsia:user-owned — proxy di streaming per i "brani in evidenza" PRIVATI su Vercel Blob. Un blob
// privato non è leggibile dal browser dal suo URL diretto: qui il server lo legge con il token e lo
// ritrasmette same-origin (inoltrando l'header Range, così funzionano seek e riproduzione a blocchi).
// I file pubblici NON passano di qui: vengono serviti direttamente dal CDN (vedi home-tracks.server).
import 'server-only';
import { get } from '@vercel/blob';
import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { encodeBlobPathname, isHomeAudioBlob } from '@/lib/music/home-tracks.server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return new NextResponse(null, { status: 404 });

  const pathname = new URL(request.url).searchParams.get('p');
  // Solo i percorsi che sarebbero brani in evidenza (audio, non upload utenti): impedisce di usare
  // questo proxy per leggere un oggetto arbitrario dello store.
  if (!pathname || !isHomeAudioBlob(pathname)) {
    return new NextResponse(null, { status: 404 });
  }

  const range = request.headers.get('range') ?? undefined;

  let result: Awaited<ReturnType<typeof get>>;
  try {
    // Ogni cartella codificata: "?" o "#" in un nome non diventano query o frammento dell'URL.
    result = await get(encodeBlobPathname(pathname), {
      access: 'private',
      token,
      abortSignal:
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(20_000)
          : undefined,
      ...(range ? { headers: { range } } : {}),
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }

  if (!result || result.statusCode === 304 || !result.stream) {
    return new NextResponse(null, { status: 404 });
  }

  const upstream = result.headers;
  const contentRange = upstream.get('content-range');
  const headers = new Headers({
    'content-type': result.blob.contentType || 'audio/mpeg',
    'accept-ranges': 'bytes',
    // Mai in cache condivisa: è un file potenzialmente privato servito a questo visitatore.
    'cache-control': 'private, max-age=0, must-revalidate',
  });
  const contentLength = upstream.get('content-length');
  if (contentLength) headers.set('content-length', contentLength);
  if (contentRange) headers.set('content-range', contentRange);

  return new Response(result.stream, {
    status: contentRange ? 206 : 200,
    headers,
  });
}
