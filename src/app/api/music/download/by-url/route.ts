// @polsia:user-owned — "Scarica da URL": incolli un link e il server lo scarica SOLO se la sorgente è
// consentita (un TUO upload su Solco, verificato per proprietario, oppure un brano Audius scaricabile).
// Richiede login, è same-origin, è limitato (music.download, con prenotazione+rimborso) e il fetch è
// SSRF-safe con tetto di 50 MB. Non è un proxy aperto: YouTube/Spotify e i link arbitrari sono rifiutati.
import 'server-only';
import { NextResponse } from 'next/server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { DownloadByUrlRequestSchema } from '@/lib/contracts/url-download';
import { releaseDownloadLimits, reserveDownloadLimits } from '@/lib/music/offline-download.server';
import { downloadFromUrl } from '@/lib/music/url-download.server';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
/** Scarica fino a 50 MB in modo SSRF-safe: margine ampio oltre il default della funzione. */
export const maxDuration = 60;

const MAX_BODY_BYTES = 4 * 1024;
const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
} as const;

function errorJson(error: string, message: string, status: number, retryAfterSeconds?: number) {
  const headers = new Headers(PRIVATE_HEADERS);
  if (retryAfterSeconds) headers.set('Retry-After', String(retryAfterSeconds));
  return NextResponse.json(
    { error, message, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
    { status, headers },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return errorJson('forbidden_origin', 'Richiesta non consentita.', 403);
  }

  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return response as Response;
  }

  const body = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!body.ok) {
    return body.status === 413
      ? limitedJsonError(body)
      : errorJson('invalid_request', 'Richiesta non valida.', 400);
  }
  const parsed = DownloadByUrlRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return errorJson('invalid_request', 'Serve un link https valido.', 400);
  }

  // Prenota lo slot PRIMA di scaricare: niente burst oltre il limite (ogni richiesta fino a 50 MB).
  const reserved = await reserveDownloadLimits(user.id);
  if (reserved) return reserved;

  let result: Awaited<ReturnType<typeof downloadFromUrl>>;
  try {
    result = await downloadFromUrl(parsed.data.url, user.id);
  } catch {
    await releaseDownloadLimits(user.id);
    return errorJson('download_unavailable', 'Download non riuscito. Riprova più tardi.', 502);
  }

  if (!result.ok) {
    // Nessun download andato a buon fine (sorgente non consentita, errore, ecc.): rimborsa lo slot.
    await releaseDownloadLimits(user.id);
    return errorJson(result.error, result.message, result.status, result.retryAfterSeconds);
  }

  // filename= (ASCII, fallback) + filename*= (UTF-8, nome reale) per i browser moderni.
  const asciiName = result.filename.replace(/[^\x20-\x7e]/g, '_');
  const utf8Name = encodeURIComponent(result.filename);
  const headers = new Headers(PRIVATE_HEADERS);
  headers.set('Content-Type', result.mimeType);
  headers.set('Content-Length', String(result.bytes.byteLength));
  headers.set(
    'Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
  );
  return new Response(result.bytes, { status: 200, headers });
}
