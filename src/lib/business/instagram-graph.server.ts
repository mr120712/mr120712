// @polsia:user-owned — client minimo della Instagram Graph API (API ufficiale di Meta).
// Solo due funzioni pubbliche di Meta: Hashtag Search (post pubblici per hashtag) e Business
// Discovery (dati pubblici di account Business/Creator). Gli account personali non sono
// raggiungibili per costruzione: niente scraping, niente ricerca di persone private.
// Variabili: INSTAGRAM_ACCESS_TOKEN (token di lunga durata, segreto), INSTAGRAM_BUSINESS_ACCOUNT_ID
// (l'ID dell'account Instagram Business di Solco), INSTAGRAM_GRAPH_VERSION (default v23.0).
import 'server-only';

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;

export const INSTAGRAM_GRAPH_BASE = 'https://graph.facebook.com';
export const INSTAGRAM_GRAPH_DEFAULT_VERSION = 'v23.0';
const REQUEST_TIMEOUT_MS = 10_000;

export interface InstagramGraphConfig {
  token: string;
  igUserId: string;
  version: string;
}

function clean(value: string | undefined) {
  return value?.trim() ? value.trim() : undefined;
}

export function instagramGraphConfig(env: Env = process.env): InstagramGraphConfig | null {
  const token = clean(env.INSTAGRAM_ACCESS_TOKEN);
  const igUserId = clean(env.INSTAGRAM_BUSINESS_ACCOUNT_ID);
  if (!token || !igUserId || !/^\d{5,25}$/.test(igUserId)) return null;
  const requested = clean(env.INSTAGRAM_GRAPH_VERSION);
  const version =
    requested && /^v\d{1,3}\.\d$/.test(requested) ? requested : INSTAGRAM_GRAPH_DEFAULT_VERSION;
  return { token, igUserId, version };
}

export type InstagramGraphFailure =
  | 'auth' // 190: token scaduto o revocato
  | 'permission' // 10, 200–299: permesso o funzione (Public Content Access) mancante
  | 'rate_limited' // 4, 17, 32, 613
  | 'hashtag_limit' // più di 30 hashtag diversi in 7 giorni
  | 'not_found' // account non Business/Creator o inesistente
  | 'timeout'
  | 'failed';

export class InstagramGraphError extends Error {
  readonly failure: InstagramGraphFailure;
  readonly code: number | null;
  constructor(failure: InstagramGraphFailure, code: number | null, message: string) {
    super(message);
    this.name = 'InstagramGraphError';
    this.failure = failure;
    this.code = code;
  }
}

/** Un messaggio di errore di Meta su una riga, corto e senza nulla che somigli al token. */
function safeMessage(message: unknown, token: string): string {
  const text = typeof message === 'string' ? message : 'Errore della Graph API';
  return text
    .split(token)
    .join('***')
    .replace(/\b(EAA|IGQ)[A-Za-z0-9_-]{10,}/g, '***')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

export function classifyGraphError(
  code: number | null,
  subcode: number | null,
  message: string,
): InstagramGraphFailure {
  if (code === 190) return 'auth';
  if (code === 4 || code === 17 || code === 32 || code === 613) return 'rate_limited';
  if (/hashtag/i.test(message) && /(limit|maximum|30)/i.test(message)) return 'hashtag_limit';
  if (code === 110 || subcode === 2207013) return 'not_found';
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) return 'permission';
  if (code === 100 && /business_discovery|cannot be found|does not exist/i.test(message)) {
    return 'not_found';
  }
  return 'failed';
}

async function graphGet<T>(
  config: InstagramGraphConfig,
  path: string,
  params: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<T> {
  const url = new URL(`${INSTAGRAM_GRAPH_BASE}/${config.version}/${path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  let res: Response;
  try {
    // Token nell'header, mai nell'URL (che finisce nei log).
    res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${config.token}`, accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new InstagramGraphError('timeout', null, 'La Graph API non ha risposto in tempo');
  }
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: unknown; error_subcode?: unknown; message?: unknown };
  } | null;
  if (!res.ok || body?.error) {
    const code = typeof body?.error?.code === 'number' ? body.error.code : null;
    const subcode =
      typeof body?.error?.error_subcode === 'number' ? body.error.error_subcode : null;
    const message = safeMessage(body?.error?.message ?? `HTTP ${res.status}`, config.token);
    throw new InstagramGraphError(classifyGraphError(code, subcode, message), code, message);
  }
  return body as T;
}

export interface GraphMedia {
  id: string;
  caption?: string;
  permalink?: string;
  like_count?: number;
  comments_count?: number;
  media_type?: string;
  timestamp?: string;
}

/** ID di un hashtag (conta per il limite di 30 hashtag diversi ogni 7 giorni). */
export async function hashtagId(
  config: InstagramGraphConfig,
  tag: string,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  const body = await graphGet<{ data?: { id?: string }[] }>(
    config,
    'ig_hashtag_search',
    { user_id: config.igUserId, q: tag },
    fetchImpl,
  );
  return body.data?.[0]?.id ?? null;
}

const MEDIA_FIELDS = 'id,caption,permalink,like_count,comments_count,media_type,timestamp';

export async function hashtagMedia(
  config: InstagramGraphConfig,
  id: string,
  edge: 'top_media' | 'recent_media',
  fetchImpl: FetchLike = fetch,
): Promise<GraphMedia[]> {
  if (!/^\d{1,30}$/.test(id)) return [];
  const body = await graphGet<{ data?: GraphMedia[] }>(
    config,
    `${id}/${edge}`,
    { user_id: config.igUserId, fields: MEDIA_FIELDS, limit: '50' },
    fetchImpl,
  );
  return Array.isArray(body.data) ? body.data : [];
}

export interface GraphProfile {
  username: string;
  name?: string;
  biography?: string;
  website?: string;
  profile_picture_url?: string;
  followers_count?: number;
  media_count?: number;
  media?: { data?: GraphMedia[] };
}

export const INSTAGRAM_USERNAME = /^[A-Za-z0-9._]{1,30}$/;

/** Dati pubblici di un account Business/Creator; null se non è raggiungibile così. */
export async function businessDiscovery(
  config: InstagramGraphConfig,
  username: string,
  fetchImpl: FetchLike = fetch,
): Promise<GraphProfile | null> {
  if (!INSTAGRAM_USERNAME.test(username)) return null;
  const fields =
    `business_discovery.username(${username})` +
    '{username,name,biography,website,profile_picture_url,followers_count,media_count,' +
    `media.limit(12){${MEDIA_FIELDS}}}`;
  try {
    const body = await graphGet<{ business_discovery?: GraphProfile }>(
      config,
      config.igUserId,
      { fields },
      fetchImpl,
    );
    return body.business_discovery ?? null;
  } catch (error) {
    if (error instanceof InstagramGraphError && error.failure === 'not_found') return null;
    throw error;
  }
}
