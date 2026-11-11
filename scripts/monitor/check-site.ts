// @polsia:user-owned — controllo esterno di Solco, eseguito ogni ora da GitHub Actions
// (.github/workflows/monitor.yml). Un solo file autonomo, avviato con
// `node scripts/monitor/check-site.ts` su Node 24 (type stripping integrato): solo TypeScript
// cancellabile (niente enum, namespace, parameter properties), nessun import relativo, nessuna
// dipendenza npm (solo il fetch globale). Le funzioni pure sono esportate per i test unitari;
// main() parte solo quando il file viene eseguito direttamente.
//
// Esito: exit 1 se in questo giro parte almeno un avviso (GitHub manda un'email), 0 altrimenti,
// 2 se lo script stesso si interrompe. Lo stato tra un giro e l'altro vive in STATE_FILE.
import { realpathSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_BASE_URL = 'https://solcomusic.vercel.app';
export const DEFAULT_STATE_FILE = '.monitor-state.json';
export const USER_AGENT = 'SolcoMonitor/1.0 (+https://github.com/mr120712/mr120712)';
export const REQUEST_TIMEOUT_MS = 15_000;
/**
 * /api/status may start a fresh internal run (maxDuration 30 s on Vercel): wait a little longer
 * than that, so a slow run is not abandoned and retried while it is still being stored.
 */
export const STATUS_TIMEOUT_MS = 35_000;
export const RETRY_DELAY_MS = 5_000;
/** Oltre questa soglia la home è "lenta": solo un avviso, mai un'email. */
export const SLOW_HOME_MS = 4_000;
export const REALERT_MS = 24 * 60 * 60 * 1000;
/** GitHub avvia i giri programmati anche con mezz'ora di ritardo: il promemoria resta quotidiano. */
export const REALERT_SLACK_MS = 30 * 60 * 1000;
/** A check that breaks again within 6 hours of recovering is the same problem: no new email. */
export const FLAP_WINDOW_MS = 6 * 60 * 60 * 1000;
/** When an email goes out anyway, it also carries every reminder at least 12 hours old. */
export const BATCH_REMINDER_MS = 12 * 60 * 60 * 1000;
/** Richieste contemporanee verso il sito: poche, per non pesare su Vercel. */
const CONCURRENCY = 4;
const MAX_DETAIL = 200;

// ---------- Tipi ----------

export type CheckStatus = 'ok' | 'warn' | 'fail';

export type CheckResult = {
  id: string;
  label: string;
  /** Un controllo critico guasto avvisa al primo giro; gli altri dopo due giri di fila. */
  critical: boolean;
  status: CheckStatus;
  detail: string;
  /** Durata dell'ultimo tentativo; null per le voci che riportano i controlli interni. */
  ms: number | null;
};

export type CheckOutcome = { status: CheckStatus; detail: string; critical?: boolean };

export type MonitorDeps = {
  baseUrl: string;
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  /** Millisecondi monotoni, per misurare le durate. */
  clock: () => number;
  timeoutMs: number;
  retryDelayMs: number;
};

export type CheckState = { failingSince: string; consecutive: number; lastAlertAt: string | null };
/** An alerted check that recovered: if it breaks again soon it keeps its alert clock. */
export type RecentAlert = { lastAlertAt: string; recoveredAt: string };
export type MonitorState = {
  version: 1;
  checks: Record<string, CheckState>;
  /** Only present when not empty. Entries expire FLAP_WINDOW_MS after the recovery. */
  recent?: Record<string, RecentAlert>;
};

export type AlertItem = {
  id: string;
  label: string;
  critical: boolean;
  detail: string;
  failingSince: string;
  consecutive: number;
  /** new = primo avviso; reminder = ancora guasto 24 ore dopo l'ultimo avviso. */
  kind: 'new' | 'reminder';
};

export type OngoingItem = Omit<AlertItem, 'kind'> & {
  /** false: primo errore di un controllo non critico, avviso solo se si ripete. */
  alerted: boolean;
};

export type RecoveredItem = {
  id: string;
  label: string;
  failingSince: string;
  wasAlerted: boolean;
};

export type AlertDecision = {
  state: MonitorState;
  alerts: AlertItem[];
  ongoing: OngoingItem[];
  recovered: RecoveredItem[];
};

// ---------- Cosa si controlla ----------

export type PublicPage = { path: string; label: string; critical: boolean };

/** Pagine pubbliche (src/lib/nav.ts senza requiresAuth, più accesso e un genere dal catalogo). */
export const PUBLIC_PAGES: readonly PublicPage[] = [
  { path: '/', label: 'Home', critical: true },
  { path: '/search', label: 'Cerca', critical: false },
  { path: '/generi', label: 'Generi', critical: false },
  { path: '/generi/techno', label: 'Genere Techno', critical: false },
  { path: '/radio', label: 'Radio', critical: false },
  { path: '/podcasts', label: 'Podcast', critical: false },
  { path: '/library', label: 'Libreria', critical: false },
  { path: '/community', label: 'Community', critical: false },
  { path: '/piani', label: 'Piani', critical: false },
  { path: '/premi', label: 'Invita amici', critical: false },
  { path: '/app', label: 'Installa l’app', critical: false },
  { path: '/flashcards', label: 'Flashcard', critical: false },
  { path: '/apple-music', label: 'Apple Music', critical: false },
  { path: '/privacy', label: 'Privacy', critical: false },
  { path: '/terms', label: 'Termini', critical: false },
  { path: '/login', label: 'Accedi', critical: false },
  { path: '/signup', label: 'Registrati', critical: false },
];

/**
 * Copia locale di src/lib/monitoring/catalog.ts (questo script non può importarlo): un test
 * unitario verifica che copra esattamente MONITOR_CHECK_IDS con le stesse etichette.
 */
export const INTERNAL_CHECKS: Record<string, { label: string; critical: boolean }> = {
  database: { label: 'Database', critical: true },
  signup_write: { label: 'Registrazione', critical: true },
  auth_config: { label: 'Configurazione accesso', critical: true },
  google_signin: { label: 'Accesso con Google', critical: true },
  youtube_quota: { label: 'Quota YouTube', critical: false },
  youtube_search: { label: 'Ricerca YouTube', critical: false },
  audius: { label: 'Audius', critical: false },
  radio: { label: 'Radio', critical: false },
  podcasts: { label: 'Podcast', critical: false },
  jamendo: { label: 'Jamendo', critical: false },
  email: { label: 'Email', critical: false },
  anthropic: { label: 'Ricerca AI', critical: false },
  stripe: { label: 'Pagamenti Stripe', critical: false },
  cron_cleanup: { label: 'Pulizia giornaliera', critical: false },
};

const CHECK_LABELS: Record<string, string> = {
  site_health: 'Sito raggiungibile (/health)',
  security_headers: 'Intestazioni di sicurezza',
  response_time: 'Velocità della home',
  seo_files: 'robots.txt e sitemap.xml',
  google_signin: 'Accesso con Google',
  signup_route: 'Registrazione (modulo)',
  catalog_radio: 'Catalogo radio',
  catalog_podcasts: 'Catalogo podcast',
  catalog_audius: 'Catalogo Audius',
  internal_status: 'Controlli interni (/api/status)',
};

/** Stesse richieste che fa l'app (riga radio della home, podcast in evidenza, tendenze). */
export const CATALOG_PATHS = {
  radio: '/api/music/radio?limit=16&country=IT',
  podcasts: '/api/music/podcasts',
  audius: '/api/music/trending',
} as const;

const INTERNAL_PREFIX = 'internal:';
const PAGE_PREFIX = 'page:';
const INTERNAL_ID = /^[a-z0-9_]{1,40}$/;
const STATE_ID =
  /^(?:[a-z][a-z0-9_]{0,59}|page:\/[A-Za-z0-9._~/-]{0,100}|internal:[a-z0-9_]{1,40})$/;

export function labelForId(id: string): string {
  if (id.startsWith(PAGE_PREFIX)) {
    const path = id.slice(PAGE_PREFIX.length);
    const page = PUBLIC_PAGES.find((candidate) => candidate.path === path);
    return `Pagina ${page?.label ?? path} (${path})`;
  }
  if (id.startsWith(INTERNAL_PREFIX)) {
    const key = id.slice(INTERNAL_PREFIX.length);
    return `${INTERNAL_CHECKS[key]?.label ?? key} (controllo interno)`;
  }
  return CHECK_LABELS[id] ?? id;
}

// ---------- Utilità ----------

function ok(detail: string): CheckOutcome {
  return { status: 'ok', detail };
}
function warn(detail: string): CheckOutcome {
  return { status: 'warn', detail };
}
function fail(detail: string, critical?: boolean): CheckOutcome {
  return critical === undefined ? { status: 'fail', detail } : { status: 'fail', detail, critical };
}

export function clip(text: string, max = MAX_DETAIL): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

/** Messaggio breve e sicuro per un errore di rete: mai corpi di risposta o messaggi esterni. */
export function describeError(error: unknown, timeoutMs: number): string {
  const name = isRecord(error) ? error.name : null;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `Nessuna risposta entro ${Math.round(timeoutMs / 1000)} s`;
  }
  const cause = isRecord(error) ? error.cause : null;
  const code = isRecord(cause) && typeof cause.code === 'string' ? cause.code : null;
  return code && /^[A-Z0-9_]{2,40}$/.test(code) ? `Errore di rete (${code})` : 'Errore di rete';
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // il corpo è già chiuso
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text());
  } catch {
    return undefined;
  }
}

function fetchUrl(deps: MonitorDeps, url: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('User-Agent', USER_AGENT);
  return deps.fetch(url, {
    redirect: 'manual',
    ...init,
    headers,
    signal: AbortSignal.timeout(deps.timeoutMs),
  });
}

function request(deps: MonitorDeps, path: string, init: RequestInit = {}): Promise<Response> {
  return fetchUrl(deps, new URL(path, `${deps.baseUrl}/`), init);
}

function postJson(deps: MonitorDeps, path: string, body: unknown): Promise<Response> {
  return request(deps, path, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: deps.baseUrl,
    },
    body: JSON.stringify(body),
  });
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/**
 * Answers that are not the real page. The UAM loading screen (src/lib/security/uam-gate.ts)
 * comes back as 200 (first-visit) or 503 (attack) with `X-Solco-Gate: challenge`: the page was
 * not checked, which is neither a pass nor an outage, so only a warning. A Vercel Firewall
 * challenge or block (`x-vercel-mitigated`) may stop real visitors too, so it stays a failure,
 * with a detail that says why.
 */
export function gateOutcome(headers: Headers): CheckOutcome | null {
  if ((headers.get('x-solco-gate') ?? '').trim().toLowerCase() === 'challenge') {
    return warn('Schermata anti-bot (UAM) attiva: pagina non verificata');
  }
  const mitigated = (headers.get('x-vercel-mitigated') ?? '').trim().toLowerCase();
  if (!mitigated) return null;
  const action = /^[a-z_-]{1,20}$/.test(mitigated) ? mitigated : 'blocco';
  return fail(
    `Il firewall di Vercel ferma il monitor (x-vercel-mitigated: ${action}): pagina non verificata`,
  );
}

/** Runs one attempt, and once more after retryDelayMs when it fails. Never throws. */
export async function runCheck(
  deps: MonitorDeps,
  id: string,
  critical: boolean,
  attempt: () => Promise<CheckOutcome>,
): Promise<CheckResult> {
  let outcome: CheckOutcome = fail('Non eseguito');
  let ms = 0;
  for (let round = 0; round < 2; round += 1) {
    if (round > 0) await deps.sleep(deps.retryDelayMs);
    const started = deps.clock();
    try {
      outcome = await attempt();
    } catch (error) {
      outcome = fail(describeError(error, deps.timeoutMs));
    }
    ms = Math.max(0, Math.round(deps.clock() - started));
    if (outcome.status !== 'fail') {
      if (round > 0) outcome = { ...outcome, detail: `${outcome.detail} (al secondo tentativo)` };
      break;
    }
  }
  return {
    id,
    label: labelForId(id),
    critical: outcome.critical ?? critical,
    status: outcome.status,
    detail: clip(outcome.detail),
    ms,
  };
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      output[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return output;
}

// ---------- Controlli ----------

export async function checkSiteHealth(deps: MonitorDeps): Promise<CheckOutcome> {
  const response = await request(deps, '/health', { headers: { Accept: 'application/json' } });
  if (response.status !== 200) {
    await discard(response);
    return fail(`/health risponde HTTP ${response.status}`);
  }
  const body = await readJson(response);
  if (!isRecord(body) || body.status !== 'healthy') return fail('/health non risponde "healthy"');
  return ok('Il sito risponde');
}

export async function checkPage(deps: MonitorDeps, path: string): Promise<CheckOutcome> {
  const response = await request(deps, path, { headers: { Accept: 'text/html' } });
  const gated = gateOutcome(response.headers);
  if (gated) {
    await discard(response);
    return gated;
  }
  if (isRedirect(response.status)) {
    await discard(response);
    return fail(`Reindirizza altrove (HTTP ${response.status}${redirectTarget(response, deps)})`);
  }
  if (response.status !== 200) {
    await discard(response);
    return fail(`HTTP ${response.status}`);
  }
  const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  if (type.toLowerCase() !== 'text/html') {
    await discard(response);
    return fail(`Non è una pagina HTML (${clip(type, 40) || 'tipo mancante'})`);
  }
  const html = await response.text();
  if (html.includes('Application error')) return fail('La pagina mostra "Application error"');
  return ok('Pagina caricata');
}

function redirectTarget(response: Response, deps: MonitorDeps): string {
  const location = response.headers.get('location');
  if (!location) return '';
  try {
    const target = new URL(location, `${deps.baseUrl}/`);
    return target.origin === deps.baseUrl
      ? ` verso ${clip(target.pathname, 60)}`
      : ` verso ${clip(target.host, 60)}`;
  } catch {
    return '';
  }
}

/** HSTS, nosniff, Referrer-Policy e protezione dai frame (X-Frame-Options o frame-ancestors). */
export function evaluateSecurityHeaders(headers: Headers): CheckOutcome {
  const missing: string[] = [];
  const hsts = /max-age\s*=\s*"?(\d+)/i.exec(headers.get('strict-transport-security') ?? '');
  if (!hsts || Number(hsts[1]) <= 0) missing.push('Strict-Transport-Security');
  if ((headers.get('x-content-type-options') ?? '').trim().toLowerCase() !== 'nosniff') {
    missing.push('X-Content-Type-Options: nosniff');
  }
  if (!(headers.get('referrer-policy') ?? '').trim()) missing.push('Referrer-Policy');
  const frameOptions = (headers.get('x-frame-options') ?? '').trim().toUpperCase();
  const csp = headers.get('content-security-policy') ?? '';
  const frameAncestors = /(?:^|[;,])\s*frame-ancestors\s/i.test(csp);
  if (frameOptions !== 'DENY' && frameOptions !== 'SAMEORIGIN' && !frameAncestors) {
    missing.push('protezione dai frame (X-Frame-Options o frame-ancestors)');
  }
  return missing.length > 0
    ? fail(`Mancano: ${missing.join(', ')}`)
    : ok('HSTS, nosniff, Referrer-Policy e protezione dai frame presenti');
}

export async function checkSecurityHeaders(deps: MonitorDeps): Promise<CheckOutcome> {
  const response = await request(deps, '/', { headers: { Accept: 'text/html' } });
  await discard(response);
  const gated = gateOutcome(response.headers);
  if (gated) return gated;
  if (response.status !== 200) return fail(`La home risponde HTTP ${response.status}`);
  return evaluateSecurityHeaders(response.headers);
}

export async function checkSeoFiles(deps: MonitorDeps): Promise<CheckOutcome> {
  const problems: string[] = [];
  for (const path of ['/robots.txt', '/sitemap.xml']) {
    const response = await request(deps, path);
    await discard(response);
    if (response.status !== 200) problems.push(`${path.slice(1)} HTTP ${response.status}`);
  }
  return problems.length > 0
    ? fail(problems.join(', '))
    : ok('robots.txt e sitemap.xml raggiungibili');
}

/** Returns why the authorization URL from Solco is wrong, or null when it looks right. */
export function evaluateGoogleAuthUrl(raw: string, baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Solco restituisce un indirizzo di Google non valido';
  }
  if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com') {
    return `L’accesso porta a un sito inatteso (${clip(url.hostname, 60)})`;
  }
  if (!url.searchParams.get('client_id')) return 'Manca client_id nella richiesta a Google';
  const expected = `${baseUrl}/api/auth/oauth2/callback/google`;
  const redirectUri = url.searchParams.get('redirect_uri');
  if (redirectUri !== expected) {
    return `redirect_uri sbagliato: ${clip(redirectUri ?? 'mancante', 90)} invece di ${expected}`;
  }
  return null;
}

/** Google answers a valid client with a redirect to its sign-in page, a broken one to /signin/oauth/error. */
export function evaluateGoogleRedirect(
  status: number,
  location: string | null,
  requestUrl: string,
  baseUrl: string,
): CheckOutcome {
  if (!isRedirect(status)) return fail(`Google risponde in modo inatteso (HTTP ${status})`);
  if (!location) return fail('Google non indica la pagina di accesso');
  let target: URL;
  try {
    target = new URL(location, requestUrl);
  } catch {
    return fail('Google indica una pagina di accesso non valida');
  }
  if (
    target.hostname === 'accounts.google.com' &&
    target.pathname.startsWith('/signin/oauth/error')
  ) {
    return fail('Google rifiuta la richiesta di accesso (client Google o redirect_uri non validi)');
  }
  const error = target.origin === baseUrl ? target.searchParams.get('error') : null;
  if (error) return fail(`Google rifiuta la richiesta di accesso (${clip(error, 40)})`);
  return ok('Google mostra la sua pagina di accesso');
}

export async function checkGoogleSignIn(deps: MonitorDeps): Promise<CheckOutcome> {
  const response = await postJson(deps, '/api/auth/sign-in/oauth2', {
    providerId: 'google',
    callbackURL: '/',
  });
  if (response.status !== 200) {
    await discard(response);
    return fail(`Solco non avvia l’accesso con Google (HTTP ${response.status})`);
  }
  const body = await readJson(response);
  const raw = isRecord(body) && typeof body.url === 'string' ? body.url : null;
  if (!raw) return fail('Solco non restituisce l’indirizzo di Google');
  const problem = evaluateGoogleAuthUrl(raw, deps.baseUrl);
  if (problem) return fail(problem);
  const google = await fetchUrl(deps, raw, { headers: { Accept: 'text/html' } });
  await discard(google);
  return evaluateGoogleRedirect(google.status, google.headers.get('location'), raw, deps.baseUrl);
}

/** An empty sign-up must be refused by validation (400): never 5xx, never a real account. */
export async function checkSignupRoute(deps: MonitorDeps): Promise<CheckOutcome> {
  const response = await postJson(deps, '/api/auth/sign-up/email', {});
  await discard(response);
  if (response.status === 400) return ok('Il modulo risponde e controlla i dati (HTTP 400)');
  if (response.status === 429) return warn('Troppe richieste (HTTP 429): riprovo al prossimo giro');
  if (response.status >= 500) return fail(`Errore del server (HTTP ${response.status})`);
  return fail(`Risposta inattesa (HTTP ${response.status}, attesa 400)`);
}

async function getJson(
  deps: MonitorDeps,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const response = await request(deps, path, { headers: { Accept: 'application/json' } });
  if (response.status !== 200) {
    await discard(response);
    return { status: response.status, body: undefined };
  }
  return { status: 200, body: await readJson(response) };
}

export async function checkCatalogRadio(deps: MonitorDeps): Promise<CheckOutcome> {
  const { status, body } = await getJson(deps, CATALOG_PATHS.radio);
  if (status !== 200) return fail(`HTTP ${status}`);
  if (!isRecord(body) || !Array.isArray(body.stations)) return fail('Risposta non valida');
  const count = body.stations.length;
  if (count > 0) return ok(count === 1 ? '1 stazione' : `${count} stazioni`);
  return fail(
    body.outcome === 'unavailable' ? 'Radio Browser non risponde' : 'Nessuna stazione trovata',
  );
}

export async function checkCatalogPodcasts(deps: MonitorDeps): Promise<CheckOutcome> {
  const { status, body } = await getJson(deps, CATALOG_PATHS.podcasts);
  if (status !== 200) return fail(`HTTP ${status}`);
  if (!isRecord(body) || !Array.isArray(body.podcasts)) return fail('Risposta non valida');
  const count = body.podcasts.length;
  if (count > 0) return ok(`${count} podcast in evidenza`);
  return fail(
    body.outcome === 'unavailable' ? 'La directory podcast non risponde' : 'Nessun podcast trovato',
  );
}

export async function checkCatalogAudius(deps: MonitorDeps): Promise<CheckOutcome> {
  const { status, body } = await getJson(deps, CATALOG_PATHS.audius);
  if (status !== 200) return fail(`HTTP ${status}`);
  if (!isRecord(body) || !Array.isArray(body.tracks)) return fail('Risposta non valida');
  const tracks = body.tracks.length;
  const albums = Array.isArray(body.albums) ? body.albums.length : 0;
  if (tracks + albums > 0) {
    return ok(`${tracks === 1 ? '1 brano' : `${tracks} brani`} e ${albums} album di tendenza`);
  }
  const source = isRecord(body.sourceStatus) ? body.sourceStatus : {};
  if (source.active === false && source.unavailableReason === 'not_configured') {
    // Scelta di configurazione, non un guasto: lo stesso criterio di "Jamendo non configurato".
    return warn('Audius non è configurato sul server (manca AUDIUS_API_KEY): sezione vuota');
  }
  return fail(body.outcome === 'unavailable' ? 'Audius non risponde' : 'Nessun brano di tendenza');
}

// ---------- Controlli interni (/api/status) ----------

export type PublicStatusBody = {
  status: 'ok' | 'degraded' | 'down' | 'unknown';
  checkedAt: string | null;
  stale: boolean;
  failing: string[];
  warnings: string[];
};

const PUBLIC_STATUS_VALUES = new Set(['ok', 'degraded', 'down', 'unknown']);
const OVERALL_LABELS: Record<PublicStatusBody['status'], string> = {
  ok: 'Tutto funziona',
  degraded: 'Qualcosa non funziona',
  down: 'Solco non è utilizzabile',
  unknown: 'Nessun controllo ancora',
};

function isIdList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 50 &&
    value.every((item) => typeof item === 'string' && INTERNAL_ID.test(item))
  );
}

/** Hand-written check of PublicMonitorStatusSchema (no zod here): null when the body is unusable. */
export function parsePublicStatus(body: unknown): PublicStatusBody | null {
  if (!isRecord(body)) return null;
  const { status, checkedAt, stale, failing, warnings } = body;
  if (typeof status !== 'string' || !PUBLIC_STATUS_VALUES.has(status)) return null;
  if (checkedAt !== null && !isIsoDate(checkedAt)) return null;
  if (typeof stale !== 'boolean' || !isIdList(failing) || !isIdList(warnings)) return null;
  return {
    status: status as PublicStatusBody['status'],
    checkedAt,
    stale,
    failing: [...new Set(failing)],
    warnings: [...new Set(warnings)],
  };
}

/** Outcome of the internal_status row itself (the per-check rows come from internalItemResults). */
export function summarizeInternal(value: PublicStatusBody): CheckOutcome {
  if (value.status === 'unknown') return fail('Nessun controllo interno disponibile');
  const when = value.checkedAt ? ` (${formatRome(new Date(value.checkedAt))})` : '';
  if (
    value.status === 'down' &&
    !value.failing.some((id) => INTERNAL_CHECKS[id]?.critical ?? true)
  ) {
    return fail(`Il server segnala: ${OVERALL_LABELS.down}${when}`, true);
  }
  if (value.stale) return warn(`L’ultimo controllo interno è di più di 2 ore fa${when}`);
  const problems = value.failing.length > 0 ? `: ${value.failing.length} da sistemare` : '';
  return ok(`${OVERALL_LABELS[value.status]}${problems}${when}`);
}

/** One row per failing internal check (internal:<id>, it alerts) and per warning (never alerts). */
export function internalItemResults(value: PublicStatusBody): CheckResult[] {
  const rows: CheckResult[] = value.failing.map((id) => ({
    id: `${INTERNAL_PREFIX}${id}`,
    label: labelForId(`${INTERNAL_PREFIX}${id}`),
    // Un id che questo script non conosce è critico se il server dice "down".
    critical: INTERNAL_CHECKS[id]?.critical ?? value.status === 'down',
    status: 'fail',
    detail: 'Il controllo interno non passa: dettagli in Admin › Monitoraggio',
    ms: null,
  }));
  for (const id of value.warnings) {
    if (value.failing.includes(id)) continue;
    rows.push({
      id: `${INTERNAL_PREFIX}${id}`,
      label: labelForId(`${INTERNAL_PREFIX}${id}`),
      critical: false,
      status: 'warn',
      detail: 'Avviso del controllo interno (nessuna email): dettagli in Admin › Monitoraggio',
      ms: null,
    });
  }
  return rows;
}

export async function checkInternalStatus(deps: MonitorDeps): Promise<CheckResult[]> {
  const slow: MonitorDeps = { ...deps, timeoutMs: Math.max(deps.timeoutMs, STATUS_TIMEOUT_MS) };
  const parsed: { value: PublicStatusBody | null } = { value: null };
  const result = await runCheck(slow, 'internal_status', false, async () => {
    parsed.value = null;
    const response = await request(slow, '/api/status', {
      headers: { Accept: 'application/json' },
    });
    if (response.status !== 200) {
      await discard(response);
      if (response.status === 404) return fail('/api/status non esiste (HTTP 404)');
      if (response.status === 503)
        return fail('Il server non riesce a leggere lo stato (HTTP 503)');
      return fail(`HTTP ${response.status}`);
    }
    const value = parsePublicStatus(await readJson(response));
    if (!value) return fail('Risposta di /api/status non valida');
    parsed.value = value;
    return summarizeInternal(value);
  });
  return parsed.value ? [result, ...internalItemResults(parsed.value)] : [result];
}

/** Warn-only row derived from the measured home page load (only a verified home counts). */
export function responseTimeResult(home: CheckResult | undefined): CheckResult {
  const base = { id: 'response_time', label: labelForId('response_time'), critical: false };
  if (!home || home.status !== 'ok' || home.ms === null) {
    const why = home?.status === 'warn' ? 'la home non è stata verificata' : 'la home non risponde';
    return { ...base, status: 'warn', detail: `Non misurata: ${why}`, ms: null };
  }
  const seconds = (home.ms / 1000).toFixed(1).replace('.', ',');
  return home.ms > SLOW_HOME_MS
    ? { ...base, status: 'warn', detail: `Home lenta: ${seconds} s (soglia 4 s)`, ms: home.ms }
    : { ...base, status: 'ok', detail: `Home caricata in ${seconds} s`, ms: home.ms };
}

/** Runs every check (at most CONCURRENCY requests at a time) and returns rows in display order. */
export async function runAllChecks(deps: MonitorDeps): Promise<CheckResult[]> {
  const single =
    (id: string, critical: boolean, check: (deps: MonitorDeps) => Promise<CheckOutcome>) =>
    async () => [await runCheck(deps, id, critical, () => check(deps))];
  const tasks: Array<() => Promise<CheckResult[]>> = [
    single('site_health', true, checkSiteHealth),
    ...PUBLIC_PAGES.map((page) =>
      single(`${PAGE_PREFIX}${page.path}`, page.critical, (d) => checkPage(d, page.path)),
    ),
    single('security_headers', false, checkSecurityHeaders),
    single('seo_files', false, checkSeoFiles),
    single('google_signin', true, checkGoogleSignIn),
    single('signup_route', true, checkSignupRoute),
    single('catalog_radio', false, checkCatalogRadio),
    single('catalog_podcasts', false, checkCatalogPodcasts),
    single('catalog_audius', false, checkCatalogAudius),
    () => checkInternalStatus(deps),
  ];
  const results = (await mapLimit(tasks, CONCURRENCY, (task) => task())).flat();
  const home = results.find((result) => result.id === `${PAGE_PREFIX}/`);
  const after = results.findIndex((result) => result.id === 'security_headers');
  results.splice(after + 1, 0, responseTimeResult(home));
  return results;
}

// ---------- Stato e avvisi ----------

export function emptyState(): MonitorState {
  return { version: 1, checks: {} };
}

/** Accepts anything read from STATE_FILE: an older, newer or corrupt file restarts from empty. */
export function normalizeState(raw: unknown): MonitorState {
  const state = emptyState();
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.checks)) return state;
  for (const [id, entry] of Object.entries(raw.checks)) {
    if (!STATE_ID.test(id) || !isRecord(entry)) continue;
    const { failingSince, consecutive, lastAlertAt } = entry;
    if (!isIsoDate(failingSince)) continue;
    if (typeof consecutive !== 'number' || !Number.isInteger(consecutive) || consecutive < 1) {
      continue;
    }
    if (lastAlertAt !== null && !isIsoDate(lastAlertAt)) continue;
    state.checks[id] = { failingSince, consecutive: Math.min(consecutive, 1_000_000), lastAlertAt };
  }
  if (isRecord(raw.recent)) {
    const recent: Record<string, RecentAlert> = {};
    for (const [id, entry] of Object.entries(raw.recent)) {
      if (!STATE_ID.test(id) || !isRecord(entry)) continue;
      const { lastAlertAt, recoveredAt } = entry;
      if (!isIsoDate(lastAlertAt) || !isIsoDate(recoveredAt)) continue;
      recent[id] = { lastAlertAt, recoveredAt };
    }
    if (Object.keys(recent).length > 0) state.recent = recent;
  }
  return state;
}

/**
 * Critical ids alert on the first failing run, the others after 2 consecutive failing runs; a
 * check still failing re-alerts once every 24 hours (at once if its last alert is dated in the
 * future, which only a corrupt state can do); a check that passes (or only warns) again is
 * removed from the state and reported as recovered. An alerted check that breaks again within
 * FLAP_WINDOW_MS of recovering keeps its previous alert time, so a flapping check emails once a
 * day, not on every failure. When this run alerts anyway, every reminder at least
 * BATCH_REMINDER_MS old rides along, so daily reminders arrive in one email. Internal ids missing
 * from this run recover only when /api/status answered (otherwise they are unknown and kept);
 * other missing ids belong to checks that no longer exist and are forgotten.
 */
export function decideAlerts(
  previousState: unknown,
  results: readonly CheckResult[],
  now: Date,
): AlertDecision {
  const previous = normalizeState(previousState);
  const recentBefore = previous.recent ?? {};
  const nowIso = now.toISOString();
  const ageOf = (iso: string) => now.getTime() - Date.parse(iso);
  const state = emptyState();
  const recent: Record<string, RecentAlert> = {};
  const alerts: AlertItem[] = [];
  const ongoing: OngoingItem[] = [];
  const recovered: RecoveredItem[] = [];
  const seen = new Set<string>();

  const recover = (id: string, label: string, before: CheckState) => {
    recovered.push({
      id,
      label,
      failingSince: before.failingSince,
      wasAlerted: before.lastAlertAt !== null,
    });
    if (before.lastAlertAt !== null) {
      recent[id] = { lastAlertAt: before.lastAlertAt, recoveredAt: nowIso };
    }
  };

  for (const result of results) {
    if (seen.has(result.id) || !STATE_ID.test(result.id)) continue;
    seen.add(result.id);
    const before = previous.checks[result.id];
    if (result.status !== 'fail') {
      if (before) recover(result.id, result.label, before);
      continue;
    }
    const flap = before ? undefined : recentBefore[result.id];
    const flapAge = flap ? ageOf(flap.recoveredAt) : -1;
    const inherited = flap && flapAge >= 0 && flapAge < FLAP_WINDOW_MS ? flap.lastAlertAt : null;
    const consecutive = (before?.consecutive ?? 0) + 1;
    const failingSince = before?.failingSince ?? nowIso;
    let lastAlertAt = before?.lastAlertAt ?? inherited;
    let kind: AlertItem['kind'] | null = null;
    if (consecutive >= (result.critical ? 1 : 2)) {
      if (lastAlertAt === null) kind = 'new';
      else {
        const age = ageOf(lastAlertAt);
        if (age < 0 || age >= REALERT_MS - REALERT_SLACK_MS) kind = 'reminder';
      }
    }
    const item = {
      id: result.id,
      label: result.label,
      critical: result.critical,
      detail: result.detail,
      failingSince,
      consecutive,
    };
    if (kind) {
      lastAlertAt = nowIso;
      alerts.push({ ...item, kind });
    } else {
      ongoing.push({ ...item, alerted: lastAlertAt !== null });
    }
    state.checks[result.id] = { failingSince, consecutive, lastAlertAt };
  }

  // One email a day: an email that goes out anyway also carries the older reminders.
  const quiet: OngoingItem[] = [];
  for (const item of ongoing) {
    const entry = state.checks[item.id];
    const lastAlertAt = entry?.lastAlertAt ?? null;
    if (alerts.length > 0 && entry && lastAlertAt && ageOf(lastAlertAt) >= BATCH_REMINDER_MS) {
      entry.lastAlertAt = nowIso;
      const { alerted: _alerted, ...rest } = item;
      alerts.push({ ...rest, kind: 'reminder' });
    } else {
      quiet.push(item);
    }
  }

  const internalKnown = results.some(
    (result) =>
      (result.id === 'internal_status' && result.status !== 'fail') ||
      result.id.startsWith(INTERNAL_PREFIX),
  );
  for (const [id, before] of Object.entries(previous.checks)) {
    if (seen.has(id) || !id.startsWith(INTERNAL_PREFIX)) continue;
    if (internalKnown) recover(id, labelForId(id), before);
    else state.checks[id] = before;
  }

  for (const [id, entry] of Object.entries(recentBefore)) {
    if (recent[id] || state.checks[id]) continue;
    const age = ageOf(entry.recoveredAt);
    if (age >= 0 && age < FLAP_WINDOW_MS) recent[id] = entry;
  }
  if (Object.keys(recent).length > 0) state.recent = recent;
  return { state, alerts, ongoing: quiet, recovered };
}

// ---------- Riepilogo ----------

export type MonitorReport = {
  baseUrl: string;
  startedAt: Date;
  finishedAt: Date;
  results: CheckResult[];
  decision: AlertDecision;
  notes: string[];
};

const ROME = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatRome(date: Date): string {
  return Number.isFinite(date.getTime()) ? ROME.format(date) : 'data sconosciuta';
}

const ICONS: Record<CheckStatus, string> = { ok: '✅', warn: '⚠️', fail: '❌' };
const TEXT_TAGS: Record<CheckStatus, string> = {
  ok: '[OK]    ',
  warn: '[AVVISO]',
  fail: '[ERRORE]',
};

function cell(text: string): string {
  return clip(text, 300).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/</g, '&lt;');
}

export function overallLine(report: Pick<MonitorReport, 'results' | 'decision'>): string {
  const { alerts } = report.decision;
  const fresh = alerts.filter((alert) => alert.kind === 'new').length;
  if (fresh > 0) {
    return `❌ ${fresh === 1 ? 'Un nuovo problema' : `${fresh} nuovi problemi`}: GitHub ti manda un’email`;
  }
  if (alerts.length > 0) return '❌ Problemi ancora presenti: promemoria giornaliero via email';
  if (report.results.some((result) => result.status === 'fail')) {
    return '❌ Problemi già segnalati o in attesa di conferma al prossimo controllo';
  }
  if (report.results.some((result) => result.status === 'warn')) {
    return '⚠️ Tutto funziona, con qualche avviso';
  }
  return '✅ Tutto funziona';
}

function since(iso: string): string {
  return `dal ${formatRome(new Date(iso))}`;
}

export function renderMarkdown(report: MonitorReport): string {
  const { results, decision } = report;
  const seconds = ((report.finishedAt.getTime() - report.startedAt.getTime()) / 1000)
    .toFixed(1)
    .replace('.', ',');
  const lines = [
    '## Monitoraggio Solco',
    '',
    `**${overallLine(report)}**`,
    '',
    `Controllato ${report.baseUrl} il ${formatRome(report.finishedAt)} (ora italiana), in ${seconds} s.`,
    '',
    '| Esito | Controllo | Dettaglio | ms |',
    '| :---: | --- | --- | ---: |',
    ...results.map(
      (result) =>
        `| ${ICONS[result.status]} | ${cell(result.label)} | ${cell(result.detail)} | ${result.ms ?? '—'} |`,
    ),
    '',
    '### Nuovi problemi',
    '',
  ];
  if (decision.alerts.length === 0) lines.push('Nessuno.');
  for (const alert of decision.alerts) {
    const tag = alert.kind === 'reminder' ? `promemoria, guasto ${since(alert.failingSince)}` : '';
    const critical = alert.critical ? 'critico' : '';
    const extra = [critical, tag].filter(Boolean).join(', ');
    lines.push(`- ❌ **${cell(alert.label)}**${extra ? ` (${extra})` : ''}: ${cell(alert.detail)}`);
  }
  lines.push('', '### Ancora in corso', '');
  if (decision.ongoing.length === 0) lines.push('Nessuno.');
  for (const item of decision.ongoing) {
    const note = item.alerted
      ? `guasto ${since(item.failingSince)}, già segnalato (promemoria ogni 24 ore)`
      : 'primo errore: email solo se si ripete al prossimo controllo';
    lines.push(`- ❌ **${cell(item.label)}**: ${cell(item.detail)} (${note})`);
  }
  lines.push('', '### Tornati a funzionare', '');
  if (decision.recovered.length === 0) lines.push('Nessuno.');
  for (const item of decision.recovered) {
    lines.push(`- ✅ **${cell(item.label)}** (guasto ${since(item.failingSince)})`);
  }
  if (report.notes.length > 0) {
    lines.push('', ...report.notes.map((note) => `> ${cell(note)}`));
  }
  return `${lines.join('\n')}\n`;
}

export function renderText(report: MonitorReport): string {
  const lines = [
    `Monitoraggio Solco: ${report.baseUrl} (${formatRome(report.finishedAt)}, ora italiana)`,
    ...report.results.map(
      (result) =>
        `${TEXT_TAGS[result.status]} ${result.label}: ${result.detail}${result.ms === null ? '' : ` (${result.ms} ms)`}`,
    ),
    ...report.notes.map((note) => `Nota: ${note}`),
    `Esito: ${overallLine(report)}`,
  ];
  const { alerts, ongoing, recovered } = report.decision;
  if (alerts.length > 0) lines.push(`Nuovi problemi: ${alerts.map((a) => a.label).join('; ')}`);
  if (ongoing.length > 0) lines.push(`Ancora in corso: ${ongoing.map((o) => o.label).join('; ')}`);
  if (recovered.length > 0) {
    lines.push(`Tornati a funzionare: ${recovered.map((r) => r.label).join('; ')}`);
  }
  return `${lines.join('\n')}\n`;
}

function escapeAnnotation(text: string, property = false): string {
  const escaped = text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return property ? escaped.replace(/:/g, '%3A').replace(/,/g, '%2C') : escaped;
}

/** GitHub workflow commands: each alert becomes an error annotation on the run page. */
export function renderAnnotations(decision: AlertDecision): string {
  return decision.alerts
    .map(
      (alert) =>
        `::error title=${escapeAnnotation(`Solco: ${alert.label}`, true)}::${escapeAnnotation(alert.detail)}\n`,
    )
    .join('');
}

// ---------- File ed esecuzione ----------

export async function readStateFile(path: string): Promise<{ raw: unknown; note: string | null }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = isRecord(error) ? error.code : null;
    return code === 'ENOENT'
      ? { raw: null, note: 'Nessuno stato precedente: questo è il primo controllo.' }
      : { raw: null, note: 'Stato precedente illeggibile: si riparte da zero.' };
  }
  try {
    const raw: unknown = JSON.parse(text);
    const usable = isRecord(raw) && raw.version === 1 && isRecord(raw.checks);
    return usable
      ? { raw, note: null }
      : { raw: null, note: 'Stato precedente in un formato diverso: si riparte da zero.' };
  } catch {
    return { raw: null, note: 'Stato precedente non valido: si riparte da zero.' };
  }
}

export async function writeStateFile(path: string, state: MonitorState): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}

export function normalizeBaseUrl(value: string | undefined): string {
  const url = new URL(value?.trim() || DEFAULT_BASE_URL);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('BASE_URL deve essere un indirizzo http(s)');
  }
  return url.origin;
}

export function createDeps(baseUrl: string, overrides: Partial<MonitorDeps> = {}): MonitorDeps {
  return {
    baseUrl,
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    clock: () => performance.now(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    retryDelayMs: RETRY_DELAY_MS,
    ...overrides,
  };
}

/** Returns the exit code. `overrides` lets tests replace fetch/sleep; the CLI passes none. */
export async function main(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<MonitorDeps> = {},
): Promise<number> {
  const baseUrl = normalizeBaseUrl(env.BASE_URL);
  const stateFile = env.STATE_FILE?.trim() || DEFAULT_STATE_FILE;
  const startedAt = new Date();
  const previous = await readStateFile(stateFile);
  const results = await runAllChecks(createDeps(baseUrl, overrides));
  const finishedAt = new Date();
  const decision = decideAlerts(previous.raw, results, finishedAt);
  const report: MonitorReport = {
    baseUrl,
    startedAt,
    finishedAt,
    results,
    decision,
    notes: previous.note ? [previous.note] : [],
  };
  await writeStateFile(stateFile, decision.state);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, renderMarkdown(report));
  process.stdout.write(renderText(report));
  if (env.GITHUB_ACTIONS === 'true') process.stdout.write(renderAnnotations(decision));
  return decision.alerts.length > 0 ? 1 : 0;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    async (error: unknown) => {
      process.exitCode = 2;
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`Monitoraggio: lo script si è interrotto.\n${detail}\n`);
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (!summary) return;
      try {
        await appendFile(
          summary,
          '## Monitoraggio Solco\n\n**💥 Lo script di controllo si è interrotto prima di finire.** ' +
            'Il sito non è stato controllato: guarda il log del job per i dettagli.\n',
        );
      } catch {
        // niente riepilogo: resta il log
      }
    },
  );
}
