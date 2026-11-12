// @polsia:user-owned — "Scarica il permesso" per Audius: scarica OFFLINE un brano SOLO se l'artista
// lo ha reso scaricabile (is_downloadable) ED è riproducibile sotto la Open Music License. Richiede
// il login, è same-origin, è limitato (music.download) e conta il download solo a byte confermati.
import 'server-only';
import type { OfflineDownloadMeta } from '@/lib/contracts/offline';
import type { AudiusPlaybackReason } from '@/lib/music/audius';
import { getAudiusPlaybackReasonText } from '@/lib/music/audius';
import { createAudiusApiClient, readAudiusApiKey } from '@/lib/music/audius-api.server';
import { playbackFailureStatus } from '@/lib/music/audius-playback.server';
import {
  consumeDownloadLimits,
  downloadAudiusAudio,
  offlineDownloadError,
  offlineDownloadResponse,
  peekDownloadLimits,
  resolveAudiusDownload,
  resolveDownloadMime,
} from '@/lib/music/offline-download.server';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

function resolutionError(
  reason: AudiusPlaybackReason | 'not_downloadable' | 'source_inactive',
  retryAfterSeconds?: number,
): Response {
  if (reason === 'not_downloadable') {
    return offlineDownloadError(
      'not_downloadable',
      'L’artista non ha reso questo brano scaricabile: si ascolta solo in streaming su Audius.',
      403,
    );
  }
  if (reason === 'source_inactive') {
    return offlineDownloadError(
      'source_inactive',
      'Il download da Audius non è al momento disponibile. Riprova più tardi.',
      503,
    );
  }
  if (reason === 'rate_limited') {
    return offlineDownloadError(
      'rate_limited',
      'Audius ha limitato le richieste; attendi qualche istante e riprova.',
      429,
      retryAfterSeconds,
    );
  }
  return offlineDownloadError(
    reason,
    getAudiusPlaybackReasonText(reason),
    playbackFailureStatus(reason),
  );
}

function bytesError(
  reason: 'too_large' | 'unavailable' | 'blocked_host' | 'not_audio' | 'rate_limited',
  retryAfterSeconds?: number,
): Response {
  if (reason === 'too_large') {
    return offlineDownloadError(
      'too_large',
      'Questo brano supera il limite di 50 MB per il download offline.',
      413,
    );
  }
  if (reason === 'rate_limited') {
    return offlineDownloadError(
      'rate_limited',
      'Audius ha limitato le richieste; attendi qualche istante e riprova.',
      429,
      retryAfterSeconds,
    );
  }
  return offlineDownloadError(
    'download_unavailable',
    'Non è stato possibile scaricare il brano da Audius. Riprova più tardi.',
    502,
  );
}

export async function POST(request: Request, { params }: { params: Promise<{ trackId: string }> }) {
  if (!sameOrigin(request)) {
    return offlineDownloadError('forbidden_origin', 'Richiesta non consentita.', 403);
  }

  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return response as Response;
  }

  const { trackId } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(trackId)) {
    return offlineDownloadError('track_not_found', 'Brano Audius non trovato.', 404);
  }

  const apiKey = readAudiusApiKey();
  if (!apiKey.trim()) {
    return offlineDownloadError(
      'source_inactive',
      'Il download da Audius non è al momento disponibile.',
      503,
    );
  }

  // Limite verificato (senza contare) prima di qualsiasi chiamata ad Audius.
  const limited = await peekDownloadLimits(user.id);
  if (limited) return limited;

  const client = createAudiusApiClient({ apiKey });
  const resolution = await resolveAudiusDownload(trackId, client);
  if (!resolution.ok) return resolutionError(resolution.reason, resolution.retryAfterSeconds);

  const audio = await downloadAudiusAudio(trackId, client);
  if (!audio.ok) {
    return bytesError(
      audio.reason,
      'retryAfterSeconds' in audio ? audio.retryAfterSeconds : undefined,
    );
  }

  // Byte confermati: ora si conta il download (se il limite è stato raggiunto nel frattempo, si rifiuta).
  const counted = await consumeDownloadLimits(user.id);
  if (counted) return counted;

  const mimeType = resolveDownloadMime(audio.contentType, resolution.sourceUrl ?? '');
  const meta: OfflineDownloadMeta = {
    source: 'audius-download',
    downloadKey: `audius:${trackId}`,
    title: resolution.title,
    artist: resolution.artist,
    album: null,
    durationSeconds: resolution.durationSeconds,
    mimeType,
    attribution: resolution.attribution,
  };
  return offlineDownloadResponse(audio.bytes, mimeType, meta);
}
