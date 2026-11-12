// @solco/sdk — punto d'ingresso pubblico.

export type { SolcoClientOptions } from './client.js';
export { createSolcoClient, SolcoClient } from './client.js';
export type { StoredCookie } from './cookies.js';
export { CookieJar } from './cookies.js';
export { SolcoApiError, solcoApiErrorFromResponse } from './errors.js';
export type {
  BinaryResponse,
  FetchLike,
  HttpClientOptions,
  QueryValue,
  RequestOptions,
} from './http.js';
export { DEFAULT_BASE_URL, HttpClient } from './http.js';
export type { AuthEmailResult } from './resources/auth.js';

export { AuthResource } from './resources/auth.js';
export type { SearchAllInput, SearchInput } from './resources/music.js';
export { MusicResource } from './resources/music.js';
export { OFFLINE_DOWNLOAD_META_HEADER, OfflineResource } from './resources/offline.js';
export { PlaysResource } from './resources/plays.js';
export { PodcastsResource } from './resources/podcasts.js';
export { RadioResource } from './resources/radio.js';
export { StatusResource } from './resources/status.js';
export { Streams } from './streams.js';

export type * from './types.js';
