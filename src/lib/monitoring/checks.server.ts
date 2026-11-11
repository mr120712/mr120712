// @polsia:user-owned — controlli interni del monitoraggio automatico. Ogni controllo non lancia
// mai eccezioni, si ferma dopo 8 secondi e restituisce un esito breve in italiano, senza segreti,
// token, risposte grezze dei servizi esterni o stack trace. Le dipendenze (fetch, database,
// variabili d'ambiente, orologio, servizi musicali) sono iniettabili: i test non usano la rete.
import 'server-only';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { anthropicApiKey } from '@/lib/business/ai-music-search.server';
import {
  MONITOR_CHECK_IDS,
  type MonitorCheckId,
  type MonitorCheckResult,
  type MonitorCheckStatus,
} from '@/lib/contracts/monitoring';
import { prisma } from '@/lib/db';
import { getAudiusTrending } from '@/lib/music/audius-source.server';
import { listJamendoTracks } from '@/lib/music/jamendo.server';
import { readYouTubeApiKey } from '@/lib/music/music-api.server';
import { searchPodcasts } from '@/lib/music/podcasts.server';
import { listStations } from '@/lib/music/radio-browser.server';
import {
  withYouTubeSearchBudget,
  YOUTUBE_BUDGET_EXHAUSTED,
} from '@/lib/music/youtube-budget.server';
import { searchYouTubeMusic, type YouTubeSearchResult } from '@/lib/music/youtube-search.server';
import { storedYouTubeSearch } from '@/lib/music/youtube-search-store.server';

export const CHECK_TIMEOUT_MS = 8_000;
export const SLOW_DATABASE_MS = 1_500;
export const CLEANUP_MAX_AGE_MS = 50 * 60 * 60 * 1000;
export const MONITOR_HEARTBEAT = 'monitor';
export const CLEANUP_HEARTBEAT = 'cleanup';
/**
 * Same query and size as a listener's search: usually served from the shared 24 h cache. A miss
 * goes through the app-wide YouTube search budget, exactly like the search route.
 */
export const YOUTUBE_SEARCH_PROBE = { query: 'vasco rossi', maxResults: 10 } as const;

const DETAIL_MAX = 300;
const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const YOUTUBE_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1';
const STRIPE_BALANCE_URL = 'https://api.stripe.com/v1/balance';

type Env = Record<string, string | undefined>;
type Fetcher = typeof fetch;
type CatalogOutcome = { outcome: string };

export type MonitorDb = Pick<PrismaClient, '$queryRaw' | '$transaction' | 'monitorHeartbeat'>;

export type CheckDeps = {
  fetch: Fetcher;
  db: MonitorDb;
  env: Env;
  /** Wall clock (heartbeats, ages). */
  now: () => Date;
  /** Monotonic milliseconds (durations). */
  clock: () => number;
  timeoutMs: number;
  youtubeApiKey: () => string;
  youtubeSearch: (fetcher: Fetcher) => Promise<YouTubeSearchResult>;
  audiusTrending: () => Promise<CatalogOutcome & { tracks: readonly unknown[] }>;
  radioStations: (fetcher: Fetcher) => Promise<CatalogOutcome & { stations: readonly unknown[] }>;
  podcastSearch: (fetcher: Fetcher) => Promise<CatalogOutcome & { podcasts: readonly unknown[] }>;
  jamendoTracks: (fetcher: Fetcher) => Promise<CatalogOutcome & { tracks: readonly unknown[] }>;
};

type Outcome = { status: MonitorCheckStatus; detail: string };
type Check = (deps: CheckDeps) => Promise<Outcome>;

const ok = (detail: string): Outcome => ({ status: 'ok', detail });
const warn = (detail: string): Outcome => ({ status: 'warn', detail });
const fail = (detail: string): Outcome => ({ status: 'fail', detail });

export function defaultCheckDeps(): CheckDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    db: prisma,
    env: process.env,
    now: () => new Date(),
    clock: () => performance.now(),
    timeoutMs: CHECK_TIMEOUT_MS,
    youtubeApiKey: readYouTubeApiKey,
    youtubeSearch: (fetcher) =>
      storedYouTubeSearch(
        YOUTUBE_SEARCH_PROBE.query,
        YOUTUBE_SEARCH_PROBE.maxResults,
        withYouTubeSearchBudget(
          () =>
            searchYouTubeMusic(
              YOUTUBE_SEARCH_PROBE.query,
              readYouTubeApiKey(),
              fetcher,
              YOUTUBE_SEARCH_PROBE.maxResults,
            ),
          null,
        ),
      ),
    audiusTrending: getAudiusTrending,
    radioStations: (fetcher) => listStations({ country: 'IT', limit: 5 }, fetcher),
    podcastSearch: (fetcher) => searchPodcasts('musica', fetcher),
    jamendoTracks: (fetcher) => listJamendoTracks({}, fetcher),
  };
}

class CheckTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CheckTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const SECRET_NAME = /SECRET|KEY|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|DATABASE_URL|CLIENT_ID|DSN/i;

/**
 * Last line of defence: details are fixed strings, but any configured secret value that slipped
 * in is masked, whitespace is collapsed and the text is capped at 300 characters.
 */
export function safeDetail(detail: string, env: Env): string {
  let text = detail.replace(/\s+/g, ' ').trim();
  for (const [name, value] of Object.entries(env)) {
    const secret = value?.trim();
    if (!secret || secret.length < 8 || !SECRET_NAME.test(name)) continue;
    text = text.split(secret).join('[nascosto]');
  }
  return text.slice(0, DETAIL_MAX) || 'Nessun dettaglio';
}

/** Prisma error codes (P1001, P2024…) are safe to show; messages may carry hosts or queries. */
function prismaCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return '';
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' && /^P\d{4}$/.test(code) ? ` (codice ${code})` : '';
}

function parseUrl(value: string | undefined, base?: string): URL | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value.trim(), base);
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function secureUrl(url: URL) {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
}

function present(env: Env, name: string) {
  return Boolean(env[name]?.trim());
}

/** GET with the hard timeout; the body is never read into a detail. */
async function request(
  deps: CheckDeps,
  url: string,
  init: RequestInit = {},
): Promise<Response | null> {
  try {
    return await deps.fetch(url, {
      method: 'GET',
      cache: 'no-store',
      ...init,
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
  } catch {
    return null;
  }
}

async function discard(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}

function formatRome(date: Date) {
  return `${new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)} (ora italiana)`;
}

const checkDatabase: Check = async (deps) => {
  const started = deps.clock();
  try {
    await deps.db.$queryRaw`SELECT 1`;
  } catch (error) {
    return fail(`Il database non risponde${prismaCode(error)}`);
  }
  try {
    const at = deps.now();
    await deps.db.monitorHeartbeat.upsert({
      where: { name: MONITOR_HEARTBEAT },
      create: { name: MONITOR_HEARTBEAT, at, detail: null },
      update: { at, detail: null },
    });
  } catch (error) {
    return fail(`Il database risponde ma non accetta scritture${prismaCode(error)}`);
  }
  const ms = Math.max(0, Math.round(deps.clock() - started));
  if (ms > SLOW_DATABASE_MS) {
    return warn(`Il database risponde lentamente: ${ms} ms per una lettura e una scrittura`);
  }
  return ok(`Lettura e scrittura riuscite in ${ms} ms`);
};

/** Thrown on purpose inside the probe transaction so that it always rolls back. */
class SignupProbeRollback extends Error {}

const checkSignupWrite: Check = async (deps) => {
  const sentinel = new SignupProbeRollback('monitor-signup-probe');
  const id = `monitor-${randomUUID()}`;
  try {
    await deps.db.$transaction(
      async (transaction) => {
        const at = deps.now();
        await transaction.user.create({
          data: {
            id,
            name: 'Controllo automatico',
            email: `${id}@monitor.invalid`,
            emailVerified: false,
            createdAt: at,
            updatedAt: at,
          },
          select: { id: true },
        });
        throw sentinel;
      },
      { maxWait: 4_000, timeout: 6_000 },
    );
  } catch (error) {
    if (error === sentinel) {
      return ok('Un account di prova è stato salvato e subito annullato');
    }
    return fail(`Il database non accetta nuovi account${prismaCode(error)}`);
  }
  return fail('La prova di registrazione non è stata annullata come previsto');
};

const checkAuthConfig: Check = async ({ env }) => {
  const problems: string[] = [];
  if ((env.BETTER_AUTH_SECRET?.trim().length ?? 0) < 32) {
    problems.push('BETTER_AUTH_SECRET (mancante o sotto i 32 caratteri)');
  }
  const authUrl = parseUrl(env.BETTER_AUTH_URL);
  const appUrl = parseUrl(env.NEXT_PUBLIC_APP_URL);
  const authUrlValid = authUrl !== null && secureUrl(authUrl);
  if (!authUrlValid) problems.push('BETTER_AUTH_URL (mancante o non https)');
  if (!appUrl) problems.push('NEXT_PUBLIC_APP_URL (mancante o non valido)');
  if (authUrlValid && appUrl && authUrl.origin !== appUrl.origin) {
    problems.push('BETTER_AUTH_URL e NEXT_PUBLIC_APP_URL (indirizzi diversi)');
  }
  for (const name of ['NEXT_PUBLIC_GOOGLE_SIGNIN_CLIENT_ID', 'GOOGLE_SIGNIN_CLIENT_SECRET']) {
    if (!present(env, name)) problems.push(`${name} (mancante)`);
  }
  if (problems.length > 0) return fail(`Da correggere: ${problems.join('; ')}`);
  return ok('Segreto, indirizzo del sito e credenziali Google impostati');
};

function googleAuthorizeUrl(clientId: string, base: URL) {
  const redirectUri = `${base.origin}/api/auth/oauth2/callback/google`;
  return (
    `${GOOGLE_AUTHORIZE_URL}?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    '&response_type=code&scope=openid%20email%20profile'
  );
}

const checkGoogleSignin: Check = async (deps) => {
  const clientId = deps.env.NEXT_PUBLIC_GOOGLE_SIGNIN_CLIENT_ID?.trim();
  const base = parseUrl(deps.env.BETTER_AUTH_URL);
  if (!clientId || !base) {
    return fail(
      'Accesso con Google non configurato (NEXT_PUBLIC_GOOGLE_SIGNIN_CLIENT_ID o BETTER_AUTH_URL)',
    );
  }
  const response = await request(deps, googleAuthorizeUrl(clientId, base), {
    redirect: 'manual',
    headers: { Accept: 'text/html' },
  });
  if (!response) return fail('Google non raggiungibile');
  await discard(response);
  const location = response.headers.get('location');
  const target =
    response.status >= 300 && response.status < 400
      ? parseUrl(location ?? '', 'https://accounts.google.com')
      : null;
  const googlePage =
    target !== null &&
    (target.hostname === 'accounts.google.com' || target.hostname.endsWith('.google.com'));
  if (googlePage && !target.pathname.startsWith('/signin/oauth/error')) {
    return ok('Google accetta la richiesta e mostra la pagina di accesso');
  }
  return fail(
    `Google rifiuta la richiesta (HTTP ${response.status}): controlla client ID e indirizzo di ritorno`,
  );
};

const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded']);
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
const KEY_REASONS = new Set(['keyInvalid', 'keyExpired', 'API_KEY_INVALID', 'API_KEY_EXPIRED']);

/** Reasons from a Google API error body (`error.errors[].reason`, `error.details[].reason`). */
function googleErrorReasons(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return [];
  const lists = [(error as { errors?: unknown }).errors, (error as { details?: unknown }).details];
  return lists.flatMap((list) =>
    Array.isArray(list)
      ? list.flatMap((item) =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as { reason?: unknown }).reason === 'string'
            ? [(item as { reason: string }).reason]
            : [],
        )
      : [],
  );
}

const checkYouTubeQuota: Check = async (deps) => {
  const key = deps.youtubeApiKey().trim();
  if (!key) return fail('Chiave YouTube non configurata (YOUTUBE_DATA_API_KEY)');
  const url = new URL(YOUTUBE_VIDEOS_URL);
  url.searchParams.set('part', 'id');
  url.searchParams.set('chart', 'mostPopular');
  url.searchParams.set('regionCode', 'IT');
  url.searchParams.set('videoCategoryId', '10');
  url.searchParams.set('maxResults', '1');
  url.searchParams.set('key', key);
  const response = await request(deps, url.toString(), {
    headers: { Accept: 'application/json' },
  });
  if (!response) return fail('YouTube non raggiungibile');
  if (response.ok) {
    await discard(response);
    return ok('Chiave valida, quota disponibile');
  }
  const reasons = googleErrorReasons(await response.json().catch(() => null));
  if (reasons.some((reason) => QUOTA_REASONS.has(reason))) {
    return fail('Quota esaurita: si azzera alle 9:00 ora italiana');
  }
  if (reasons.some((reason) => RATE_REASONS.has(reason))) {
    return fail('YouTube limita temporaneamente le richieste');
  }
  if (
    (response.status === 400 || response.status === 403) &&
    reasons.some((reason) => KEY_REASONS.has(reason))
  ) {
    return fail('Chiave non valida');
  }
  if (response.status === 403) {
    return fail('La chiave non può usare YouTube Data API (HTTP 403)');
  }
  return fail(`YouTube ha risposto con un errore (HTTP ${response.status})`);
};

const checkYouTubeSearch: Check = async (deps) => {
  const result = await deps.youtubeSearch(deps.fetch);
  if (result.outcome === 'results' && result.videos.length > 0) {
    return ok(`La ricerca di prova trova ${result.videos.length} video`);
  }
  if (result.outcome === 'no_results') return fail('La ricerca di prova non trova video');
  if (result === YOUTUBE_BUDGET_EXHAUSTED) {
    return fail('Budget giornaliero delle ricerche YouTube esaurito e nessun risultato salvato');
  }
  switch (result.unavailableReason) {
    case 'not_configured':
      return fail('Chiave YouTube non configurata (YOUTUBE_DATA_API_KEY)');
    case 'quota_exceeded':
      return fail('Quota esaurita e nessun risultato salvato: si azzera alle 9:00 ora italiana');
    default:
      return fail('YouTube non risponde correttamente alla ricerca');
  }
};

const checkAudius: Check = async (deps) => {
  const result = await deps.audiusTrending();
  if (result.outcome === 'inactive') return warn('Non configurato (AUDIUS_API_KEY)');
  if (result.tracks.length > 0) return ok(`${result.tracks.length} brani di tendenza`);
  if (result.outcome === 'unavailable') return fail('Audius non risponde o limita le richieste');
  return fail('Audius non restituisce brani di tendenza');
};

const checkRadio: Check = async (deps) => {
  const result = await deps.radioStations(deps.fetch);
  if (result.stations.length > 0) return ok(`${result.stations.length} stazioni italiane trovate`);
  if (result.outcome === 'unavailable') return fail('Radio Browser non risponde');
  return fail('Radio Browser non restituisce stazioni');
};

const checkPodcasts: Check = async (deps) => {
  const result = await deps.podcastSearch(deps.fetch);
  if (result.podcasts.length > 0) return ok(`${result.podcasts.length} programmi trovati`);
  if (result.outcome === 'unavailable') return fail('La ricerca podcast non risponde');
  return fail('La ricerca podcast non restituisce programmi');
};

const checkJamendo: Check = async (deps) => {
  if (!present(deps.env, 'JAMENDO_CLIENT_ID')) return warn('Non configurato');
  const result = await deps.jamendoTracks(deps.fetch);
  if (result.outcome === 'not_configured') return warn('Non configurato');
  if (result.tracks.length > 0) return ok(`${result.tracks.length} brani disponibili`);
  if (result.outcome === 'unavailable') return fail('Jamendo non risponde');
  return fail('Jamendo non restituisce brani');
};

const checkEmail: Check = async ({ env }) => {
  if (present(env, 'RESEND_API_KEY') && present(env, 'EMAIL_FROM')) {
    return ok('Invio email configurato');
  }
  return warn('Email non configurate: le email di verifica non partono');
};

const checkAnthropic: Check = async (deps) => {
  const key = anthropicApiKey(deps.env);
  if (!key) return warn('Non configurata (ANTHROPIC_API_KEY): la ricerca AI è spenta');
  if (!key.startsWith('sk-ant-')) return fail('La chiave non ha il formato giusto');
  const response = await request(deps, ANTHROPIC_MODELS_URL, {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', Accept: 'application/json' },
  });
  if (!response) return fail('Anthropic non raggiungibile');
  await discard(response);
  if (response.status === 200) return ok('Chiave valida');
  if (response.status === 401 || response.status === 403) {
    return fail('Chiave non valida o revocata');
  }
  return fail(`Anthropic ha risposto con un errore (HTTP ${response.status})`);
};

const checkStripe: Check = async (deps) => {
  const key = deps.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return warn('Non configurata (STRIPE_SECRET_KEY)');
  const response = await request(deps, STRIPE_BALANCE_URL, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (!response) return fail('Stripe non raggiungibile');
  await discard(response);
  if (response.status === 200) return ok('Chiave valida');
  if (response.status === 401) return fail('Chiave non valida');
  if (response.status === 403) return ok('Chiave valida (permessi limitati)');
  return fail(`Stripe ha risposto con un errore (HTTP ${response.status})`);
};

const checkCronCleanup: Check = async (deps) => {
  let beat: { at: Date } | null;
  try {
    beat = await deps.db.monitorHeartbeat.findUnique({
      where: { name: CLEANUP_HEARTBEAT },
      select: { at: true },
    });
  } catch (error) {
    return fail(`Impossibile leggere l’ultima pulizia${prismaCode(error)}`);
  }
  if (!beat) return warn('Mai eseguita finora');
  const when = formatRome(beat.at);
  if (deps.now().getTime() - beat.at.getTime() > CLEANUP_MAX_AGE_MS) {
    return fail(`Ultima esecuzione: ${when}, più di 50 ore fa`);
  }
  return ok(`Ultima esecuzione: ${when}`);
};

export const MONITOR_CHECK_FUNCTIONS: Record<MonitorCheckId, Check> = {
  database: checkDatabase,
  signup_write: checkSignupWrite,
  auth_config: checkAuthConfig,
  google_signin: checkGoogleSignin,
  youtube_quota: checkYouTubeQuota,
  youtube_search: checkYouTubeSearch,
  audius: checkAudius,
  radio: checkRadio,
  podcasts: checkPodcasts,
  jamendo: checkJamendo,
  email: checkEmail,
  anthropic: checkAnthropic,
  stripe: checkStripe,
  cron_cleanup: checkCronCleanup,
};

/** Runs one check; never throws, never takes longer than `timeoutMs` (8 s). */
export async function runCheck(
  id: MonitorCheckId,
  overrides: Partial<CheckDeps> = {},
): Promise<MonitorCheckResult> {
  const deps = { ...defaultCheckDeps(), ...overrides };
  const started = deps.clock();
  let outcome: Outcome;
  try {
    outcome = await withTimeout(
      Promise.resolve().then(() => MONITOR_CHECK_FUNCTIONS[id](deps)),
      deps.timeoutMs,
    );
  } catch (error) {
    outcome =
      error instanceof CheckTimeout
        ? fail(`Nessuna risposta entro ${Math.round(deps.timeoutMs / 1000)} secondi`)
        : fail('Controllo non riuscito per un errore imprevisto');
  }
  return {
    id,
    status: outcome.status,
    detail: safeDetail(outcome.detail, deps.env),
    ms: Math.max(0, Math.round(deps.clock() - started)),
  };
}

/** Every check in parallel; results in MONITOR_CHECK_IDS order. */
export function runChecks(overrides: Partial<CheckDeps> = {}): Promise<MonitorCheckResult[]> {
  return Promise.all(MONITOR_CHECK_IDS.map((id) => runCheck(id, overrides)));
}
