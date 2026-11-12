// @solco/sdk — client principale.

import type { CookieJar } from './cookies.js';
import type { HttpClientOptions, RequestOptions } from './http.js';
import { HttpClient } from './http.js';
import { AuthResource } from './resources/auth.js';
import { MusicResource } from './resources/music.js';
import { OfflineResource } from './resources/offline.js';
import { PlaysResource } from './resources/plays.js';
import { PodcastsResource } from './resources/podcasts.js';
import { RadioResource } from './resources/radio.js';
import { StatusResource } from './resources/status.js';
import { Streams } from './streams.js';

export type SolcoClientOptions = HttpClientOptions;

/**
 * Client tipizzato per l'API di Solco.
 *
 * @example
 * ```ts
 * import { SolcoClient } from '@solco/sdk';
 *
 * const solco = new SolcoClient(); // default: https://solcomusic.vercel.app
 * const home = await solco.music.home();
 * const results = await solco.music.searchAll({ q: 'nina zilli', youtube: true });
 * const src = solco.streams.audius(home.trending.tracks[0]!.id);
 * ```
 */
export class SolcoClient {
  /** Nucleo HTTP (per chiamate d'eccezione o per ispezione). */
  readonly http: HttpClient;
  readonly auth: AuthResource;
  readonly music: MusicResource;
  readonly radio: RadioResource;
  readonly podcasts: PodcastsResource;
  readonly status: StatusResource;
  readonly plays: PlaysResource;
  readonly offline: OfflineResource;
  readonly streams: Streams;

  constructor(options: SolcoClientOptions = {}) {
    this.http = new HttpClient(options);
    this.auth = new AuthResource(this.http);
    this.music = new MusicResource(this.http);
    this.radio = new RadioResource(this.http);
    this.podcasts = new PodcastsResource(this.http);
    this.status = new StatusResource(this.http);
    this.plays = new PlaysResource(this.http);
    this.offline = new OfflineResource(this.http);
    this.streams = new Streams(this.http.baseUrl);
  }

  /** URL base configurato. */
  get baseUrl(): string {
    return this.http.baseUrl;
  }

  /** Barattolo di cookie di sessione (solo lato server; `null` nel browser). */
  get cookieJar(): CookieJar | null {
    return this.http.cookieJar;
  }

  /**
   * Chiamata grezza a un percorso dell'API, per endpoint non ancora coperti da un
   * metodo dedicato. Restituisce il JSON tipizzato e lancia {@link SolcoApiError}
   * sugli stati non-2xx.
   */
  request<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.http.requestJson<T>(path, options);
  }
}

/** Scorciatoia funzionale per creare un {@link SolcoClient}. */
export function createSolcoClient(options: SolcoClientOptions = {}): SolcoClient {
  return new SolcoClient(options);
}
