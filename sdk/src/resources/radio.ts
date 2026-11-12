// @solco/sdk — radio (Radio Browser, via proxy di Solco).

import type { HttpClient } from '../http.js';
import type { RadioListQuery, RadioListResponse } from '../types.js';

export class RadioResource {
  constructor(private readonly http: HttpClient) {}

  /** Elenco stazioni: per testo, tag, paese (ISO2), con un limite 1–60 (default 30). */
  async list(query: RadioListQuery = {}): Promise<RadioListResponse> {
    return this.http.requestJson<RadioListResponse>('/api/music/radio', {
      query: {
        q: query.q,
        tag: query.tag,
        country: query.country,
        limit: query.limit,
      },
    });
  }
}
