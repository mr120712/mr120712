// @solco/sdk — conteggio ascolti (mutazione: richiede sessione e same-origin).

import type { HttpClient } from '../http.js';
import type { PlayResult } from '../types.js';

export class PlaysResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Registra un ascolto per l'identificativo qualificato del brano (es.
   * `audius:<id>`). Richiede una sessione valida; il backend applica il limite
   * del piano Free (40 ascolti/mese) e risponde con quelli usati e il limite.
   *
   * È una mutazione: nel browser va chiamata da una pagina della stessa origine
   * di Solco; lato server l'SDK invia `Origin` = baseUrl così passa il controllo.
   */
  async record(qualifiedId: string): Promise<PlayResult> {
    return this.http.requestJson<PlayResult>('/api/music/plays', {
      method: 'POST',
      body: { qualifiedId },
    });
  }
}
