// @polsia:user-owned
import 'server-only';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db';
import {
  normalizeAudiusArtists,
  normalizeAudiusPlaylists,
  normalizeAudiusTracks,
} from '@/lib/music/audius';

export const AUDIUS_API_BASE = 'https://api.audius.co/v1';
export const AUDIUS_APP_NAME = 'solco';
export const AUDIUS_METADATA_CACHE_TTL_MS = 10 * 60 * 1000;
export const AUDIUS_FREE_MONTHLY_LIMIT = 500_000;
export const AUDIUS_APP_MONTHLY_BUDGET = 450_000;
export const AUDIUS_REQUEST_SPACING_MS = 125;
const AUDIUS_HOST_DISCOVERY_URL = 'https://api.audius.co';
const AUDIUS_FALLBACK_HOSTS = [
  'https://discoveryprovider.audius.co',
  'https://discoveryprovider2.audius.co',
  'https://discoveryprovider3.audius.co',
] as const;
const MAX_QUEUE_DELAY_MS = 2_000;
const BUDGET_ROW_ID = 'global';
const MAX_METADATA_CACHE_ENTRIES = 500;

type RequestSlot =
  | { allowed: true; notBefore: number }
  | { allowed: false; retryAfterSeconds: number; reason: 'rate_limited' | 'monthly_budget' };

type AudiusFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type HostResolver = () => Promise<string[]>;
type AudiusMetadataCacheEntry = { expiresAt: number; value: unknown };

const metadataCache = new Map<string, AudiusMetadataCacheEntry>();
let audiusHostsCache: { expiresAt: number; hosts: string[] } | null = null;
let preferredAudiusHost: string | null = null;

export class AudiusApiError extends Error {
  readonly kind: 'rate_limited' | 'unavailable' | 'budget_exhausted';
  readonly retryAfterSeconds: number | null;

  constructor(
    kind: AudiusApiError['kind'],
    message: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'AudiusApiError';
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function utcMonthKey(now: Date) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function retryAfterSeconds(value: string | null, now = Date.now()) {
  if (!value) return 1;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - now) / 1000)) : 1;
}

async function reserveRequestSlot(now = Date.now()): Promise<RequestSlot> {
  const monthKey = utcMonthKey(new Date(now));
  await prisma.audiusRequestBudget.upsert({
    where: { id: BUDGET_ROW_ID },
    create: {
      id: BUDGET_ROW_ID,
      monthKey,
      requestCount: 0,
      nextRequestAt: new Date(0),
    },
    update: {},
  });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const state = await prisma.audiusRequestBudget.findUnique({ where: { id: BUDGET_ROW_ID } });
    if (!state) continue;

    const scheduledAt = Math.max(now, state.nextRequestAt.getTime());
    const delay = scheduledAt - now;
    if (delay > MAX_QUEUE_DELAY_MS) {
      return {
        allowed: false,
        reason: 'rate_limited',
        retryAfterSeconds: Math.max(1, Math.ceil(delay / 1000)),
      };
    }

    const requestCount = state.monthKey === monthKey ? state.requestCount : 0;
    if (requestCount >= AUDIUS_APP_MONTHLY_BUDGET) {
      return {
        allowed: false,
        reason: 'monthly_budget',
        retryAfterSeconds: secondsUntilNextMonth(new Date(now)),
      };
    }

    const updated = await prisma.audiusRequestBudget.updateMany({
      where: {
        id: BUDGET_ROW_ID,
        monthKey: state.monthKey,
        requestCount: state.requestCount,
        nextRequestAt: state.nextRequestAt,
      },
      data: {
        monthKey,
        requestCount: requestCount + 1,
        nextRequestAt: new Date(scheduledAt + AUDIUS_REQUEST_SPACING_MS),
      },
    });
    if (updated.count === 1) return { allowed: true, notBefore: scheduledAt };
  }

  return { allowed: false, reason: 'rate_limited', retryAfterSeconds: 1 };
}

export const reserveAudiusRequestSlot = reserveRequestSlot;

function secondsUntilNextMonth(now: Date) {
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return Math.max(1, Math.ceil((nextMonth.getTime() - now.getTime()) / 1000));
}

async function extendProviderCooldown(seconds: number) {
  const until = new Date(Date.now() + seconds * 1000);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = await prisma.audiusRequestBudget.findUnique({ where: { id: BUDGET_ROW_ID } });
    if (!state || state.nextRequestAt >= until) return;
    const updated = await prisma.audiusRequestBudget.updateMany({
      where: {
        id: BUDGET_ROW_ID,
        monthKey: state.monthKey,
        requestCount: state.requestCount,
        nextRequestAt: state.nextRequestAt,
      },
      data: { nextRequestAt: until },
    });
    if (updated.count === 1) return;
  }
}

function waitUntil(timestamp: number) {
  const delay = Math.max(0, timestamp - Date.now());
  return delay > 0 ? new Promise<void>((resolve) => setTimeout(resolve, delay)) : Promise.resolve();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAudiusHost(value: unknown) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      (url.pathname !== '/' && url.pathname !== '') ||
      url.search ||
      url.hash ||
      (url.hostname !== 'audius.co' && !url.hostname.endsWith('.audius.co'))
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

async function discoverAudiusHosts(fetcher: AudiusFetch, now: number): Promise<string[]> {
  if (audiusHostsCache && audiusHostsCache.expiresAt > now) return audiusHostsCache.hosts;

  const discovered: string[] = [];
  try {
    const url = new URL(AUDIUS_HOST_DISCOVERY_URL);
    url.searchParams.set('app_name', AUDIUS_APP_NAME);
    const response = await fetcher(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) {
      const payload: unknown = await response.json();
      if (isRecord(payload) && Array.isArray(payload.data)) {
        for (const value of payload.data) {
          const host = normalizeAudiusHost(value);
          if (host) discovered.push(host);
        }
      }
    }
  } catch {
    // Gli host Audius noti restano disponibili se la ricerca del registro non riesce.
  }

  const hosts = [...new Set([...discovered, ...AUDIUS_FALLBACK_HOSTS])];
  audiusHostsCache = { hosts, expiresAt: now + AUDIUS_METADATA_CACHE_TTL_MS };
  return hosts;
}

export function clearAudiusMetadataCacheForTests() {
  metadataCache.clear();
  audiusHostsCache = null;
  preferredAudiusHost = null;
}

export function createAudiusApiClient(input: {
  apiKey: string;
  fetcher?: AudiusFetch;
  reserve?: () => Promise<RequestSlot>;
  wait?: (notBefore: number) => Promise<void>;
  defer?: (seconds: number) => Promise<void>;
  hostResolver?: HostResolver;
  now?: () => number;
}) {
  const fetcher = input.fetcher ?? fetch;
  const reserve = input.reserve ?? reserveRequestSlot;
  const wait = input.wait ?? waitUntil;
  const defer = input.defer ?? extendProviderCooldown;
  const now = input.now ?? Date.now;
  const hostResolver = input.hostResolver ?? (() => discoverAudiusHosts(fetcher, now()));
  const apiKeyHash = createHash('sha256').update(input.apiKey).digest('hex');

  async function reserveOneRequest() {
    const slot = await reserve();
    if (!slot.allowed) {
      throw new AudiusApiError(
        slot.reason === 'monthly_budget' ? 'budget_exhausted' : 'rate_limited',
        slot.reason === 'monthly_budget'
          ? 'Il budget mensile prudenziale Audius è esaurito.'
          : 'La coda di richieste Audius è temporaneamente piena.',
        slot.retryAfterSeconds,
      );
    }
    await wait(slot.notBefore);
  }

  async function candidateHosts() {
    let supplied: string[] = [];
    try {
      supplied = await hostResolver();
    } catch {
      // Continua con gli host Audius di ripiego documentati.
    }
    const validated = supplied
      .map(normalizeAudiusHost)
      .filter((host): host is string => host !== null);
    const ordered = [
      ...new Set([preferredAudiusHost, ...validated, ...AUDIUS_FALLBACK_HOSTS]),
    ].filter((host): host is string => host !== null);
    return ordered;
  }

  async function get(path: string, params: URLSearchParams, cacheMetadata = true) {
    const requestParams = new URLSearchParams(params);
    requestParams.set('app_name', AUDIUS_APP_NAME);
    requestParams.set('api_key', input.apiKey);

    const cacheParams = new URLSearchParams(params);
    cacheParams.set('app_name', AUDIUS_APP_NAME);
    cacheParams.sort();
    const cacheKey = `${apiKeyHash}:${path}?${cacheParams.toString()}`;
    const cached = cacheMetadata ? metadataCache.get(cacheKey) : undefined;
    if (cached && cached.expiresAt > now()) return cached.value;
    if (cached) metadataCache.delete(cacheKey);

    let lastError: AudiusApiError = new AudiusApiError(
      'unavailable',
      'Audius non ha risposto alla richiesta.',
    );
    let retrySeconds = 0;
    for (const host of await candidateHosts()) {
      await reserveOneRequest();
      const url = `${host}/v1/${path.replace(/^\/+/, '')}?${requestParams.toString()}`;
      try {
        const response = await fetcher(url, {
          cache: 'no-store',
          signal: AbortSignal.timeout(8_000),
        });
        if (response.status === 429) {
          retrySeconds = Math.max(
            retrySeconds,
            retryAfterSeconds(response.headers.get('retry-after')),
          );
          lastError = new AudiusApiError(
            'rate_limited',
            'Audius ha applicato un limite di richieste.',
            retrySeconds,
          );
          continue;
        }
        if (!response.ok) {
          lastError = new AudiusApiError(
            'unavailable',
            `Audius ha risposto con HTTP ${response.status}.`,
          );
          continue;
        }

        const value: unknown = await response.json();
        preferredAudiusHost = host;
        if (cacheMetadata) {
          metadataCache.set(cacheKey, { value, expiresAt: now() + AUDIUS_METADATA_CACHE_TTL_MS });
          if (metadataCache.size > MAX_METADATA_CACHE_ENTRIES) {
            const oldest = metadataCache.keys().next().value;
            if (oldest) metadataCache.delete(oldest);
          }
        }
        return value;
      } catch (error) {
        if (error instanceof AudiusApiError) lastError = error;
        else
          lastError = new AudiusApiError('unavailable', 'Audius non ha risposto alla richiesta.');
      }
    }

    if (retrySeconds > 0) {
      try {
        await defer(retrySeconds);
      } catch {
        // Mantiene la risposta di limite Audius se il salvataggio dell'attesa fallisce.
      }
    }
    throw lastError;
  }

  return {
    async search(term: string, sourceActive: boolean) {
      const trackParams = new URLSearchParams({
        query: term,
        limit: '20',
        sort_method: 'relevant',
      });
      const artistParams = new URLSearchParams({
        query: term,
        limit: '20',
        sort_method: 'relevant',
      });
      const trackResult = await get('tracks/search', trackParams).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      );
      const stopAfterLimit =
        trackResult.status === 'rejected' &&
        trackResult.reason instanceof AudiusApiError &&
        (trackResult.reason.kind === 'rate_limited' ||
          trackResult.reason.kind === 'budget_exhausted');
      const artistResult = stopAfterLimit
        ? trackResult
        : await get('users/search', artistParams).then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason: unknown) => ({ status: 'rejected' as const, reason }),
          );
      const tracks =
        trackResult.status === 'fulfilled'
          ? normalizeAudiusTracks(trackResult.value, sourceActive)
          : [];
      const artists =
        artistResult.status === 'fulfilled' ? normalizeAudiusArtists(artistResult.value) : [];
      const failed =
        Number(trackResult.status === 'rejected') + Number(artistResult.status === 'rejected');
      const total = 2;
      const retrySeconds = [trackResult, artistResult]
        .filter((result) => result.status === 'rejected')
        .map((result) =>
          result.status === 'rejected' && result.reason instanceof AudiusApiError
            ? result.reason.retryAfterSeconds
            : null,
        )
        .filter((value): value is number => value !== null)
        .reduce((max, value) => Math.max(max, value), 0);
      const outcome =
        failed === total
          ? 'unavailable'
          : failed > 0
            ? 'partial'
            : tracks.length === 0 && artists.length === 0
              ? 'no_results'
              : 'results';
      return { tracks, artists, outcome, retryAfterSeconds: retrySeconds || undefined } as const;
    },
    async searchArtists(term: string) {
      const payload = await get(
        'users/search',
        new URLSearchParams({ query: term, limit: '20', sort_method: 'relevant' }),
      );
      return normalizeAudiusArtists(payload);
    },
    async searchPlaylists(term: string) {
      const payload = await get(
        'playlists/search',
        new URLSearchParams({ query: term, limit: '20', sort_method: 'relevant' }),
      );
      return normalizeAudiusPlaylists(payload);
    },
    async trending(sourceActive: boolean) {
      if (!sourceActive) return { tracks: [], outcome: 'inactive' as const };
      try {
        const payload = await get(
          'tracks/trending',
          new URLSearchParams({ time: 'week', limit: '20' }),
        );
        const tracks = normalizeAudiusTracks(payload, sourceActive);
        return {
          tracks,
          outcome: tracks.length > 0 ? ('results' as const) : ('no_results' as const),
        };
      } catch (error) {
        if (error instanceof AudiusApiError && error.kind === 'rate_limited') {
          return {
            tracks: [],
            outcome: 'unavailable' as const,
            retryAfterSeconds: error.retryAfterSeconds ?? undefined,
          };
        }
        return { tracks: [], outcome: 'unavailable' as const };
      }
    },
    /**
     * Popular tracks for a mood: empty query plus the `mood` and `genre` filters, which Audius
     * takes as arrays (the parameter repeated once per value).
     */
    async moodTracks(
      filters: { moods: readonly string[]; genres: readonly string[]; limit: number },
      sourceActive: boolean,
    ) {
      const params = new URLSearchParams({
        query: '',
        sort_method: 'popular',
        limit: String(filters.limit),
      });
      for (const mood of filters.moods) params.append('mood', mood);
      for (const genre of filters.genres) params.append('genre', genre);
      const payload = await get('tracks/search', params);
      return normalizeAudiusTracks(payload, sourceActive);
    },
    async searchAlbums(term: string) {
      return get(
        'playlists/search',
        new URLSearchParams({ query: term, limit: '20', sort_method: 'relevant' }),
      );
    },
    async newReleases() {
      return get('playlists/new-releases', new URLSearchParams({ limit: '20' }));
    },
    async getPlaylist(playlistId: string) {
      return get(`playlists/${encodeURIComponent(playlistId)}`, new URLSearchParams(), false);
    },
    async getPlaylistTracks(playlistId: string) {
      return get(
        `playlists/${encodeURIComponent(playlistId)}/tracks`,
        new URLSearchParams(),
        false,
      );
    },
    async getTrack(trackId: string) {
      return get(`tracks/${encodeURIComponent(trackId)}`, new URLSearchParams(), false);
    },
    async streamTrack(trackId: string, range: string | null = null) {
      const params = new URLSearchParams({ api_key: input.apiKey, app_name: AUDIUS_APP_NAME });
      const headers = new Headers({ Accept: 'audio/mpeg, audio/*;q=0.9' });
      if (range) headers.set('Range', range);
      let retrySeconds = 0;
      let lastError: AudiusApiError = new AudiusApiError(
        'unavailable',
        'Lo stream Audius non è disponibile.',
      );
      for (const host of await candidateHosts()) {
        await reserveOneRequest();
        try {
          const response = await fetcher(
            `${host}/v1/tracks/${encodeURIComponent(trackId)}/stream?${params.toString()}`,
            {
              method: 'GET',
              headers,
              cache: 'no-store',
              redirect: 'follow',
              signal: AbortSignal.timeout(30_000),
            },
          );
          if (response.status === 429) {
            retrySeconds = Math.max(
              retrySeconds,
              retryAfterSeconds(response.headers.get('retry-after')),
            );
            lastError = new AudiusApiError(
              'rate_limited',
              'Audius ha limitato le richieste.',
              retrySeconds,
            );
            continue;
          }
          if (!response.ok) {
            lastError = new AudiusApiError(
              'unavailable',
              `Audius ha risposto con HTTP ${response.status}.`,
            );
            continue;
          }
          preferredAudiusHost = host;
          return response;
        } catch {
          lastError = new AudiusApiError('unavailable', 'Lo stream Audius non è disponibile.');
        }
      }

      if (retrySeconds > 0) {
        try {
          await defer(retrySeconds);
        } catch {
          // Keep Audius's throttle verdict if the cooldown cannot be stored.
        }
      }
      throw lastError;
    },
  };
}

export function readAudiusApiKey() {
  return process.env.AUDIUS_API_KEY?.trim() ?? '';
}
