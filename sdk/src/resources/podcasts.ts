// @solco/sdk — podcast (iTunes Search + RSS, via proxy di Solco).

import type { HttpClient } from '../http.js';
import type { PodcastDetailResponse, PodcastListResponse } from '../types.js';

export class PodcastsResource {
  constructor(private readonly http: HttpClient) {}

  /** Elenco podcast per testo (`q`). */
  async list(options: { q?: string } = {}): Promise<PodcastListResponse> {
    return this.http.requestJson<PodcastListResponse>('/api/music/podcasts', {
      query: { q: options.q },
    });
  }

  /** Dettaglio di un podcast con i suoi episodi. */
  async get(podcastId: string): Promise<PodcastDetailResponse> {
    return this.http.requestJson<PodcastDetailResponse>(
      `/api/music/podcasts/${encodeURIComponent(podcastId)}`,
    );
  }
}
