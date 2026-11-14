// @polsia:user-owned — "Scarica da URL": da un link incollato, scarica il file SOLO se la sorgente è
// consentita. Allowlist stretta: (1) un TUO brano caricato su Solco (match esatto del blobUrl su
// Vercel Blob verificato per proprietario a DB — nessun IDOR), (2) un brano Audius SCARICABILE
// (is_downloadable + Open Music License, riverificato lato server). Qualsiasi altro host (YouTube,
// Spotify, link arbitrari) è rifiutato: niente ripping di terzi e niente proxy SSRF aperto.
//
// Il fetch è sempre SSRF-safe (riusa fetchBoundedAudio / lo stream Audius ufficiale, con DNS pinning,
// solo HTTPS pubblico, corpo limitato a 50 MB). Ritorna dati, non una Response: la rotta costruisce
// l'allegato o l'errore JSON. Testabile a sé.
import 'server-only';
import { MAX_DOWNLOAD_URL_LENGTH } from '@/lib/contracts/url-download';
import { prisma } from '@/lib/db';
import { createAudiusApiClient, readAudiusApiKey } from '@/lib/music/audius-api.server';
import {
  type BoundedAudio,
  downloadAudiusAudio,
  fetchBoundedAudio,
  resolveAudiusDownload,
} from '@/lib/music/offline-download.server';

/** Suffisso degli host pubblici di Vercel Blob (CDN). Il match vero resta la riga di proprietà a DB. */
const BLOB_HOST_SUFFIX = '.blob.vercel-storage.com';

export type UrlDownloadResult =
  | { ok: true; bytes: Uint8Array; mimeType: string; filename: string }
  | { ok: false; status: number; error: string; message: string; retryAfterSeconds?: number };

const REJECTED: UrlDownloadResult = {
  ok: false,
  status: 403,
  error: 'source_not_allowed',
  message:
    'Posso scaricare solo i TUOI brani caricati su Solco o brani Audius resi scaricabili dall’artista. I link esterni (YouTube, Spotify, siti vari) non sono consentiti.',
};

/** URL https valido, senza credenziali e non troppo lungo; altrimenti null. */
function normalizeHttpsUrl(raw: string): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_DOWNLOAD_URL_LENGTH) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url;
}

/** Forma canonica usata per il confronto col blobUrl salvato: origine + percorso, senza query/hash. */
function canonicalUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/** Nome file sicuro dal titolo: lettere/numeri/poca punteggiatura, lunghezza limitata. */
function safeBaseName(title: string): string {
  const cleaned = title
    .replace(/[^\p{L}\p{N} .,_()-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'brano';
}

/** Estensione dedotta dal percorso dell'oggetto (costruito dal server con l'estensione giusta). */
function extensionFromPath(pathname: string): string {
  const base = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'mp3';
}

function buildFilename(title: string, ext: string): string {
  return `${safeBaseName(title)}.${ext}`;
}

/** Un host Audius ufficiale (pagina pubblica audius.co/.org): da lì risolviamo l'id del brano. */
function isAudiusHost(host: string): boolean {
  return (
    host === 'audius.co' ||
    host.endsWith('.audius.co') ||
    host === 'audius.org' ||
    host.endsWith('.audius.org')
  );
}

/** Estrae un id di brano dalla risposta /v1/resolve di Audius (forma `{ data: entity|[entity] }`). */
function extractAudiusTrackId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = (payload as { data?: unknown }).data;
  const entity = Array.isArray(data) ? data[0] : data;
  if (!entity || typeof entity !== 'object') return null;
  const id = (entity as { id?: unknown }).id;
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

function mapBoundedError(reason: Exclude<BoundedAudio, { ok: true }>['reason']): UrlDownloadResult {
  if (reason === 'too_large') {
    return {
      ok: false,
      status: 413,
      error: 'too_large',
      message: 'Il file supera il limite di 50 MB per il download.',
    };
  }
  if (reason === 'not_audio') {
    return {
      ok: false,
      status: 415,
      error: 'not_audio',
      message: 'La sorgente non è un file audio.',
    };
  }
  if (reason === 'blocked_host') {
    return {
      ok: false,
      status: 400,
      error: 'blocked_host',
      message: 'Sorgente non raggiungibile in sicurezza.',
    };
  }
  return {
    ok: false,
    status: 502,
    error: 'download_unavailable',
    message: 'Non è stato possibile scaricare il file. Riprova più tardi.',
  };
}

/** Scarica un TUO upload (proprietario verificato a DB) in modo SSRF-safe e limitato. */
async function downloadOwnUpload(url: URL, userId: string): Promise<UrlDownloadResult> {
  const canonical = canonicalUrl(url);
  // blobUrl è @unique: il match su (blobUrl, uploaderUserId) ritorna la riga SOLO se è la tua.
  // L'URL di un altro utente qui ritorna null → rifiutato, nessun IDOR.
  const upload = await prisma.publicUpload.findFirst({
    where: { blobUrl: canonical, uploaderUserId: userId },
    select: { blobUrl: true, blobPathname: true, title: true, mimeType: true },
  });
  if (!upload) return REJECTED;
  const audio = await fetchBoundedAudio(upload.blobUrl);
  if (!audio.ok) return mapBoundedError(audio.reason);
  return {
    ok: true,
    bytes: audio.bytes,
    mimeType: upload.mimeType || audio.contentType || 'audio/mpeg',
    filename: buildFilename(upload.title, extensionFromPath(upload.blobPathname)),
  };
}

/** Scarica un brano Audius SOLO se riscaricabile sotto la Open Music License (riverificato). */
async function downloadAudiusByUrl(url: URL): Promise<UrlDownloadResult> {
  const apiKey = readAudiusApiKey();
  if (!apiKey.trim()) {
    return {
      ok: false,
      status: 503,
      error: 'source_inactive',
      message: 'Il download da Audius non è al momento disponibile.',
    };
  }
  const client = createAudiusApiClient({ apiKey });
  let trackId: string | null = null;
  try {
    trackId = extractAudiusTrackId(await client.resolve(canonicalUrl(url)));
  } catch {
    trackId = null;
  }
  if (!trackId) {
    return {
      ok: false,
      status: 404,
      error: 'track_not_found',
      message: 'Non ho trovato un brano Audius a quel link.',
    };
  }
  const resolution = await resolveAudiusDownload(trackId, client);
  if (!resolution.ok) {
    if (resolution.reason === 'not_downloadable') {
      return {
        ok: false,
        status: 403,
        error: 'not_downloadable',
        message:
          'L’artista non ha reso questo brano scaricabile: si ascolta solo in streaming su Audius.',
      };
    }
    if (resolution.reason === 'rate_limited') {
      return {
        ok: false,
        status: 429,
        error: 'rate_limited',
        message: 'Audius ha limitato le richieste; attendi qualche istante e riprova.',
        retryAfterSeconds: resolution.retryAfterSeconds,
      };
    }
    return {
      ok: false,
      status: 502,
      error: 'download_unavailable',
      message: 'Il brano non è scaricabile in questo momento.',
    };
  }
  const audio = await downloadAudiusAudio(trackId, client);
  if (!audio.ok) {
    if (audio.reason === 'rate_limited') {
      return {
        ok: false,
        status: 429,
        error: 'rate_limited',
        message: 'Audius ha limitato le richieste; attendi qualche istante e riprova.',
        retryAfterSeconds: 'retryAfterSeconds' in audio ? audio.retryAfterSeconds : undefined,
      };
    }
    return mapBoundedError(audio.reason);
  }
  return {
    ok: true,
    bytes: audio.bytes,
    mimeType: audio.contentType ?? 'audio/mpeg',
    filename: buildFilename(resolution.title, 'mp3'),
  };
}

/**
 * Punto d'ingresso: classifica l'URL e scarica se la sorgente è consentita. Il chiamante (la rotta)
 * ha GIÀ fatto autenticazione, same-origin e prenotazione del limite di download.
 */
export async function downloadFromUrl(rawUrl: string, userId: string): Promise<UrlDownloadResult> {
  const url = normalizeHttpsUrl(rawUrl);
  if (!url) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_url',
      message: 'Link non valido: incolla un indirizzo https.',
    };
  }
  const host = url.hostname.toLowerCase();
  if (host.endsWith(BLOB_HOST_SUFFIX)) return downloadOwnUpload(url, userId);
  if (isAudiusHost(host)) return downloadAudiusByUrl(url);
  return REJECTED;
}
