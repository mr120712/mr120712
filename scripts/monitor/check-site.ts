// @polsia:user-owned — controllo esterno di Solco, eseguito ogni ora da GitHub Actions
// (.github/workflows/monitor.yml). Un solo file autonomo, avviato con
// `node scripts/monitor/check-site.ts` su Node 24 (type stripping integrato): solo TypeScript
// cancellabile (niente enum, namespace, parameter properties), nessun import relativo, nessuna
// dipendenza npm (solo il fetch globale). Le funzioni pure sono esportate per i test unitari;
// main() parte solo quando il file viene eseguito direttamente.
//
// Esito: exit 1 se in questo giro parte almeno un avviso (GitHub manda un'email), 0 altrimenti,
// 2 se lo script stesso si interrompe. Lo stato tra un giro e l'altro vive in STATE_FILE.
import { createHash } from 'node:crypto';
import { promises as dnsPromises } from 'node:dns';
import { realpathSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import type { ConnectionOptions, TLSSocket } from 'node:tls';
import { connect as tlsConnect } from 'node:tls';
import { pathToFileURL } from 'node:url';

export const DEFAULT_BASE_URL = 'https://www.solcomusic.online';
export const DEFAULT_STATE_FILE = '.monitor-state.json';
export const USER_AGENT = 'SolcoMonitor/1.0 (+https://github.com/mr120712/mr120712)';
export const REQUEST_TIMEOUT_MS = 15_000;
/**
 * /api/status answers from the stored run (a new run starts after the response), but a cold start
 * plus a database waking up can take a while (its database reads stop at 20 s, then 503): wait
 * well beyond the default, so that the server's own answer is read instead of a timeout.
 */
export const STATUS_TIMEOUT_MS = 35_000;
export const RETRY_DELAY_MS = 5_000;
/**
 * Same value as PUBLIC_REFRESH_AFTER_MS (src/lib/monitoring/monitor.server.ts): an answer whose
 * run is older than this (or missing) has just scheduled a new run, after the response.
 */
export const STATUS_REFRESH_AFTER_MS = 50 * 60 * 1000;
/** Wait for that new run (checks of 8 s at most, plus saving it) before reading again. */
export const STATUS_REREAD_DELAY_MS = 25_000;
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
const HOUR_MS = 60 * 60 * 1000;
/**
 * Controllo sintetico "monitor cieco": il firewall di Vercel ferma i controlli che vedono un
 * guasto vero, quindi nessun altro controllo può più mandare un'email.
 */
export const FIREWALL_BLIND_ID = 'firewall_blind';
/** Giri orari di fila con il monitor cieco prima della prima email (circa 6 ore). */
export const FIREWALL_BLIND_ALERT_AFTER = 6;
/**
 * Il controllo decisivo per il monitor cieco: /api/status è l'unico che vede database,
 * registrazione, accesso e gli altri controlli interni (e risponde solo se l'app è su). /health
 * è statico (non tocca il database): se risponde ma /api/status è fermato, un database spento
 * resta invisibile, quindi conta solo /api/status.
 */
export const FIREWALL_DECISIVE = 'internal_status';
/** I percorsi citati nel testo della riga: /health solo per la descrizione, mai per la regola. */
export const FIREWALL_SENTINELS = ['site_health', FIREWALL_DECISIVE] as const;

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
  /** Presente quando il firewall di Vercel ha risposto con la sua verifica del browser. */
  firewallChallenged?: true;
  /**
   * Giri di fila con errore prima della prima email, quando non basta la regola di `critical`
   * (1 giro se critico, 2 altrimenti): oggi solo il controllo del monitor cieco.
   */
  alertAfter?: number;
};

export type CheckOutcome = {
  status: CheckStatus;
  detail: string;
  critical?: boolean;
  firewallChallenged?: true;
  /** Lunghezza massima del dettaglio, se serve più di MAX_DETAIL (oggi solo il controllo TLS). */
  maxDetail?: number;
};

export type MonitorDeps = {
  baseUrl: string;
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  /** Millisecondi monotoni, per misurare le durate. */
  clock: () => number;
  /** Ora corrente, per l'età dell'ultimo controllo interno. */
  now: () => Date;
  timeoutMs: number;
  retryDelayMs: number;
  /** Una stretta di mano TLS verso il sito (controllo «Crittografia HTTPS»): mai una richiesta HTTP. */
  tlsProbe: (request: TlsProbeRequest) => Promise<TlsProbeResult>;
  /** Record DNS CAA di un nome ([] se non ce ne sono). */
  resolveCaa: (name: string) => Promise<CaaRecord[]>;
};

// ---------- Tipi del controllo TLS ----------

export type TlsVersionName = 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';

export type TlsProbeRequest = {
  host: string;
  port: number;
  minVersion?: TlsVersionName;
  maxVersion?: TlsVersionName;
  /** Elenco OpenSSL: le suite TLS 1.3 iniziano con «TLS_», le altre valgono per TLS 1.2 e prima. */
  ciphers?: string;
};

export type TlsCertificateInfo = {
  keyType: 'RSA' | 'EC' | 'altro';
  /** Bit della chiave pubblica (RSA: modulo; EC: dimensione della curva). */
  keyBits: number | null;
  /** Curva della chiave EC (P-256, P-384…). */
  curve: string | null;
  /** Organizzazione e nome dell'autorità che l'ha emesso (es. «Let's Encrypt E6»). */
  issuer: string | null;
  /** Scadenza in ISO, null se illeggibile. */
  validTo: string | null;
};

export type TlsProbeResult =
  | {
      ok: true;
      protocol: string | null;
      /** Nome standard IANA della suite (es. TLS_AES_256_GCM_SHA384). */
      cipher: string | null;
      /** Gruppo dello scambio di chiavi effimero (es. X25519). */
      group: string | null;
      /** Catena valida e nome del sito coperto dal certificato. */
      authorized: boolean;
      authorizationError: string | null;
      certificate: TlsCertificateInfo | null;
    }
  | { ok: false; code: string };

export type CaaRecord = { critical: number; issue?: string; issuewild?: string; iodef?: string };

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
  /** false: il controllo non ha ancora raggiunto la sua soglia, avviso solo se si ripete. */
  alerted: boolean;
  /** Giri di fila con errore che fanno partire la prima email (vedi alertThreshold). */
  alertAfter: number;
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
  // Niente /pubblica: la libreria pubblica è spenta (src/lib/features.ts) e la pagina rimanda alla
  // Home, e per questo controllo un rimando è un errore. Riattivandola, rimetti la sua riga qui,
  // come la rimette il menu (src/lib/nav.ts).
  { path: '/pool', label: 'Record Pool', critical: false },
  { path: '/classici', label: 'Classici', critical: false },
  { path: '/community', label: 'Community', critical: false },
  { path: '/piani', label: 'Piani', critical: false },
  { path: '/premi', label: 'Invita amici', critical: false },
  { path: '/app', label: 'Installa l’app', critical: false },
  { path: '/flashcards', label: 'Flashcard', critical: false },
  { path: '/apple-music', label: 'Apple Music', critical: false },
  { path: '/stato', label: 'Stato', critical: false },
  { path: '/privacy', label: 'Privacy', critical: false },
  { path: '/terms', label: 'Termini', critical: false },
  { path: '/login', label: 'Accedi', critical: false },
  { path: '/signup', label: 'Registrati', critical: false },
  // Pagine leggibili senza account (menu e piè di pagina), anche nella sitemap. In coda: i test
  // del monitor contano sulle prime posizioni dell'elenco.
  { path: '/bot', label: 'Bot', critical: false },
  { path: '/guida', label: 'Guida', critical: false },
  { path: '/impostazioni', label: 'Impostazioni', critical: false },
  { path: '/contatti', label: 'Contatti', critical: false },
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
  freellmapi: { label: 'Riserva AI gratuita (Solco)', critical: false },
  solco_ai: { label: 'Solco AI (trascrizione testi)', critical: false },
  stripe: { label: 'Pagamenti Stripe', critical: false },
  cron_cleanup: { label: 'Pulizia giornaliera', critical: false },
};

const CHECK_LABELS: Record<string, string> = {
  site_health: 'Sito raggiungibile (/health)',
  security_headers: 'Intestazioni di sicurezza',
  tls: 'Crittografia HTTPS (TLS e certificato)',
  response_time: 'Velocità della home',
  seo_files: 'robots.txt e sitemap.xml',
  google_signin: 'Accesso con Google',
  signup_route: 'Registrazione (modulo)',
  catalog_radio: 'Catalogo radio',
  catalog_podcasts: 'Catalogo podcast',
  catalog_audius: 'Catalogo Audius',
  internal_status: 'Controlli interni (/api/status)',
  [FIREWALL_BLIND_ID]: 'Visibilità del monitor (firewall di Vercel)',
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

/** Testo di un controllo fermato dall'Attack Challenge Mode di Vercel (protezione accesa). */
export const FIREWALL_CHALLENGE_DETAIL =
  'Protezione anti-attacco di Vercel attiva (verifica del browser): pagina non verificata dal monitor';

/**
 * Risposta "verifica il browser" del firewall di Vercel (x-vercel-mitigated: challenge): con
 * l'Attack Challenge Mode acceso arriva a ogni client che non è un browser, monitor compreso.
 * I browser veri la superano: è la protezione accesa, non un sito giù.
 */
export class FirewallChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FirewallChallengeError';
  }
}

function isFirewallChallenge(headers: Headers): boolean {
  return (headers.get('x-vercel-mitigated') ?? '').trim().toLowerCase() === 'challenge';
}

/** Avviso di un controllo fermato dalla verifica di Vercel, marcato per il monitor cieco. */
function firewallChallenged(): CheckOutcome {
  return { status: 'warn', detail: FIREWALL_CHALLENGE_DETAIL, firewallChallenged: true };
}

// ---------- Cancello anti-bot del sito (UAM) ----------

/** Cookie del via libera del cancello anti-bot (UAM_COOKIE in src/lib/security/uam.ts). */
export const UAM_COOKIE_NAME = 'solco_uam';
/** Tetto della prova di lavoro: 2^24 tentativi coprono con margine la difficoltà massima (20 bit). */
export const UAM_MAX_ITERATIONS = 1 << 24;

/** Via libera di un giro: uno solo, condiviso dai controlli in parallelo (WeakMap: MonitorDeps resta com'è). */
type UamJar = { cookie: string | null; pending: Promise<boolean> | null };
const uamJars = new WeakMap<MonitorDeps, UamJar>();

function uamJar(deps: MonitorDeps): UamJar {
  let jar = uamJars.get(deps);
  if (!jar) {
    jar = { cookie: null, pending: null };
    uamJars.set(deps, jar);
  }
  return jar;
}

/** La sfida della schermata anti-bot: il blocco JSON `#uam-data` della pagina (uam-page.ts). */
export function extractUamChallenge(
  html: string,
): { challenge: string; difficulty: number } | null {
  const match = /<script type="application\/json" id="uam-data">([\s\S]*?)<\/script>/.exec(html);
  if (!match) return null;
  try {
    const data: unknown = JSON.parse(match[1] ?? '');
    if (
      !isRecord(data) ||
      typeof data.challenge !== 'string' ||
      typeof data.difficulty !== 'number'
    ) {
      return null;
    }
    if (data.challenge.length > 200 || !Number.isInteger(data.difficulty)) return null;
    if (data.difficulty < 1 || data.difficulty > 24) return null;
    return { challenge: data.challenge, difficulty: data.difficulty };
  } catch {
    return null;
  }
}

function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/**
 * La prova di lavoro, come il risolutore della pagina: il primo n per cui SHA-256 di
 * `sfida:n` comincia con `difficulty` bit a zero. null se non si trova entro il tetto.
 */
export function solveUamChallenge(
  challenge: string,
  difficulty: number,
  maxIterations = UAM_MAX_ITERATIONS,
): string | null {
  for (let n = 0; n < maxIterations; n += 1) {
    const digest = createHash('sha256').update(`${challenge}:${n}`).digest();
    if (leadingZeroBits(digest) >= difficulty) return String(n);
  }
  return null;
}

/** Il valore di `solco_uam` dalla risposta di /api/uam/verify. */
function uamCookieFrom(response: Response): string | null {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const lines = headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
  for (const line of lines) {
    const match = /(?:^|[,;]\s*)solco_uam=([^;,\s]+)/.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function obtainUamClearance(deps: MonitorDeps, html: string): Promise<boolean> {
  const parsed = extractUamChallenge(html);
  if (!parsed) return false;
  const solution = solveUamChallenge(parsed.challenge, parsed.difficulty);
  if (solution === null) return false;
  try {
    const response = await request(deps, '/api/uam/verify', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: deps.baseUrl,
      },
      body: JSON.stringify({ challenge: parsed.challenge, solution }),
    });
    const cookie = response.ok ? uamCookieFrom(response) : null;
    await discard(response);
    if (!cookie) return false;
    uamJar(deps).cookie = cookie;
    return true;
  } catch {
    return false;
  }
}

/**
 * Supera la schermata anti-bot del sito come un browser: legge la sfida, risolve la prova di
 * lavoro e chiede il via libera, una volta per giro (i controlli in parallelo aspettano lo
 * stesso tentativo). Vero se il monitor ora ha il cookie; se non riesce, la pagina resta un avviso.
 */
async function passUamGate(deps: MonitorDeps, html: string): Promise<boolean> {
  const jar = uamJar(deps);
  if (jar.cookie) return true;
  if (!jar.pending) jar.pending = obtainUamClearance(deps, html);
  return jar.pending;
}

function isUamChallenge(headers: Headers): boolean {
  return (headers.get('x-solco-gate') ?? '').trim().toLowerCase() === 'challenge';
}

/** GET di una pagina; se risponde la schermata anti-bot, la supera e la chiede di nuovo. */
async function requestPage(deps: MonitorDeps, path: string): Promise<Response> {
  const response = await request(deps, path, { headers: { Accept: 'text/html' } });
  if (!isUamChallenge(response.headers)) return response;
  let html = '';
  try {
    html = await response.text();
  } catch {
    return response;
  }
  if (!(await passUamGate(deps, html))) return response;
  return request(deps, path, { headers: { Accept: 'text/html' } });
}

async function fetchUrl(
  deps: MonitorDeps,
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('User-Agent', USER_AGENT);
  // Il via libera del cancello anti-bot solo verso il sito, mai verso altri domini (es. Google).
  const cookie = uamJars.get(deps)?.cookie;
  if (cookie && !headers.has('Cookie') && sameSiteOrigin(url, deps.baseUrl)) {
    headers.set('Cookie', `${UAM_COOKIE_NAME}=${cookie}`);
  }
  const response = await deps.fetch(url, {
    redirect: 'manual',
    ...init,
    headers,
    signal: AbortSignal.timeout(deps.timeoutMs),
  });
  if (isFirewallChallenge(response.headers)) {
    await discard(response);
    throw new FirewallChallengeError(FIREWALL_CHALLENGE_DETAIL);
  }
  return response;
}

function sameSiteOrigin(url: string | URL, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
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
 * not checked, which is neither a pass nor an outage, so only a warning. The same for the Vercel
 * Firewall's browser challenge (`x-vercel-mitigated: challenge`, Attack Challenge Mode on): real
 * browsers pass it. Any other mitigation (deny, rate limit…) may stop real visitors too, so it
 * stays a failure, with a detail that says why.
 */
export function gateOutcome(headers: Headers): CheckOutcome | null {
  if ((headers.get('x-solco-gate') ?? '').trim().toLowerCase() === 'challenge') {
    return warn('Schermata anti-bot (UAM) attiva: pagina non verificata');
  }
  if (isFirewallChallenge(headers)) return firewallChallenged();
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
      // Protezione di Vercel accesa: un avviso, mai un allarme, e niente secondo tentativo. Se
      // dura, lo segnala il controllo del monitor cieco (firewallBlindResult).
      outcome =
        error instanceof FirewallChallengeError
          ? firewallChallenged()
          : fail(describeError(error, deps.timeoutMs));
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
    detail: clip(outcome.detail, outcome.maxDetail ?? MAX_DETAIL),
    ms,
    ...(outcome.firewallChallenged ? { firewallChallenged: true as const } : {}),
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
  const response = await requestPage(deps, path);
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
  const response = await requestPage(deps, '/');
  await discard(response);
  const gated = gateOutcome(response.headers);
  if (gated) return gated;
  if (response.status !== 200) return fail(`La home risponde HTTP ${response.status}`);
  return evaluateSecurityHeaders(response.headers);
}

// ---------- Crittografia HTTPS (TLS) ----------

/**
 * Giorni alla scadenza del certificato sotto i quali scatta un avviso: Vercel lo rinnova da sé
 * circa 30 giorni prima, quindi meno di 21 vuol dire che il rinnovo non sta andando.
 */
export const TLS_WARN_DAYS = 21;
/** Sotto questa soglia è un errore critico: email al primo giro, il sito sta per diventare rosso. */
export const TLS_FAIL_DAYS = 7;
/** Minimi correnti (NIST SP 800-57): RSA 2048 bit, curve ellittiche 256 bit. */
export const TLS_MIN_RSA_BITS = 2048;
export const TLS_MIN_EC_BITS = 256;
const TLS_PROBE_TIMEOUT_MS = 10_000;
/** Il dettaglio TLS riporta più fatti degli altri controlli: stessa misura della cella del riepilogo. */
export const TLS_DETAIL_MAX = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Errori del nostro client, non del server: quel tentativo non dice nulla sul sito. */
const LOCAL_TLS_LIMITS = new Set([
  'ERR_SSL_NO_PROTOCOLS_AVAILABLE',
  'ERR_SSL_NO_CIPHERS_AVAILABLE',
  'ERR_SSL_NO_CIPHER_MATCH',
  'ERR_TLS_INVALID_PROTOCOL_VERSION',
  'ERR_INVALID_ARG_VALUE',
  'TIMEOUT',
]);

function tlsErrorCode(error: unknown): string {
  const code = isRecord(error) ? error.code : null;
  return typeof code === 'string' && /^[A-Z0-9_]{2,80}$/.test(code) ? code : 'ERRORE';
}

function text(value: unknown): string | null {
  if (Array.isArray(value)) return text(value[0]);
  return typeof value === 'string' && value.trim() ? clip(value, 60) : null;
}

/** Una stretta di mano TLS (nessuna richiesta HTTP), con i dati del certificato e della cifratura. */
export function probeTls(
  request: TlsProbeRequest,
  timeoutMs = TLS_PROBE_TIMEOUT_MS,
): Promise<TlsProbeResult> {
  return new Promise((resolveProbe) => {
    let settled = false;
    let socket: TLSSocket | undefined;
    const finish = (result: TlsProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolveProbe(result);
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'TIMEOUT' }), timeoutMs);
    const options: ConnectionOptions = {
      host: request.host,
      port: request.port,
      // Nessuna verifica bloccante: la validità del certificato si legge da `authorized`.
      rejectUnauthorized: false,
      ALPNProtocols: ['h2', 'http/1.1'],
      ...(isIP(request.host) ? {} : { servername: request.host }),
      ...(request.minVersion ? { minVersion: request.minVersion } : {}),
      ...(request.maxVersion ? { maxVersion: request.maxVersion } : {}),
      ...(request.ciphers ? { ciphers: request.ciphers } : {}),
    };
    try {
      socket = tlsConnect(options, () => {
        const secure = socket as TLSSocket;
        const peer = secure.getPeerCertificate(false);
        const cipher = secure.getCipher();
        const ephemeral = secure.getEphemeralKeyInfo();
        const hasCert = isRecord(peer) && Object.keys(peer).length > 0;
        const keyType = !hasCert
          ? null
          : peer.modulus
            ? 'RSA'
            : peer.asn1Curve || peer.nistCurve
              ? 'EC'
              : 'altro';
        const validTo = hasCert ? Date.parse(peer.valid_to) : Number.NaN;
        const issuer = hasCert
          ? [text(peer.issuer?.O), text(peer.issuer?.CN)].filter(Boolean).join(' ') || null
          : null;
        const authError = secure.authorizationError as unknown;
        finish({
          ok: true,
          protocol: secure.getProtocol(),
          cipher: cipher?.standardName || cipher?.name || null,
          group: isRecord(ephemeral) && typeof ephemeral.name === 'string' ? ephemeral.name : null,
          authorized: secure.authorized,
          authorizationError: secure.authorized
            ? null
            : isRecord(authError) && typeof authError.code === 'string'
              ? authError.code
              : authError
                ? clip(String(authError), 80)
                : 'sconosciuto',
          certificate: keyType
            ? {
                keyType,
                keyBits: typeof peer.bits === 'number' ? peer.bits : null,
                curve: text(peer.nistCurve) ?? text(peer.asn1Curve),
                issuer,
                validTo: Number.isFinite(validTo) ? new Date(validTo).toISOString() : null,
              }
            : null,
        });
      });
      socket.once('error', (error) => finish({ ok: false, code: tlsErrorCode(error) }));
    } catch (error) {
      finish({ ok: false, code: tlsErrorCode(error) });
    }
  });
}

/** Dominio CA di un valore CAA («letsencrypt.org; validationmethods=dns-01» → letsencrypt.org). */
function caaDomain(value: string): string {
  return value.split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * Record CAA validi per il sito: quelli del nome stesso o, se mancano, del primo genitore che li ha.
 * Elenco breve: «letsencrypt.org» (issue), «letsencrypt.org (wildcard)» (issuewild), «nessuna CA»
 * (issue vuoto), «iodef»; null se il DNS non risponde.
 */
export async function lookupCaa(
  deps: Pick<MonitorDeps, 'resolveCaa'>,
  host: string,
): Promise<string[] | null> {
  if (isIP(host)) return [];
  const labels = host.split('.').filter(Boolean);
  try {
    for (let index = 0; index <= labels.length - 2; index += 1) {
      const records = await deps.resolveCaa(labels.slice(index).join('.'));
      if (records.length > 0) {
        const entries = records.map((record) => {
          if (record.issue !== undefined) return caaDomain(record.issue) || 'nessuna CA';
          if (record.issuewild !== undefined) {
            return `${caaDomain(record.issuewild) || 'nessuna CA'} (wildcard)`;
          }
          return record.iodef !== undefined ? 'iodef' : 'altro';
        });
        return [...new Set(entries)];
      }
    }
    return [];
  } catch {
    return null;
  }
}

/** Dominio CAA dell'autorità che ha emesso il certificato, dal nome dell'emittente (se noto). */
export function caaDomainForIssuer(issuer: string | null): string | null {
  if (!issuer) return null;
  const known: Array<[RegExp, string]> = [
    [/let'?s encrypt/i, 'letsencrypt.org'],
    [/globalsign/i, 'globalsign.com'],
    [/sectigo|zerossl/i, 'sectigo.com'],
    [/digicert/i, 'digicert.com'],
    [/google trust services/i, 'pki.goog'],
    [/amazon/i, 'amazon.com'],
  ];
  return known.find(([pattern]) => pattern.test(issuer))?.[1] ?? null;
}

export type TlsInspection = {
  main: TlsProbeResult;
  tls12: TlsProbeResult;
  tls11: TlsProbeResult;
  tls10: TlsProbeResult;
  aes256: TlsProbeResult;
  chacha: TlsProbeResult;
  cbc: TlsProbeResult;
  noForwardSecrecy: TlsProbeResult;
  caa: string[] | null;
};

/** Accettato, rifiutato dal server, o non verificabile (limite del nostro client). */
function verdict(result: TlsProbeResult): 'sì' | 'no' | '?' {
  if (result.ok) return 'sì';
  return LOCAL_TLS_LIMITS.has(result.code) ? '?' : 'no';
}

const VERSION_LABELS: Record<string, string> = {
  TLSv1: 'TLS 1.0',
  'TLSv1.1': 'TLS 1.1',
  'TLSv1.2': 'TLS 1.2',
  'TLSv1.3': 'TLS 1.3',
};

/** Nome breve della cifratura simmetrica (es. TLS_AES_256_GCM_SHA384 → AES-256-GCM). */
export function cipherLabel(cipher: string | null): string {
  if (!cipher) return 'cifratura sconosciuta';
  if (/CHACHA20/.test(cipher)) return 'ChaCha20-Poly1305';
  const aes = /AES_?(128|256)_?(GCM|CCM|CBC)?/.exec(cipher.replace(/-/g, '_'));
  if (aes) return `AES-${aes[1]}${aes[2] ? `-${aes[2]}` : ''}`;
  return clip(cipher, 40);
}

function isAead(cipher: string | null): boolean {
  return Boolean(cipher && /GCM|CHACHA20|CCM/.test(cipher));
}

export function evaluateTls(report: TlsInspection, now: Date): CheckOutcome {
  const { main } = report;
  if (!main.ok) return fail(`Connessione HTTPS non riuscita (${main.code})`);
  const problems: string[] = [];
  const warnings: string[] = [];
  const facts: string[] = [];
  let critical = false;

  const protocol = main.protocol ? (VERSION_LABELS[main.protocol] ?? main.protocol) : '?';
  if (main.protocol !== 'TLSv1.3' && main.protocol !== 'TLSv1.2') {
    problems.push(`protocollo debole (${protocol})`);
  }
  if (!isAead(main.cipher)) warnings.push(`cifratura non AEAD (${cipherLabel(main.cipher)})`);
  facts.push(
    `${protocol}, ${cipherLabel(main.cipher)}${main.group ? `, scambio ${clip(main.group, 24)}` : ''}`,
  );

  if (!main.authorized) {
    problems.push(`certificato non valido (${main.authorizationError ?? 'sconosciuto'})`);
    critical = true;
  }
  const cert = main.certificate;
  if (!cert) {
    problems.push('certificato non leggibile');
  } else {
    const bits = cert.keyBits;
    let key: string;
    if (cert.keyType === 'RSA') {
      key = `RSA ${bits ?? '?'} bit`;
      if (bits !== null && bits < TLS_MIN_RSA_BITS)
        problems.push(`chiave RSA debole (${bits} bit)`);
    } else if (cert.keyType === 'EC') {
      key = `ECDSA ${cert.curve ?? `${bits ?? '?'} bit`}`;
      if (bits !== null && bits < TLS_MIN_EC_BITS) problems.push(`chiave EC debole (${bits} bit)`);
    } else {
      key = 'chiave di tipo sconosciuto';
    }
    const expires = cert.validTo ? Date.parse(cert.validTo) : Number.NaN;
    const days = Number.isFinite(expires) ? Math.floor((expires - now.getTime()) / DAY_MS) : null;
    if (days === null) {
      warnings.push('scadenza del certificato illeggibile');
    } else if (days < TLS_FAIL_DAYS) {
      problems.push(
        days < 0 ? 'certificato scaduto' : `certificato in scadenza tra ${days} giorni`,
      );
      critical = true;
    } else if (days < TLS_WARN_DAYS) {
      warnings.push(`certificato in scadenza tra ${days} giorni (rinnovo automatico in ritardo)`);
    }
    facts.push(
      `certificato ${key}${cert.issuer ? ` di ${cert.issuer}` : ''}${days !== null && days >= 0 ? `, scade tra ${days} gg` : ''}`,
    );
  }

  const legacy = { 'TLS 1.0': verdict(report.tls10), 'TLS 1.1': verdict(report.tls11) };
  const accepted = Object.entries(legacy)
    .filter(([, value]) => value === 'sì')
    .map(([name]) => name);
  if (accepted.length > 0) warnings.push(`accetta ancora ${accepted.join(' e ')}`);
  else if (Object.values(legacy).includes('?')) facts.push('TLS 1.0/1.1 non verificabili');
  else facts.push('TLS 1.0/1.1 rifiutati');
  if (verdict(report.cbc) === 'sì') facts.push('accetta CBC per vecchi client');
  if (verdict(report.noForwardSecrecy) === 'sì') facts.push('accetta scambio RSA senza PFS');

  // CAA: chi può emettere certificati per il dominio. Se ci sono record ma non autorizzano chi ha
  // emesso il certificato attuale, il prossimo rinnovo automatico verrebbe rifiutato.
  if (report.caa === null) {
    facts.push('CAA non letto');
  } else if (report.caa.length === 0) {
    facts.push('nessun record CAA');
  } else {
    facts.push(`CAA: ${report.caa.join(', ')}`);
    const issuerDomain = caaDomainForIssuer(cert?.issuer ?? null);
    const allowed = report.caa.filter(
      (entry) => !entry.endsWith('(wildcard)') && entry !== 'iodef',
    );
    if (issuerDomain && allowed.length > 0 && !allowed.includes(issuerDomain)) {
      warnings.push(
        `i record CAA non autorizzano ${issuerDomain}: il prossimo rinnovo può fallire`,
      );
    }
  }

  const strong = [
    verdict(report.aes256) === 'sì' ? 'AES-256' : null,
    verdict(report.chacha) === 'sì' ? 'ChaCha20' : null,
  ].filter(Boolean);
  if (strong.length > 0) facts.push(`1.3 offre anche ${strong.join(' e ')}`);
  if (verdict(report.tls12) === 'sì') facts.push('TLS 1.2 attivo');

  // I fatti vanno dal più importante al meno importante: se il testo è troppo lungo si perde la coda.
  const long = { maxDetail: TLS_DETAIL_MAX };
  if (problems.length > 0) {
    return {
      ...fail(
        `${[...problems, ...warnings].join('; ')} | ${facts.join('; ')}`,
        critical || undefined,
      ),
      ...long,
    };
  }
  if (warnings.length > 0)
    return { ...warn(`${warnings.join('; ')} | ${facts.join('; ')}`), ...long };
  return { ...ok(facts.join('; ')), ...long };
}

/**
 * Crittografia HTTPS vista da fuori: protocollo e cifratura negoziati, chiave e scadenza del
 * certificato, rifiuto di TLS 1.0/1.1, suite forti offerte, record CAA. Solo strette di mano TLS
 * (nessuna pagina richiesta) più una lettura DNS: pochi millisecondi ogni ora.
 */
export async function checkTls(deps: MonitorDeps): Promise<CheckOutcome> {
  const url = new URL(deps.baseUrl);
  if (url.protocol !== 'https:')
    return warn('Il sito non è controllato in HTTPS: TLS non verificato');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port ? Number(url.port) : 443;
  const probe = (extra: Omit<TlsProbeRequest, 'host' | 'port'> = {}) =>
    deps.tlsProbe({ host, port, ...extra });
  const main = await probe();
  if (!main.ok) return fail(`Connessione HTTPS non riuscita (${main.code})`);
  const legacyCiphers = 'DEFAULT:@SECLEVEL=0';
  const report: TlsInspection = {
    main,
    tls12: await probe({ minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }),
    tls11: await probe({ minVersion: 'TLSv1.1', maxVersion: 'TLSv1.1', ciphers: legacyCiphers }),
    tls10: await probe({ minVersion: 'TLSv1', maxVersion: 'TLSv1', ciphers: legacyCiphers }),
    aes256: await probe({ minVersion: 'TLSv1.3', ciphers: 'TLS_AES_256_GCM_SHA384' }),
    chacha: await probe({ minVersion: 'TLSv1.3', ciphers: 'TLS_CHACHA20_POLY1305_SHA256' }),
    cbc: await probe({
      maxVersion: 'TLSv1.2',
      ciphers:
        'ECDHE-ECDSA-AES128-SHA:ECDHE-RSA-AES128-SHA:ECDHE-ECDSA-AES256-SHA:ECDHE-RSA-AES256-SHA',
    }),
    noForwardSecrecy: await probe({
      maxVersion: 'TLSv1.2',
      ciphers: 'AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA',
    }),
    caa: await lookupCaa(deps, host),
  };
  return evaluateTls(report, deps.now());
}

/** Lettura CAA reale: «nessun record» e «nome inesistente» valgono come elenco vuoto. */
async function resolveCaaRecords(name: string): Promise<CaaRecord[]> {
  try {
    return (await dnsPromises.resolveCaa(name)) as CaaRecord[];
  } catch (error) {
    const code = isRecord(error) ? error.code : null;
    if (code === 'ENODATA' || code === 'ENOTFOUND') return [];
    throw error;
  }
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

/** True when this answer has just scheduled a new internal run (none yet, or older than 50 min). */
export function refreshPending(value: PublicStatusBody, now: Date): boolean {
  if (value.checkedAt === null) return true;
  return now.getTime() - Date.parse(value.checkedAt) > STATUS_REFRESH_AFTER_MS;
}

function newerThan(fresh: PublicStatusBody, old: PublicStatusBody): boolean {
  if (fresh.checkedAt === null) return false;
  return old.checkedAt === null || Date.parse(fresh.checkedAt) > Date.parse(old.checkedAt);
}

/**
 * One more read of /api/status after STATUS_REREAD_DELAY_MS, past the 60 s shared cache (unique
 * query). Never throws: null when it does not answer 200 with a usable body.
 */
async function rereadInternalStatus(deps: MonitorDeps): Promise<PublicStatusBody | null> {
  await deps.sleep(STATUS_REREAD_DELAY_MS);
  try {
    const response = await request(deps, `/api/status?fresh=${deps.now().getTime()}`, {
      headers: { Accept: 'application/json' },
    });
    if (response.status !== 200) {
      await discard(response);
      return null;
    }
    return parsePublicStatus(await readJson(response));
  } catch {
    return null;
  }
}

/**
 * /api/status answers from the stored run and starts a new one after the response when that run
 * is older than 50 minutes: in that case read again once the new run had time to finish, so that
 * this round reports the site as it is now and not as it was an hour ago. If the second read
 * fails or brings nothing newer, the first answer stands.
 */
export async function checkInternalStatus(deps: MonitorDeps): Promise<CheckResult[]> {
  const slow: MonitorDeps = { ...deps, timeoutMs: Math.max(deps.timeoutMs, STATUS_TIMEOUT_MS) };
  const parsed: { value: PublicStatusBody | null } = { value: null };
  let result = await runCheck(slow, 'internal_status', false, async () => {
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
  let value = parsed.value;
  if (!value) return [result];
  if (refreshPending(value, deps.now())) {
    const fresh = await rereadInternalStatus(slow);
    if (fresh && newerThan(fresh, value)) {
      const outcome = summarizeInternal(fresh);
      value = fresh;
      result = {
        ...result,
        critical: outcome.critical ?? false,
        status: outcome.status,
        detail: clip(outcome.detail),
      };
    }
  }
  return [result, ...internalItemResults(value)];
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
    single('tls', false, checkTls),
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

/** Durata leggibile ("meno di un’ora", "5 ore", "3 giorni e 2 ore"), per difetto. */
export function describeDuration(ms: number): string {
  const hours = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / HOUR_MS);
  const hoursText = (count: number) => (count === 1 ? 'un’ora' : `${count} ore`);
  if (hours < 1) return 'meno di un’ora';
  if (hours < 48) return hoursText(hours);
  const days = `${Math.floor(hours / 24)} giorni`;
  const rest = hours % 24;
  return rest === 0 ? days : `${days} e ${hoursText(rest)}`;
}

const SENTINEL_PATHS: Record<(typeof FIREWALL_SENTINELS)[number], string> = {
  site_health: '/health',
  internal_status: '/api/status',
};

/**
 * Riga sintetica del monitor cieco. Regola: fallisce quando la verifica del browser di Vercel
 * (Attack Challenge Mode, o una regola del firewall che la usa) ha fermato in questo giro
 * /api/status, l'unico controllo che vede database, accesso e gli altri controlli interni; che
 * /health risponda o no cambia solo il testo, perché /health è statico e non vede il database.
 * Non serve che tutte le altre righe siano fermate: una pagina con un errore di rete passeggero
 * non deve azzerare il conto dei giri; se invece /api/status riceve una risposta vera, un guasto
 * resta visibile e la riga passa (una protezione su poche pagine non basta).
 * Non avvisa subito: FIREWALL_BLIND_ALERT_AFTER giri di fila (alertAfter), poi promemoria
 * giornaliero come gli altri; torna a funzionare al primo giro con risposte vere.
 * La durata viene dallo stato del giro precedente (failingSince di questa riga).
 */
export function firewallBlindResult(
  results: readonly CheckResult[],
  previousState: unknown,
  now: Date,
): CheckResult {
  const base = {
    id: FIREWALL_BLIND_ID,
    label: labelForId(FIREWALL_BLIND_ID),
    critical: false,
    alertAfter: FIREWALL_BLIND_ALERT_AFTER,
    ms: null,
  };
  const challenged = new Set(
    results.filter((result) => result.firewallChallenged === true).map((result) => result.id),
  );
  if (!challenged.has(FIREWALL_DECISIVE)) {
    if (challenged.size === 0) {
      return { ...base, status: 'ok', detail: 'Il firewall di Vercel non ferma il monitor' };
    }
    const count = challenged.size === 1 ? '1 controllo' : `${challenged.size} controlli`;
    const free = FIREWALL_SENTINELS.filter((id) => !challenged.has(id));
    const paths = free.map((id) => SENTINEL_PATHS[id]).join(' e ');
    return {
      ...base,
      status: 'ok',
      detail: `Il firewall di Vercel ferma ${count}, ma non ${paths}: un guasto vero resta visibile`,
    };
  }
  const previous = normalizeState(previousState).checks[FIREWALL_BLIND_ID]?.failingSince;
  const since =
    previous && Date.parse(previous) <= now.getTime() ? new Date(previous) : new Date(now);
  // /health fermato anche lui: non si vede niente. /health libero: si vede solo che l'app è su.
  const whole = challenged.has('site_health');
  const what = whole ? 'il sito' : 'database e accesso';
  const stopped = whole ? 'anche /health e /api/status' : '/api/status';
  const missed = whole ? 'Un guasto vero' : 'Un loro guasto';
  return {
    ...base,
    status: 'fail',
    detail:
      `Il monitor non può verificare ${what} da ${describeDuration(now.getTime() - since.getTime())} ` +
      `(dal ${formatRome(since)}): la protezione anti-attacco di Vercel (Attack Challenge Mode) ` +
      `ferma ${stopped}. ${missed} non manderebbe email. Per spegnerla: ` +
      'Vercel → Firewall → Attack Challenge Mode, o aspetta che scada.',
  };
}

/** Giri di fila con errore prima della prima email: alertAfter se valido, altrimenti 1 o 2. */
export function alertThreshold(result: Pick<CheckResult, 'critical' | 'alertAfter'>): number {
  const custom = result.alertAfter;
  if (typeof custom === 'number' && Number.isInteger(custom) && custom >= 1) {
    return Math.min(custom, 1_000);
  }
  return result.critical ? 1 : 2;
}

/**
 * Critical ids alert on the first failing run, the others after 2 consecutive failing runs (a
 * result with a valid alertAfter, e.g. the blind monitor, after that many runs instead); a
 * check still failing re-alerts once every 24 hours (at once if its last alert is dated in the
 * future, which only a corrupt state can do); a check that passes (or only warns) again is
 * removed from the state and reported as recovered. An alerted check that breaks again within
 * FLAP_WINDOW_MS of recovering keeps its previous alert time, so a flapping check emails once a
 * day, not on every failure. When this run alerts anyway, every reminder at least
 * BATCH_REMINDER_MS old rides along, so daily reminders arrive in one email. Internal ids missing
 * from this run recover only when /api/status answered (otherwise they are unknown and kept);
 * other missing ids belong to checks that no longer exist and are forgotten.
 * Una riga fermata dalla verifica del browser di Vercel (firewallChallenged) non ha avuto una
 * risposta vera: il suo stato resta com'era (niente "tornato a funzionare", niente conto, niente
 * email; ne parla la riga del monitor cieco), e se è /api/status i controlli interni restano
 * ignoti, quindi conservati.
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
    if (result.firewallChallenged === true) {
      // Fermato dalla verifica di Vercel: nessuna risposta vera, quindi un guasto in corso non è
      // guarito né peggiorato. Resta com'era (stesso inizio, stesso conto, stessa ultima email).
      if (before) state.checks[result.id] = before;
      continue;
    }
    if (result.status !== 'fail') {
      if (before) recover(result.id, result.label, before);
      continue;
    }
    const flap = before ? undefined : recentBefore[result.id];
    const flapAge = flap ? ageOf(flap.recoveredAt) : -1;
    const inherited = flap && flapAge >= 0 && flapAge < FLAP_WINDOW_MS ? flap.lastAlertAt : null;
    const consecutive = (before?.consecutive ?? 0) + 1;
    const failingSince = before?.failingSince ?? nowIso;
    const threshold = alertThreshold(result);
    let lastAlertAt = before?.lastAlertAt ?? inherited;
    let kind: AlertItem['kind'] | null = null;
    if (consecutive >= threshold) {
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
      ongoing.push({ ...item, alerted: lastAlertAt !== null, alertAfter: threshold });
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
      const { alerted: _alerted, alertAfter: _alertAfter, ...rest } = item;
      alerts.push({ ...rest, kind: 'reminder' });
    } else {
      quiet.push(item);
    }
  }

  // /api/status fermato dalla verifica di Vercel non risponde: i controlli interni restano ignoti.
  const internalKnown = results.some(
    (result) =>
      (result.id === 'internal_status' &&
        result.status !== 'fail' &&
        result.firewallChallenged !== true) ||
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
    return '❌ Problemi già segnalati o in attesa di conferma nei prossimi controlli';
  }
  if (report.results.some((result) => result.status === 'warn')) {
    return '⚠️ Tutto funziona, con qualche avviso';
  }
  return '✅ Tutto funziona';
}

function since(iso: string): string {
  return `dal ${formatRome(new Date(iso))}`;
}

/** Nota di un problema non ancora segnalato: quanti giri mancano alla prima email. */
function pendingNote(item: OngoingItem): string {
  const remaining = Math.max(1, item.alertAfter - item.consecutive);
  const streak = item.consecutive === 1 ? 'primo errore' : `${item.consecutive} controlli di fila`;
  const when =
    remaining === 1
      ? 'email solo se si ripete al prossimo controllo'
      : `email solo se continua per altri ${remaining} controlli`;
  return `${streak}: ${when}`;
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
      : pendingNote(item);
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
    now: () => new Date(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    retryDelayMs: RETRY_DELAY_MS,
    tlsProbe: (request) => probeTls(request),
    resolveCaa: resolveCaaRecords,
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
  const checks = await runAllChecks(createDeps(baseUrl, overrides));
  const finishedAt = new Date();
  // Il monitor cieco va in cima: quando fallisce spiega tutti gli avvisi qui sotto.
  const results = [firewallBlindResult(checks, previous.raw, finishedAt), ...checks];
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
