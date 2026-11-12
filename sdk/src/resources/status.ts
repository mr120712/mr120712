// @solco/sdk — stato pubblico e stato delle fonti.

import type { HttpClient } from '../http.js';
import type { MusicSourceStatusList, PublicMonitorStatus } from '../types.js';

export class StatusResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Stato pubblico del monitoraggio automatico (solo id dei controlli, nessun
   * dettaglio). Può rispondere 503 se lo stato stesso è irraggiungibile: in quel
   * caso viene sollevato un {@link SolcoApiError} con `status === 503`.
   */
  async public(): Promise<PublicMonitorStatus> {
    return this.http.requestJson<PublicMonitorStatus>('/api/status');
  }

  /** Stato delle fonti musicali (Audius, YouTube). */
  async sources(): Promise<MusicSourceStatusList> {
    return this.http.requestJson<MusicSourceStatusList>('/api/music/source-status');
  }
}
