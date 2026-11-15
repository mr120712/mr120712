// @polsia:user-owned — POST /api/music/featured/tracks/<shareId>/download: «Scarica offline» di un
// "brano in evidenza". Restituisce i BYTE audio (come le rotte di download di Audius e dei podcast)
// SOLO per un brano DICHIARATO in diritti.json la cui voce consente la copia offline (licenza
// propria o Creative Commons commerciale senza "offline": false, oppure "offline": true; regole in
// featured-rights.server.ts).
//
// - Same-origin e login obbligatori, come gli altri download offline.
// - L'id è l'id opaco del link diretto (shareId: HMAC del pathname con il segreto del server):
//   si risolve SOLO dall'indice dei brani dichiarati, mai un percorso o un URL dal client. Un id
//   malformato, inventato, di un brano non dichiarato o non (più) dichiarato riceve la STESSA
//   risposta 404: non si rivela quali file ci sono nello store.
// - Il permesso si RICONTROLLA a ogni richiesta su diritti.json riletto dallo store (non sulla copia
//   in cache dell'indice): una revoca vale subito per i nuovi download. Dichiarato ma senza copia
//   offline → 403 con il motivo in italiano (il brano resta in streaming).
// - Stesso limite (music.download per utente + music.download.global, prenotati PRIMA del lavoro e
//   rimborsati se il download non va a buon fine: si conta solo a corpo letto per intero) e stesso
//   tetto di 50 MB degli altri download.
// - I byte si leggono lato server dallo store con il token (nessun URL pubblico al browser); i
//   metadati (titolo, artista, attribuzione) viaggiano nell'header OFFLINE_DOWNLOAD_META_HEADER;
//   Cache-Control no-store e X-Robots-Tag noindex.
// - Senza "testo": true nella voce, la copia NON porta il testo incorporato nel file (tag tolti
//   prima dell'invio e riverificati con il lettore della Libreria, featured-offline-lyrics.server):
//   se non si riesce a toglierlo → 403, il brano resta solo in streaming (download rimborsato).
import 'server-only';
import { FEATURED_DOWNLOAD_KEY_PREFIX, type OfflineDownloadMeta } from '@/lib/contracts/offline';
import { env } from '@/lib/env';
import {
  FEATURED_OFFLINE_SOURCE_NAME,
  featuredDownloadMime,
  featuredOfflineAttribution,
  readFeaturedAudio,
} from '@/lib/music/featured-offline.server';
import { withoutEmbeddedLyrics } from '@/lib/music/featured-offline-lyrics.server';
import { lyricsDeclared } from '@/lib/music/featured-rights.server';
import { resolveFeaturedOfflineDownload } from '@/lib/music/featured-search.server';
import { isFeaturedShareId } from '@/lib/music/featured-share';
import {
  offlineDownloadError,
  offlineDownloadResponse,
  releaseDownloadLimits,
  reserveDownloadLimits,
} from '@/lib/music/offline-download.server';
import { featuredOfflineReason } from '@/lib/music/offline-eligibility';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

/** La stessa risposta per id malformati, sconosciuti e brani non dichiarati. */
function notFound(): Response {
  return offlineDownloadError('track_not_found', 'Brano non trovato.', 404);
}

function unavailable(): Response {
  return offlineDownloadError(
    'source_unavailable',
    'Il download dei brani in evidenza non è disponibile in questo momento. Riprova più tardi.',
    503,
  );
}

export async function POST(request: Request, { params }: { params: Promise<{ shareId: string }> }) {
  if (!sameOrigin(request)) {
    return offlineDownloadError('forbidden_origin', 'Richiesta non consentita.', 403);
  }

  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return response as Response;
  }

  // Forma prima di tutto: un id malformato non tocca né il limite né l'indice.
  const { shareId } = await params;
  if (!isFeaturedShareId(shareId)) return notFound();

  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return unavailable();

  // Prenota lo slot PRIMA di leggere manifest e audio: niente burst oltre il limite.
  const reserved = await reserveDownloadLimits(user.id);
  if (reserved) return reserved;

  const lookup = await resolveFeaturedOfflineDownload(shareId);
  if (lookup.outcome !== 'allowed') {
    await releaseDownloadLimits(user.id); // download non avvenuto: rimborsa la prenotazione
    if (lookup.outcome === 'unavailable') return unavailable();
    if (lookup.outcome === 'not_permitted') {
      return offlineDownloadError('offline_not_allowed', featuredOfflineReason(lookup.basis), 403);
    }
    return notFound();
  }

  const audio = await readFeaturedAudio(token, lookup.audio);
  if (!audio.ok) {
    await releaseDownloadLimits(user.id);
    if (audio.reason === 'too_large') {
      return offlineDownloadError(
        'too_large',
        'Questo brano supera il limite di 50 MB per il download offline.',
        413,
      );
    }
    return offlineDownloadError(
      'download_unavailable',
      'Non è stato possibile scaricare il brano. Riprova più tardi.',
      502,
    );
  }

  const { track, entry } = lookup;
  // Il testo incorporato resta nella copia solo con "testo": true (voce ATTUALE).
  let bytes = audio.bytes;
  if (!lyricsDeclared(entry)) {
    const cleaned = await withoutEmbeddedLyrics(bytes);
    if (!cleaned.ok) {
      await releaseDownloadLimits(user.id);
      return offlineDownloadError(
        'offline_not_allowed',
        'Questo brano si ascolta solo in streaming: il suo file contiene un testo che non si può copiare sul dispositivo.',
        403,
      );
    }
    bytes = cleaned.bytes;
  }
  const mimeType = featuredDownloadMime(audio.contentType, lookup.audio.pathname);
  const meta: OfflineDownloadMeta = {
    source: 'featured-download',
    downloadKey: `${FEATURED_DOWNLOAD_KEY_PREFIX}${shareId}`,
    title: track.title,
    artist: track.artist || null,
    album: null,
    durationSeconds: track.durationSeconds > 0 ? track.durationSeconds : null,
    mimeType,
    attribution: featuredOfflineAttribution(entry),
  };
  try {
    return offlineDownloadResponse(bytes, mimeType, meta);
  } catch {
    // Metadati fuori contratto (non dovrebbe succedere): niente byte senza attribuzione valida.
    await releaseDownloadLimits(user.id);
    return offlineDownloadError(
      'download_unavailable',
      `Non è stato possibile preparare il brano di ${FEATURED_OFFLINE_SOURCE_NAME}. Riprova più tardi.`,
      502,
    );
  }
}
