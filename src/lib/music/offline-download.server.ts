// @polsia:user-owned — "Scarica il permesso": risoluzione e scaricamento SSRF-safe dei soli brani
// consentiti (Audius scaricabile, enclosure podcast). Niente YouTube, radio o Jamendo qui.
//
// Garanzie comuni: solo HTTPS, nessun host privato (riusa assertPublicHttpsUrl), timeout,
// reindirizzamenti limitati e corpo limitato (MAX_DOWNLOAD_BYTES). L'URL non è mai scelto
// dall'utente: per Audius è un host del protocollo (candidateHosts), per il podcast è l'enclosure
// risolta dal feed ufficiale dello show. I byte vengono letti interamente (entro il tetto) prima di
// contare il download, così un trasferimento interrotto o troppo grande non viene mai contato.
import 'server-only';
import {
  consumeRateLimit,
  peekRateLimit,
  rateLimitResponse,
} from '@/lib/business/rate-limit.server';
import {
  OFFLINE_DOWNLOAD_META_HEADER,
  type OfflineAttribution,
  type OfflineDownloadMeta,
  OfflineDownloadMetaSchema,
} from '@/lib/contracts/offline';
import { mayBeAudioContentType } from '@/lib/music/audio-probe.server';
import {
  AUDIUS_OPEN_MUSIC_LICENSE_NAME,
  AUDIUS_OPEN_MUSIC_LICENSE_URL,
  type AudiusPlaybackReason,
  audiusCopyrightText,
  audiusTrackDownloadFlag,
  normalizeAudiusTracks,
} from '@/lib/music/audius';
import { AudiusApiError, type createAudiusApiClient } from '@/lib/music/audius-api.server';
import { assertPublicHttpsUrl } from '@/lib/music/podcasts.server';

/** 50 MiB per brano: oltre, il download viene rifiutato con un messaggio chiaro. */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
// Le catene di analytics dei podcast (op3, podtrac, chrt, megaphone…) usano 4-6 reindirizzamenti.
const MAX_REDIRECTS = 10;
const DOWNLOAD_USER_AGENT = 'Solco/1.0 (offline download)';

type FetchLike = typeof fetch;
type AudiusDownloadClient = Pick<
  ReturnType<typeof createAudiusApiClient>,
  'getTrack' | 'streamTrack'
>;

const EXTENSION_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
};

function discard(response: Response) {
  void response.body?.cancel().catch(() => undefined);
}

/**
 * Verifica (senza registrare) i limiti del download prima di fare lavoro: per utente e app-wide.
 * Torna la risposta 429/503 da inoltrare, o null se si può procedere.
 */
export async function peekDownloadLimits(userId: string): Promise<Response | null> {
  const perUser = await peekRateLimit('music.download', `user:${userId}`);
  if (!perUser.allowed) return rateLimitResponse('music.download', perUser);
  const global = await peekRateLimit('music.download.global', 'global');
  if (!global.allowed) return rateLimitResponse('music.download.global', global);
  return null;
}

/**
 * Registra il download (per utente e app-wide) SOLO dopo che i byte sono confermati. Torna la
 * risposta 429/503 se nel frattempo il limite è stato raggiunto, altrimenti null.
 */
export async function consumeDownloadLimits(userId: string): Promise<Response | null> {
  const perUser = await consumeRateLimit('music.download', `user:${userId}`);
  if (!perUser.allowed) return rateLimitResponse('music.download', perUser);
  const global = await consumeRateLimit('music.download.global', 'global');
  if (!global.allowed) return rateLimitResponse('music.download.global', global);
  return null;
}

function extensionOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    const dot = path.lastIndexOf('.');
    return dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
  } catch {
    return '';
  }
}

/**
 * Tipo audio da dichiarare al client: il content-type se è un audio/* concreto, altrimenti
 * l'estensione dell'URL, altrimenti audio/mpeg (il formato più comune). Il client lo rinormalizza
 * comunque con resolveAudioType prima di salvare.
 */
export function resolveDownloadMime(contentType: string | null, url: string): string {
  const base = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (base?.startsWith('audio/') && base !== 'audio/octet-stream') return base;
  return EXTENSION_MIME[extensionOf(url)] ?? 'audio/mpeg';
}

const DOWNLOAD_PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
} as const;

/** Risposta di errore JSON delle rotte di download (private, con Retry-After se presente). */
export function offlineDownloadError(
  error: string,
  message: string,
  status: number,
  retryAfterSeconds?: number,
): Response {
  const headers = new Headers(DOWNLOAD_PRIVATE_HEADERS);
  if (retryAfterSeconds) headers.set('Retry-After', String(retryAfterSeconds));
  return Response.json(
    { error, message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
    { status, headers },
  );
}

/**
 * Risposta con i byte audio come corpo e i metadati (validati) in un header JSON+base64. Il client
 * legge l'header, lo valida con OfflineDownloadMetaSchema e passa i campi a addDownloadedTrack.
 */
export function offlineDownloadResponse(
  bytes: Uint8Array,
  mimeType: string,
  meta: OfflineDownloadMeta,
): Response {
  const parsed = OfflineDownloadMetaSchema.parse(meta);
  const encoded = Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64');
  const headers = new Headers(DOWNLOAD_PRIVATE_HEADERS);
  headers.set('Content-Type', mimeType);
  headers.set('Content-Length', String(bytes.byteLength));
  headers.set('Content-Disposition', 'attachment');
  headers.set(OFFLINE_DOWNLOAD_META_HEADER, encoded);
  // Un Uint8Array è un BodyInit valido; i byte sono già in memoria (entro MAX_DOWNLOAD_BYTES).
  return new Response(bytes, { status: 200, headers });
}

export type BoundedBody = Uint8Array | 'too_large' | 'error';

/** Legge il corpo di una risposta in memoria, fino a maxBytes; oltre, interrompe e torna 'too_large'. */
export async function readBoundedBody(response: Response, maxBytes: number): Promise<BoundedBody> {
  const reader = response.body?.getReader();
  if (!reader) return 'error';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return 'too_large';
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return 'error';
  }
  if (size === 0) return 'error';
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export type BoundedAudio =
  | { ok: true; bytes: Uint8Array; contentType: string | null }
  | { ok: false; reason: 'too_large' | 'unavailable' | 'blocked_host' | 'not_audio' };

/**
 * Scarica l'audio da `url` in modo SSRF-safe: ogni salto (reindirizzamenti inclusi) deve essere
 * HTTPS pubblico (assertPublicHttpsUrl), http→https come nel browser, corpo limitato a maxBytes.
 * Usato per le enclosure dei podcast (l'URL viene dal feed ufficiale dello show, mai dall'utente).
 */
export async function fetchBoundedAudio(
  url: string,
  options: {
    maxBytes?: number;
    fetcher?: FetchLike;
    resolve?: (host: string) => Promise<string[]>;
  } = {},
): Promise<BoundedAudio> {
  const fetcher = options.fetcher ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const headers = { Accept: 'audio/*', 'User-Agent': DOWNLOAD_USER_AGENT };
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let target: URL;
    try {
      target = await assertPublicHttpsUrl(current, options.resolve);
    } catch {
      return { ok: false, reason: 'blocked_host' };
    }
    let response: Response;
    try {
      response = await fetcher(target, {
        method: 'GET',
        headers,
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      discard(response);
      if (!location) return { ok: false, reason: 'unavailable' };
      const next = new URL(location, target);
      if (next.protocol === 'http:') next.protocol = 'https:';
      current = next.toString();
      continue;
    }
    if (response.status !== 200) {
      discard(response);
      return { ok: false, reason: 'unavailable' };
    }
    const contentType = response.headers.get('content-type');
    if (!mayBeAudioContentType(contentType)) {
      discard(response);
      return { ok: false, reason: 'not_audio' };
    }
    const body = await readBoundedBody(response, maxBytes);
    if (body === 'too_large') return { ok: false, reason: 'too_large' };
    if (body === 'error') return { ok: false, reason: 'unavailable' };
    return { ok: true, bytes: body, contentType };
  }
  return { ok: false, reason: 'unavailable' };
}

// ---------- Audius ----------

export type AudiusDownloadResolution =
  | {
      ok: true;
      title: string;
      artist: string | null;
      sourceUrl: string | null;
      durationSeconds: number | null;
      attribution: OfflineAttribution;
    }
  | {
      ok: false;
      reason: AudiusPlaybackReason | 'not_downloadable' | 'source_inactive';
      retryAfterSeconds?: number;
    };

/**
 * Riverifica un brano Audius lato server prima di scaricarlo: deve essere riproducibile sotto la
 * Open Music License (evaluateAudiusPlayback, via normalizeAudiusTracks) E avere is_downloadable.
 * Raccoglie anche l'attribuzione (artista, pagina, licenza, copyright).
 */
export async function resolveAudiusDownload(
  trackId: string,
  client: AudiusDownloadClient,
): Promise<AudiusDownloadResolution> {
  let payload: unknown;
  try {
    payload = await client.getTrack(trackId);
  } catch (error) {
    if (error instanceof AudiusApiError && error.kind === 'rate_limited') {
      return {
        ok: false,
        reason: 'rate_limited',
        retryAfterSeconds: error.retryAfterSeconds ?? undefined,
      };
    }
    return { ok: false, reason: 'state_unknown' };
  }
  const track = normalizeAudiusTracks(payload, true).find((item) => item.id === trackId);
  if (!track) return { ok: false, reason: 'state_unknown' };
  if (!track.playbackEligible) return { ok: false, reason: track.playbackReason };
  if (audiusTrackDownloadFlag(payload, trackId) !== true) {
    return { ok: false, reason: 'not_downloadable' };
  }
  return {
    ok: true,
    title: track.title,
    artist: track.artistName,
    sourceUrl: track.trackUrl,
    durationSeconds: track.durationSeconds,
    attribution: {
      sourceName: 'Audius',
      sourceUrl: track.trackUrl,
      licenseName: AUDIUS_OPEN_MUSIC_LICENSE_NAME,
      licenseUrl: AUDIUS_OPEN_MUSIC_LICENSE_URL,
      creditLine: audiusCopyrightText({
        copyrightNotice: track.copyrightNotice,
        licensorName: track.licensorName,
        attributionRemovalRequested: track.attributionRemovalRequested,
      }),
    },
  };
}

/**
 * Scarica i byte audio di un brano Audius dal flusso ufficiale (gli host del protocollo), con
 * corpo limitato. Rispecchia la rotta di streaming, ma legge l'intero file (entro il tetto).
 */
export async function downloadAudiusAudio(
  trackId: string,
  client: AudiusDownloadClient,
  maxBytes = MAX_DOWNLOAD_BYTES,
): Promise<BoundedAudio | { ok: false; reason: 'rate_limited'; retryAfterSeconds?: number }> {
  let upstream: Response;
  try {
    upstream = await client.streamTrack(trackId, null);
  } catch (error) {
    if (error instanceof AudiusApiError && error.kind === 'rate_limited') {
      return {
        ok: false,
        reason: 'rate_limited',
        retryAfterSeconds: error.retryAfterSeconds ?? undefined,
      };
    }
    return { ok: false, reason: 'unavailable' };
  }
  const contentType = upstream.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if ((upstream.status !== 200 && upstream.status !== 206) || !upstream.body) {
    discard(upstream);
    return { ok: false, reason: 'unavailable' };
  }
  if (!contentType?.startsWith('audio/')) {
    discard(upstream);
    return { ok: false, reason: 'not_audio' };
  }
  const body = await readBoundedBody(upstream, maxBytes);
  if (body === 'too_large') return { ok: false, reason: 'too_large' };
  if (body === 'error') return { ok: false, reason: 'unavailable' };
  return { ok: true, bytes: body, contentType };
}
