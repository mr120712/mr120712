// @polsia:user-owned — lettura delle copertine dei "brani in evidenza" dallo store Blob, condivisa
// da GET /api/music/home-tracks/cover (copertina per pathname), dalla copertina del link diretto
// (GET /api/music/featured/tracks/<id>/cover) e dalla sua scheda di anteprima
// (/evidenza/<id>/anteprima.jpg):
// - un'immagine dello store (stesso nome del brano o copertina della cartella), anche privata: il
//   server la legge con il token, al massimo 10 MB;
// - la copertina INCORPORATA in un file MP3/FLAC: si scaricano solo i byte del tag (richieste
//   Range), mai il brano intero.
// Solo percorsi che sarebbero brani o immagini in evidenza (mai gli upload degli utenti, mai
// "../"). La miniatura è ridotta (al massimo 512 px), con un limite di pixel prima della decodifica,
// e ricodificata in JPEG: niente originali da molti MB, niente dati estranei nascosti nel file.
import 'server-only';
import { BlobNotFoundError, get } from '@vercel/blob';
import sharp from 'sharp';
import { HOME_TRACK_COVER_PREFIX } from '@/lib/contracts/home-tracks';
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

/** Un'immagine di copertina più grande di così non viene letta. */
export const MAX_HOME_COVER_IMAGE_BYTES = 10 * 1024 * 1024;
/** Lato massimo della copertina servita (schermata di blocco Android: 512×512). */
export const HOME_COVER_SIZE = 512;
/** Tempo massimo di ogni lettura dallo store. */
const READ_TIMEOUT_MS = 15_000;
/** Pixel massimi di un'immagine da decodificare (oltre: nessuna copertina). */
const MAX_COVER_PIXELS = 60_000_000;

/** Da dove leggere una copertina: un'immagine dello store o il tag di un file audio. */
export type HomeCoverSource = {
  pathname: string;
  access: 'public' | 'private';
  kind: 'image' | 'embedded';
};

/** Esito della lettura: missing è stabile (nessuna copertina), error è temporaneo. */
export type HomeCoverRead =
  | { status: 'found'; data: Uint8Array }
  | { status: 'missing' }
  | { status: 'error' };

/** La sorgente di un pathname dello store, o null se non è un'immagine né un audio con tag. */
export function homeCoverSource(
  pathname: string | null | undefined,
  isPublic = false,
): HomeCoverSource | null {
  if (!pathname) return null;
  const kind = isHomeImageBlob(pathname)
    ? 'image'
    : supportsEmbeddedArtwork(pathname)
      ? 'embedded'
      : null;
  return kind ? { pathname, access: isPublic ? 'public' : 'private', kind } : null;
}

/** La sorgente dai parametri della rotta delle copertine (?p=<pathname>[&pub=1]). */
export function homeCoverSourceFromParams(params: URLSearchParams): HomeCoverSource | null {
  return homeCoverSource(params.get('p'), params.get('pub') === '1');
}

/**
 * La sorgente dall'`artworkUrl` di un brano in evidenza (il percorso same-origin della rotta delle
 * copertine, l'unica forma prodotta da home-tracks.server); null per ogni altra forma.
 */
export function homeCoverSourceFromArtworkUrl(
  artworkUrl: string | null | undefined,
): HomeCoverSource | null {
  if (!artworkUrl?.startsWith(`${HOME_TRACK_COVER_PREFIX}?`)) return null;
  return homeCoverSourceFromParams(
    new URLSearchParams(artworkUrl.slice(HOME_TRACK_COVER_PREFIX.length + 1)),
  );
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

/**
 * I byte originali della copertina (immagine fino a 10 MB, o quella incorporata nel tag). Mai
 * throw: file assente, troppo grande o senza copertina → missing; rete o tempo scaduto → error.
 */
export async function readHomeCoverOriginal(
  source: HomeCoverSource,
  token: string,
  options: { timeoutMs?: number } = {},
): Promise<HomeCoverRead> {
  const { access } = source;
  const readTimeout = options.timeoutMs ?? READ_TIMEOUT_MS;
  // Ogni cartella codificata: "?" o "#" in un nome restano parte del nome, mai query o frammento.
  const storagePath = encodeBlobPathname(source.pathname);
  try {
    if (source.kind === 'image') {
      const result = await get(storagePath, { access, token, abortSignal: timeout(readTimeout) });
      if (!result?.stream) return { status: 'missing' };
      const length = Number(result.headers.get('content-length') ?? '0');
      if (length > MAX_HOME_COVER_IMAGE_BYTES) {
        await result.stream.cancel().catch(() => undefined);
        return { status: 'missing' };
      }
      const data = await readAtMost(result.stream, MAX_HOME_COVER_IMAGE_BYTES + 1);
      if (data.length === 0 || data.length > MAX_HOME_COVER_IMAGE_BYTES) {
        return { status: 'missing' };
      }
      return { status: 'found', data };
    }
    const read: ByteRangeReader = async (start, end) => {
      const wanted = Math.min(end - start + 1, MAX_ARTWORK_TAG_BYTES);
      if (wanted <= 0) return new Uint8Array();
      const result = await get(storagePath, {
        access,
        token,
        abortSignal: timeout(readTimeout),
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
    return artwork ? { status: 'found', data: artwork.data } : { status: 'missing' };
  } catch (error) {
    // Il file non c'è (404 dello storage): stabile. Altro (rete, timeout): temporaneo.
    const notFound = typeof BlobNotFoundError === 'function' && error instanceof BlobNotFoundError;
    return { status: notFound ? 'missing' : 'error' };
  }
}

/**
 * Copertina ridotta (al massimo `size` px, mai ingrandita) e ricodificata in JPEG, o null se i
 * byte non sono un'immagine valida (o superano il limite di pixel).
 */
export async function homeCoverThumbnail(
  data: Uint8Array,
  size = HOME_COVER_SIZE,
): Promise<Uint8Array | null> {
  try {
    const output = await sharp(data, { failOn: 'error', limitInputPixels: MAX_COVER_PIXELS })
      .rotate()
      .resize(size, size, { fit: 'cover', withoutEnlargement: true })
      .flatten({ background: '#000000' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    return new Uint8Array(output);
  } catch {
    return null;
  }
}

/**
 * La miniatura JPEG (512 px) di una sorgente: lettura dallo store + riduzione. missing per un file
 * senza copertina o non valido (stabile), error per un problema temporaneo. Mai throw.
 */
export async function loadHomeCoverThumbnail(
  source: HomeCoverSource,
  token: string,
  options: { timeoutMs?: number } = {},
): Promise<HomeCoverRead> {
  const original = await readHomeCoverOriginal(source, token, options);
  if (original.status !== 'found') return original;
  const thumbnail = await homeCoverThumbnail(original.data);
  return thumbnail ? { status: 'found', data: thumbnail } : { status: 'missing' };
}
