// @solco/sdk — nucleo HTTP.
//
// Un solo punto per: costruzione URL + query, header di default, sessione via
// cookie (lato server), header `Origin` sulle richieste che modificano dati
// (il backend di Solco rifiuta con 403 le mutazioni la cui `Origin` non combacia
// con NEXT_PUBLIC_APP_URL), parsing degli errori in {@link SolcoApiError}.
//
// Browser vs server:
// - Browser: i cookie e l'header `Origin` li gestisce il browser. Usiamo
//   `credentials: 'include'` e NON tocchiamo `Origin` (è un header vietato).
//   Le mutazioni cross-origin restano bloccate da CORS + same-origin, come
//   previsto dal backend.
// - Server (Node/Bun/Deno): teniamo noi i cookie in un {@link CookieJar} e
//   impostiamo `Origin` = baseUrl così le mutazioni passano il controllo CSRF.

import { CookieJar } from './cookies.js';
import { solcoApiErrorFromResponse } from './errors.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type QueryValue = string | number | boolean | null | undefined;

export interface HttpClientOptions {
  /** URL base, senza slash finale. Default: https://solcomusic.vercel.app */
  baseUrl?: string;
  /** Implementazione di fetch da usare. Default: `globalThis.fetch`. */
  fetch?: FetchLike;
  /**
   * Barattolo di cookie per la sessione lato server. Default: un barattolo nuovo
   * fuori dal browser, nessuno nel browser. Passare `null` per disattivarlo.
   */
  cookieJar?: CookieJar | null;
  /** Header inviati su ogni richiesta. */
  headers?: Record<string, string>;
  /**
   * Valore dell'header `Origin` per le mutazioni lato server. Default: baseUrl.
   * Deve combaciare con NEXT_PUBLIC_APP_URL (o un trusted origin) del deploy.
   */
  origin?: string;
  /** User-Agent inviato fuori dal browser. Default: `solco-sdk/<versione>`. */
  userAgent?: string;
}

export interface RequestOptions {
  method?: string;
  query?: Record<string, QueryValue>;
  /** Corpo JSON (serializzato automaticamente). Ignorato se `rawBody` è presente. */
  body?: unknown;
  /** Corpo grezzo, già pronto (ha precedenza su `body`). */
  rawBody?: BodyInit | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface BinaryResponse {
  bytes: Uint8Array;
  headers: Headers;
  contentType: string;
}

export const DEFAULT_BASE_URL = 'https://solcomusic.vercel.app';
const SDK_VERSION = '0.1.0';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isBrowserEnv(): boolean {
  return typeof window !== 'undefined' && typeof window.document !== 'undefined';
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  // Convalida presto: un baseUrl rotto deve fallire alla costruzione, non a metà uso.
  const url = new URL(trimmed);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`baseUrl non valido: ${raw}`);
  }
  return trimmed;
}

export class HttpClient {
  readonly baseUrl: string;
  readonly origin: string;
  readonly cookieJar: CookieJar | null;
  private readonly fetchImpl: FetchLike;
  private readonly defaultHeaders: Record<string, string>;
  private readonly userAgent: string;
  private readonly browser: boolean;

  constructor(options: HttpClientOptions = {}) {
    this.browser = isBrowserEnv();
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    // Origin canonico (scheme://host[:porta]): un baseUrl con un percorso non deve
    // finire nell'header Origin, altrimenti non combacia mai col controllo same-origin.
    this.origin = new URL(options.origin ?? this.baseUrl).origin;

    const resolvedFetch = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!resolvedFetch) {
      throw new Error(
        'Nessuna implementazione di fetch disponibile. Passare `fetch` nelle opzioni del client.',
      );
    }
    // Bind a globalThis: undici richiede il `this` corretto quando fetch è sganciato.
    this.fetchImpl = options.fetch ? resolvedFetch : (resolvedFetch.bind(globalThis) as FetchLike);

    if (options.cookieJar === undefined) {
      this.cookieJar = this.browser ? null : new CookieJar();
    } else {
      this.cookieJar = options.cookieJar;
    }

    this.defaultHeaders = { ...options.headers };
    this.userAgent = options.userAgent ?? `solco-sdk/${SDK_VERSION}`;
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === null || value === undefined) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /** Prepara init (header, cookie, origin, corpo) comune a tutte le richieste. */
  private prepare(path: string, options: RequestOptions): { url: string; init: RequestInit } {
    const method = (options.method ?? 'GET').toUpperCase();
    const headers = new Headers();
    for (const [k, v] of Object.entries(this.defaultHeaders)) headers.set(k, v);
    headers.set('accept', 'application/json');
    if (!this.browser) headers.set('user-agent', this.userAgent);

    let body: BodyInit | null | undefined;
    if (options.rawBody !== undefined) {
      body = options.rawBody;
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers.set('content-type', 'application/json');
    }

    // Sessione via cookie fuori dal browser.
    if (this.cookieJar && !this.browser) {
      const cookie = this.cookieJar.header();
      if (cookie) headers.set('cookie', cookie);
    }

    // Origin sulle mutazioni, solo fuori dal browser (nel browser è un header vietato).
    if (!this.browser && !SAFE_METHODS.has(method) && !headers.has('origin')) {
      headers.set('origin', this.origin);
    }

    // Header espliciti della chiamata hanno la precedenza.
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) headers.set(k, v);
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = body;
    if (options.signal) init.signal = options.signal;
    if (this.browser) init.credentials = 'include';
    return { url: this.buildUrl(path, options.query), init };
  }

  private async send(path: string, options: RequestOptions): Promise<Response> {
    const { url, init } = this.prepare(path, options);
    const res = await this.fetchImpl(url, init);
    if (this.cookieJar && !this.browser) this.cookieJar.absorb(res.headers);
    return res;
  }

  /** Esegue la richiesta e restituisce il JSON tipizzato. Lancia {@link SolcoApiError} su non-2xx. */
  async requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.send(path, options);
    const parsed = await readJsonSafe(res);
    if (!res.ok) {
      throw solcoApiErrorFromResponse(path, res.status, parsed, res.headers.get('retry-after'));
    }
    return parsed as T;
  }

  /** Richiesta che restituisce byte (es. download). Lancia {@link SolcoApiError} su non-2xx. */
  async requestBinary(path: string, options: RequestOptions = {}): Promise<BinaryResponse> {
    const res = await this.send(path, options);
    if (!res.ok) {
      const parsed = await readJsonSafe(res);
      throw solcoApiErrorFromResponse(path, res.status, parsed, res.headers.get('retry-after'));
    }
    const buffer = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(buffer),
      headers: res.headers,
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  /** Richiesta grezza; restituisce la Response così com'è (nessun throw sugli stati). */
  async requestRaw(path: string, options: RequestOptions = {}): Promise<Response> {
    return this.send(path, options);
  }
}

async function readJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
