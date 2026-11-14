// @polsia:user-owned — copertina dei "brani in evidenza" servita da Solco:
// - un'immagine dello store Blob (stesso nome del brano o copertina della cartella), anche privata:
//   il server la legge con il token;
// - la copertina INCORPORATA in un file MP3/FLAC: si scaricano solo i byte del tag (richieste
//   Range), mai il brano intero.
// In ogni caso l'immagine viene ridotta (al massimo 512 px, JPEG) e ricodificata: niente originali
// da molti MB per una miniatura, niente dati estranei nascosti nel file. Solo percorsi che sarebbero
// brani o immagini in evidenza (mai gli upload degli utenti, mai "../"), solo immagini raster.
// Risposta in cache sulla CDN: lo store viene letto di rado.
import 'server-only';
import { BlobNotFoundError, get } from '@vercel/blob';
import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { env } from '@/lib/env';
import {
  type ByteRangeReader,
  MAX_ARTWORK_TAG_BYTES,
  readEmbeddedArtwork,
} from '@/lib/music/embedded-artwork';
import {
  encodeBlobPathname,
  isHomeImageBlob,
  supportsEmbeddedArtwork,
} from '@/lib/music/home-tracks.server';

export const dynamic = 'force-dynamic';

const FOUND_CACHE = 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800';
/** Il file non ha (o non è) una copertina: risposta stabile, in cache per un'ora. */
const MISSING_CACHE = 'public, max-age=3600, s-maxage=3600';
/** Errore temporaneo dello storage: mai in cache, il prossimo tentativo può riuscire. */
const ERROR_CACHE = 'no-store';
/** Un'immagine di copertina più grande di così non viene letta. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Lato massimo della copertina servita (schermata di blocco Android: 512×512). */
const COVER_SIZE = 512;

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

function timeout(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

/** Legge lo stream fino a `limit` byte (poi lo chiude): mai più del necessario in memoria. */
async function readAtMost(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const room = limit - total;
      const piece = value.length > room ? value.subarray(0, room) : value;
      chunks.push(piece);
      total += piece.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Copertina ridotta e ricodificata (JPEG), o null se i byte non sono un'immagine valida. */
async function thumbnail(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    const output = await sharp(data, { failOn: 'error', limitInputPixels: 60_000_000 })
      .rotate()
      .resize(COVER_SIZE, COVER_SIZE, { fit: 'cover', withoutEnlargement: true })
      .flatten({ background: '#000000' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    return new Uint8Array(output);
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return new NextResponse(null, { status: 404 });

  const params = new URL(request.url).searchParams;
  const pathname = params.get('p');
  const access = params.get('pub') === '1' ? 'public' : 'private';
  const isImage = Boolean(pathname && isHomeImageBlob(pathname));
  if (!pathname || (!isImage && !supportsEmbeddedArtwork(pathname))) return noCover();

  // Solo le richieste che arrivano fin qui (non servite dalla CDN) leggono lo store.
  const identity = getRateLimitIdentity(null, request.headers);
  const limited = identity ? await enforceRateLimit('music.cover', identity) : null;
  if (limited) return limited;

  // Ogni cartella codificata: "?" o "#" in un nome restano parte del nome, mai query o frammento.
  const storagePath = encodeBlobPathname(pathname);

  let original: Uint8Array | null = null;
  try {
    if (isImage) {
      const result = await get(storagePath, { access, token, abortSignal: timeout(15_000) });
      if (!result?.stream) return noCover();
      const length = Number(result.headers.get('content-length') ?? '0');
      if (length > MAX_IMAGE_BYTES) return noCover();
      const data = await readAtMost(result.stream, MAX_IMAGE_BYTES + 1);
      if (data.length === 0 || data.length > MAX_IMAGE_BYTES) return noCover();
      original = data;
    } else {
      const read: ByteRangeReader = async (start, end) => {
        const wanted = Math.min(end - start + 1, MAX_ARTWORK_TAG_BYTES);
        if (wanted <= 0) return new Uint8Array();
        const result = await get(storagePath, {
          access,
          token,
          abortSignal: timeout(15_000),
          headers: { range: `bytes=${start}-${start + wanted - 1}` },
        });
        if (!result?.stream) return new Uint8Array();
        // Senza supporto Range lo storage manda il file dall'inizio: si salta fino a `start`.
        if (!result.headers.get('content-range') && start > 0) {
          const all = await readAtMost(result.stream, start + wanted);
          return all.subarray(Math.min(start, all.length));
        }
        return readAtMost(result.stream, wanted);
      };
      const artwork = await readEmbeddedArtwork(read);
      if (!artwork) return noCover();
      original = artwork.data;
    }
  } catch (error) {
    // Il file non c'è (404 dello storage): stabile. Altro (rete, timeout): temporaneo.
    const notFound = typeof BlobNotFoundError === 'function' && error instanceof BlobNotFoundError;
    return noCover(notFound ? MISSING_CACHE : ERROR_CACHE);
  }

  const cover = await thumbnail(original);
  if (!cover) return noCover();
  return new Response(cover, { status: 200, headers: safetyHeaders(FOUND_CACHE, 'image/jpeg') });
}
