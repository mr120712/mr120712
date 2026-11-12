// @polsia:user-owned — "Scarica il permesso" per i podcast: le enclosure RSS sono fatte per essere
// scaricate dai lettori. Scarica OFFLINE l'audio dell'episodio dalla sua enclosure (risolta dal
// feed ufficiale dello show, mai da un URL scelto dall'utente). Richiede il login, è same-origin,
// è limitato (music.download), SSRF-safe e conta il download solo a byte confermati.
import 'server-only';
import type { OfflineDownloadMeta } from '@/lib/contracts/offline';
import {
  consumeDownloadLimits,
  fetchBoundedAudio,
  offlineDownloadError,
  offlineDownloadResponse,
  peekDownloadLimits,
  resolveDownloadMime,
} from '@/lib/music/offline-download.server';
import { getPodcastDetail } from '@/lib/music/podcasts.server';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ podcastId: string; episodeKey: string }> },
) {
  if (!sameOrigin(request)) {
    return offlineDownloadError('forbidden_origin', 'Richiesta non consentita.', 403);
  }

  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return response as Response;
  }

  const { podcastId, episodeKey } = await params;
  if (!/^[0-9]{1,20}$/.test(podcastId) || !/^[A-Za-z0-9_-]{1,64}$/.test(episodeKey)) {
    return offlineDownloadError('episode_not_found', 'Episodio non trovato.', 404);
  }

  // Limite verificato (senza contare) prima di risolvere il feed e di scaricare.
  const limited = await peekDownloadLimits(user.id);
  if (limited) return limited;

  const detail = await getPodcastDetail(podcastId);
  if (detail.outcome === 'unavailable') {
    return offlineDownloadError(
      'podcast_unavailable',
      'Il podcast non è raggiungibile in questo momento. Riprova più tardi.',
      502,
    );
  }
  // L'episodio (e la sua enclosure) appartengono al feed ufficiale di QUESTO show: non è un URL
  // arbitrario dell'utente.
  const episode = detail.episodes.find((item) => item.key === episodeKey);
  if (!episode) {
    return offlineDownloadError('episode_not_found', 'Episodio non trovato.', 404);
  }

  const audio = await fetchBoundedAudio(episode.audioUrl);
  if (!audio.ok) {
    if (audio.reason === 'too_large') {
      return offlineDownloadError(
        'too_large',
        'Questo episodio supera il limite di 50 MB per il download offline.',
        413,
      );
    }
    return offlineDownloadError(
      'download_unavailable',
      'Non è stato possibile scaricare l’episodio. Riprova più tardi.',
      502,
    );
  }

  // Byte confermati: ora si conta il download (se il limite è stato raggiunto nel frattempo, si rifiuta).
  const counted = await consumeDownloadLimits(user.id);
  if (counted) return counted;

  const podcastTitle = detail.podcast?.title ?? null;
  const author = detail.podcast?.author ?? null;
  const mimeType = resolveDownloadMime(audio.contentType, episode.audioUrl);
  const meta: OfflineDownloadMeta = {
    source: 'podcast-download',
    downloadKey: `podcast:${podcastId}~${episodeKey}`,
    title: episode.title,
    artist: author ?? podcastTitle,
    album: podcastTitle,
    durationSeconds: episode.durationSeconds,
    mimeType,
    attribution: {
      sourceName: podcastTitle ?? 'Podcast',
      sourceUrl: null,
      licenseName: null,
      licenseUrl: null,
      creditLine: author ? `Episodio del podcast di ${author}` : null,
    },
  };
  return offlineDownloadResponse(audio.bytes, mimeType, meta);
}
