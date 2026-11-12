// @solco/sdk — download offline "scarica il permesso".
//
// Le rotte di download restituiscono i BYTE audio come corpo e i metadati per
// salvare il brano in un header (`x-solco-download`, JSON in base64). Scaricano
// solo ciò che le licenze permettono: brani Audius marcati scaricabili dall'artista
// (Open Music License) ed episodi di podcast. Sono mutazioni: richiedono sessione
// e same-origin (lato server l'SDK invia `Origin` = baseUrl).

import type { HttpClient } from '../http.js';
import type { OfflineDownload, OfflineDownloadMeta } from '../types.js';

/** Header che porta i metadati del brano scaricato (JSON in base64). */
export const OFFLINE_DOWNLOAD_META_HEADER = 'x-solco-download';

export class OfflineResource {
  constructor(private readonly http: HttpClient) {}

  /** Scarica un brano Audius scaricabile. Lancia se l'artista non ne consente il download (403). */
  async downloadAudiusTrack(trackId: string): Promise<OfflineDownload> {
    return this.download(`/api/music/audius/tracks/${encodeURIComponent(trackId)}/download`);
  }

  /** Scarica un episodio di podcast. */
  async downloadPodcastEpisode(podcastId: string, episodeKey: string): Promise<OfflineDownload> {
    return this.download(
      `/api/music/podcasts/${encodeURIComponent(podcastId)}/episodes/${encodeURIComponent(
        episodeKey,
      )}/download`,
    );
  }

  private async download(path: string): Promise<OfflineDownload> {
    const res = await this.http.requestBinary(path, { method: 'POST' });
    const rawMeta = res.headers.get(OFFLINE_DOWNLOAD_META_HEADER);
    if (!rawMeta) {
      throw new Error(`Risposta di download senza l'header ${OFFLINE_DOWNLOAD_META_HEADER}.`);
    }
    let meta: OfflineDownloadMeta;
    try {
      meta = JSON.parse(base64ToUtf8(rawMeta)) as OfflineDownloadMeta;
    } catch {
      throw new Error(
        `Metadati di download non validi nell'header ${OFFLINE_DOWNLOAD_META_HEADER}.`,
      );
    }
    return { bytes: res.bytes, meta, contentType: res.contentType };
  }
}

/** Decodifica base64 → stringa UTF-8, in Node e nel browser. */
function base64ToUtf8(b64: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(b64, 'base64').toString('utf8');
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}
