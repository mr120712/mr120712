// @polsia:user-owned — strumenti comuni delle schede di anteprima social (brani e playlist
// condivisi, 1200×630): copertina scaricata in modo difeso e immagine finale in JPEG.
// - Copertina: ssrfSafeFetch (solo HTTPS pubblico, DNS fissato, nessun reindirizzamento) con un
//   tempo massimo di 3 s; solo JPEG/PNG/WebP; il corpo si legge contando i byte e si interrompe
//   oltre 2 MB anche senza Content-Length; la decodifica (sharp) rifiuta le immagini oltre circa
//   16 megapixel prima di decodificarle (niente "bombe" piccole da scaricare ma enormi in memoria);
//   poi la si ruota secondo l'EXIF, la si ritaglia al riquadro e la si ricodifica in JPEG.
//   Su richiesta (blur) la si sfoca forte: la scheda del quiz mostra la copertina senza che
//   si possa leggere il nome dell'artista scritto sopra. Qualsiasi errore: null (la scheda si
//   disegna senza copertina).
// - Scheda: next/og disegna un PNG, che si ricodifica in JPEG (mozjpeg, 4:4:4 perché il testo
//   resti nitido): con una copertina fotografica il PNG pesava 400–600 KB, oltre ciò che WhatsApp
//   accetta per l'immagine di anteprima (circa 300 KB).
import 'server-only';
import { ImageResponse } from 'next/og';
import type { ReactElement } from 'react';
import sharp from 'sharp';
import { ssrfSafeFetch } from '@/lib/net/ssrf-safe-fetch.server';

export const OG_CARD_SIZE = { width: 1200, height: 630 } as const;
export const OG_CARD_CONTENT_TYPE = 'image/jpeg';

const COVER_TIMEOUT_MS = 3_000;
export const MAX_OG_COVER_BYTES = 2 * 1024 * 1024;
/** Circa 16 megapixel: una copertina Audius è al massimo 1000×1000. */
const MAX_OG_COVER_PIXELS = 4096 * 4096;
const COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** Limiti della sfocatura (sigma di sharp: da 0,3; oltre 100 non serve e costa solo tempo). */
const MIN_BLUR_SIGMA = 0.3;
const MAX_BLUR_SIGMA = 100;

type CoverFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Rifiuta quando il segnale scade: anche una lettura del corpo ferma si interrompe. */
function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error('timeout'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  });
}

/**
 * Il corpo intero, se non supera `max` byte; null appena lo supera (la lettura si interrompe
 * subito, Content-Length o no) o se il segnale scade.
 */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  max: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const aborted = abortPromise(signal);
  aborted.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) return null;
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Copertina ritagliata al riquadro (sfocata se `blur` è un sigma > 0) e ricodificata in JPEG, o
 * null se non è un'immagine valida.
 */
async function coverJpeg(
  data: Uint8Array,
  box: number,
  background: string,
  blur: number | undefined,
): Promise<Buffer | null> {
  try {
    let image = sharp(data, { limitInputPixels: MAX_OG_COVER_PIXELS })
      .rotate()
      .resize(box, box, { fit: 'cover' })
      .flatten({ background });
    if (blur !== undefined && Number.isFinite(blur) && blur > 0) {
      image = image.blur(Math.min(MAX_BLUR_SIGMA, Math.max(MIN_BLUR_SIGMA, blur)));
    }
    return await image.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  } catch {
    return null;
  }
}

/**
 * Scarica una copertina (URL già scelto dal server: dati Audius verificati) e la restituisce come
 * data URL JPEG di `box`×`box` pixel, pronta per next/og. `blur` (sigma di sharp, facoltativo)
 * la sfoca dopo il ritaglio. null per qualsiasi problema.
 */
export async function loadOgCover(
  src: string,
  box: number,
  options: { background?: string; blur?: number; fetcher?: CoverFetch; timeoutMs?: number } = {},
): Promise<string | null> {
  const fetcher: CoverFetch = options.fetcher ?? ssrfSafeFetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? COVER_TIMEOUT_MS);
  try {
    const response = await Promise.race([
      fetcher(src, { signal, headers: { Accept: 'image/jpeg, image/png, image/webp' } }),
      abortPromise(signal),
    ]);
    if (!response.ok || !response.body) {
      response.body?.cancel().catch(() => undefined);
      return null;
    }
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    const length = Number(response.headers.get('content-length') ?? '0');
    if (!type || !COVER_TYPES.has(type) || length > MAX_OG_COVER_BYTES) {
      response.body.cancel().catch(() => undefined);
      return null;
    }
    const data = await readCapped(response.body, MAX_OG_COVER_BYTES, signal);
    if (!data || data.byteLength === 0) return null;
    const jpeg = await coverJpeg(data, box, options.background ?? '#000000', options.blur);
    return jpeg ? `data:image/jpeg;base64,${jpeg.toString('base64')}` : null;
  } catch {
    return null;
  }
}

/**
 * Disegna subito la scheda (non in streaming, così un errore di disegno può ancora ripiegare su
 * una scheda più semplice) e la ricodifica in JPEG. Lancia se il disegno fallisce.
 */
export async function renderOgCardJpeg(node: ReactElement): Promise<Uint8Array> {
  const png = await new ImageResponse(node, OG_CARD_SIZE).arrayBuffer();
  const jpeg = await sharp(Buffer.from(png))
    .jpeg({ quality: 82, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return new Uint8Array(jpeg);
}

/** Risposta HTTP della scheda JPEG con le intestazioni di cache scelte dalla rotta. */
export async function ogCardResponse(
  node: ReactElement,
  headers: Record<string, string>,
): Promise<Response> {
  const body = await renderOgCardJpeg(node);
  return new Response(body, {
    headers: { 'Content-Type': OG_CARD_CONTENT_TYPE, ...headers },
  });
}
