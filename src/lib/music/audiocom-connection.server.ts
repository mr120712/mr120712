// @polsia:user-owned — collegamento di Solco ad audio.com (API pubblica di Muse Group).
//
// Come funziona (pagina /admin/audiocom, «Collega audio.com»):
// 1. L'API di audio.com accetta SOLO OAuth 2.1 Authorization Code con PKCE (S256): non esistono
//    credenziali "client credentials". Serve quindi UN account audio.com, collegato una volta da un
//    amministratore verificato; le ricerche di tutti gli ascoltatori usano quel collegamento (dal
//    server: nessun ascoltatore vede o usa i token).
// 2. La prima volta il server registra Solco come client PUBBLICO con la registrazione dinamica
//    (POST https://api.audio.com/auth/client, token_endpoint_auth_method "none", redirect_uri =
//    <NEXT_PUBLIC_APP_URL>/api/admin/audiocom/callback) e salva il client_id; si registra di nuovo
//    solo se cambia l'indirizzo dell'app.
// 3. state + code_verifier stanno in un cookie HttpOnly, Secure (in https), SameSite=Lax, di 10
//    minuti, CIFRATO e autenticato (AES-256-GCM: manomesso o scaduto → rifiutato), limitato a
//    /api/admin/audiocom. Al ritorno il server ricontrolla la sessione admin (stesso admin), lo
//    state in tempo costante e scambia il codice con il code_verifier.
// 4. access + refresh token si salvano CIFRATI nella riga unica AudioComConnection con la scadenza.
//    Il rinnovo (grant refresh_token; audio.com può ruotare il refresh token) è single-flight nel
//    processo e fatto da una sola istanza alla volta (lease su refreshLockedUntil + tokenVersion):
//    una risposta arrivata tardi non sovrascrive token più nuovi e un refresh token già ruotato da
//    un'altra istanza non fa scollegare l'account.
// 5. «Scollega» cancella i token (il client registrato resta).
//
// IMPORTANTE: prima di collegare, l'amministratore deve verificare che i termini d'uso dell'API di
// audio.com consentano questo uso (ricerca per tutti gli utenti di un servizio commerciale con un
// solo account, link e player ufficiale incorporato). Il codice non può verificarlo.
//
// I token non compaiono mai in una risposta né in un log (nei log solo nomi di errore o codici).
import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  AUDIOCOM_ERROR_CODES,
  type AudioComConnectionStatus,
  type AudioComErrorCode,
} from '@/lib/contracts/audiocom';
import { prisma } from '@/lib/db';
import {
  hasAudioComKey,
  openAudioComValue,
  sealAudioComValue,
} from '@/lib/music/audiocom-crypto.server';
import { codeChallengeS256 } from '@/lib/spotify/pkce';
import { redirectOrigin } from '@/lib/tiktok/config.server';

export const AUDIOCOM_API_ORIGIN = 'https://api.audio.com';
export const AUDIOCOM_AUTHORIZE_URL = `${AUDIOCOM_API_ORIGIN}/auth/authorize`;
export const AUDIOCOM_TOKEN_URL = `${AUDIOCOM_API_ORIGIN}/auth/token`;
export const AUDIOCOM_REGISTRATION_URL = `${AUDIOCOM_API_ORIGIN}/auth/client`;
/** Audio dell'account collegato: solo per leggere il nome dell'account (best effort). */
export const AUDIOCOM_AUDIO_LIST_URL = `${AUDIOCOM_API_ORIGIN}/v1/audio/list`;
export const AUDIOCOM_SCOPE = 'public';
export const AUDIOCOM_CLIENT_NAME = 'Solco';

export const AUDIOCOM_ADMIN_PAGE = '/admin/audiocom';
export const AUDIOCOM_CALLBACK_PATH = '/api/admin/audiocom/callback';
export const AUDIOCOM_OAUTH_COOKIE = 'solco_audiocom_oauth';
export const AUDIOCOM_OAUTH_COOKIE_PATH = '/api/admin/audiocom';
export const AUDIOCOM_OAUTH_MAX_AGE_SECONDS = 600;

/** Riga unica del collegamento. */
export const AUDIOCOM_CONNECTION_ID = 'audiocom';
/** Si rinnova l'access token quando scade entro questa finestra. */
export const AUDIOCOM_REFRESH_MARGIN_MS = 60_000;
/** Durata del lease del rinnovo: oltre, un'altra istanza può riprovare. */
export const AUDIOCOM_REFRESH_LEASE_MS = 15_000;
/** Stato del token tenuto in memoria prima di riguardare il database (Scollega da altre istanze). */
const MEMORY_TTL_MS = 30_000;
/** Attesa del rinnovo fatto da un'altra istanza: tentativi × intervallo. */
const LEASE_WAIT_ATTEMPTS = 4;
const LEASE_WAIT_MS = 400;
/** Scadenza assunta se audio.com non manda expires_in, e limiti di quella dichiarata. */
const DEFAULT_EXPIRES_IN_SECONDS = 3_600;
const MIN_EXPIRES_IN_SECONDS = 60;
const MAX_EXPIRES_IN_SECONDS = 30 * 86_400;
const REQUEST_TIMEOUT_MS = 10_000;
const ACCOUNT_TIMEOUT_MS = 4_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const COOKIE_CONTEXT = 'audiocom-oauth-cookie:v1';
const COOKIE_FUTURE_SKEW_MS = 60_000;
/** Un errore registrato al massimo una volta al minuto per codice (niente scritture a raffica). */
const ERROR_WRITE_INTERVAL_MS = 60_000;

const accessContext = (clientId: string) => `audiocom-access:v1:${clientId}`;
const refreshContext = (clientId: string) => `audiocom-refresh:v1:${clientId}`;

export class AudioComError extends Error {
  constructor(
    readonly reason: 'rate_limited' | 'reauth' | 'unavailable' | 'invalid_response' | 'bad_request',
    readonly status?: number,
  ) {
    super(`audio.com: ${reason}`);
    this.name = 'AudioComError';
  }
}

// ---------------------------------------------------------------------------------------------
// Configurazione

export type AudioComConfig = {
  /** Origine pubblica di Solco (https; http solo per 127.0.0.1 in sviluppo). */
  appOrigin: string;
  redirectUri: string;
  secureCookies: boolean;
};

/** Configurazione del collegamento, o null (indirizzo dell'app non valido o chiave assente). */
export function audioComConfig(): AudioComConfig | null {
  const appOrigin = redirectOrigin(process.env.NEXT_PUBLIC_APP_URL);
  if (!appOrigin || !hasAudioComKey()) return null;
  return {
    appOrigin,
    redirectUri: `${appOrigin}${AUDIOCOM_CALLBACK_PATH}`,
    secureCookies: appOrigin.startsWith('https:'),
  };
}

// ---------------------------------------------------------------------------------------------
// HTTP verso api.audio.com (timeout, niente redirect, corpo limitato)

export type AudioComHttpResult = { ok: boolean; status: number; headers: Headers; body: unknown };

/** Richiesta ad audio.com: nessun redirect seguito, tempo massimo, JSON letto con un tetto. */
export async function audioComRequest(
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<AudioComHttpResult> {
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new AudioComError('invalid_response', response.status);
  }
  const text = await response.text();
  if (text.length > maxBytes) throw new AudioComError('invalid_response', response.status);
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { ok: response.ok, status: response.status, headers: response.headers, body };
}

// ---------------------------------------------------------------------------------------------
// Registrazione dinamica del client (una volta)

const RegistrationResponseSchema = z
  .object({
    client_id: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[\x21-\x7e]+$/),
  })
  .passthrough();

let registering: Promise<string> | null = null;

/** client_id di Solco presso audio.com: quello salvato, o una registrazione nuova (single-flight). */
export async function ensureAudioComClient(config: AudioComConfig): Promise<string> {
  const row = await prisma.audioComConnection.findUnique({
    where: { id: AUDIOCOM_CONNECTION_ID },
    select: { clientId: true, redirectUri: true },
  });
  if (row?.clientId && row.redirectUri === config.redirectUri) return row.clientId;
  if (!registering) {
    registering = registerClient(config).finally(() => {
      registering = null;
    });
  }
  return registering;
}

async function registerClient(config: AudioComConfig): Promise<string> {
  const result = await audioComRequest(AUDIOCOM_REGISTRATION_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: AUDIOCOM_CLIENT_NAME,
      client_uri: config.appOrigin,
      redirect_uris: [config.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: AUDIOCOM_SCOPE,
    }),
  });
  if (!result.ok) {
    if (result.status === 429) throw new AudioComError('rate_limited', 429);
    throw new AudioComError(result.status >= 500 ? 'unavailable' : 'bad_request', result.status);
  }
  const parsed = RegistrationResponseSchema.safeParse(result.body);
  if (!parsed.success) throw new AudioComError('invalid_response', result.status);
  const clientId = parsed.data.client_id;
  // Un client nuovo: i token del client precedente (se c'erano) non valgono più.
  const cleared = {
    clientId,
    redirectUri: config.redirectUri,
    accessToken: null,
    refreshToken: null,
    accessExpiresAt: null,
    scope: null,
    accountName: null,
    connectedAt: null,
    refreshLockedUntil: null,
  };
  await prisma.audioComConnection.upsert({
    where: { id: AUDIOCOM_CONNECTION_ID },
    create: { id: AUDIOCOM_CONNECTION_ID, ...cleared },
    update: { ...cleared, tokenVersion: { increment: 1 } },
  });
  resetAudioComConnectionMemory();
  return clientId;
}

// ---------------------------------------------------------------------------------------------
// Cookie OAuth: { state, verifier, userId, clientId, issuedAt }, cifrato, HttpOnly, 10 minuti

export type AudioComOAuthCookie = {
  state: string;
  verifier: string;
  userId: string;
  clientId: string;
  issuedAt: number;
};

const OAuthCookieSchema = z
  .object({
    s: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    v: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    u: z.string().min(1).max(200),
    c: z.string().min(1).max(256),
    t: z.number().int().nonnegative(),
  })
  .strict();

export function sealAudioComOAuthCookie(cookie: AudioComOAuthCookie): string {
  return sealAudioComValue(
    JSON.stringify({
      s: cookie.state,
      v: cookie.verifier,
      u: cookie.userId,
      c: cookie.clientId,
      t: cookie.issuedAt,
    }),
    COOKIE_CONTEXT,
  );
}

export type OpenedAudioComOAuthCookie =
  | { ok: true; cookie: AudioComOAuthCookie }
  | { ok: false; reason: 'invalid' | 'expired' };

export function openAudioComOAuthCookie(
  sealed: string,
  now = Date.now(),
): OpenedAudioComOAuthCookie {
  const plaintext = openAudioComValue(sealed, COOKIE_CONTEXT);
  if (!plaintext) return { ok: false, reason: 'invalid' };
  let json: unknown;
  try {
    json = JSON.parse(plaintext);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const parsed = OAuthCookieSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: 'invalid' };
  const { s, v, u, c, t } = parsed.data;
  if (t > now + COOKIE_FUTURE_SKEW_MS) return { ok: false, reason: 'invalid' };
  if (now - t > AUDIOCOM_OAUTH_MAX_AGE_SECONDS * 1000) return { ok: false, reason: 'expired' };
  return { ok: true, cookie: { state: s, verifier: v, userId: u, clientId: c, issuedAt: t } };
}

/** Confronto in tempo costante dello `state` ricevuto con quello del cookie. */
export function audioComStatesMatch(received: string | null, expected: string): boolean {
  if (!received || received.length > 512) return false;
  const a = createHash('sha256').update(received).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function cookieAttributes(config: AudioComConfig, maxAge: number): string[] {
  return [
    `Path=${AUDIOCOM_OAUTH_COOKIE_PATH}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(config.secureCookies ? ['Secure'] : []),
  ];
}

export function audioComOAuthCookieHeader(value: string, config: AudioComConfig): string {
  return [
    `${AUDIOCOM_OAUTH_COOKIE}=${value}`,
    ...cookieAttributes(config, AUDIOCOM_OAUTH_MAX_AGE_SECONDS),
  ].join('; ');
}

export function clearAudioComOAuthCookieHeader(config: AudioComConfig): string {
  return [`${AUDIOCOM_OAUTH_COOKIE}=`, ...cookieAttributes(config, 0)].join('; ');
}

export function readAudioComOAuthCookie(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === AUDIOCOM_OAUTH_COOKIE) {
      const value = part.slice(index + 1).trim();
      return value || null;
    }
  }
  return null;
}

/** Indirizzo di autorizzazione di audio.com (PKCE S256, scope "public"). */
export async function audioComAuthorizeUrl(input: {
  config: AudioComConfig;
  clientId: string;
  state: string;
  verifier: string;
}): Promise<string> {
  const url = new URL(AUDIOCOM_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.config.redirectUri,
    scope: AUDIOCOM_SCOPE,
    state: input.state,
    code_challenge: await codeChallengeS256(input.verifier),
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

// ---------------------------------------------------------------------------------------------
// Endpoint dei token (form-encoded, client pubblico: solo client_id)

export type AudioComTokens = {
  accessToken: string;
  /** null se audio.com non ne manda uno (allora alla scadenza va ricollegato). */
  refreshToken: string | null;
  accessExpiresAt: Date;
  scope: string | null;
};

const TokenResponseSchema = z
  .object({
    access_token: z.string().min(1).max(8_192),
    token_type: z.string().max(40).optional(),
    expires_in: z.number().finite().positive().optional(),
    refresh_token: z.string().min(1).max(8_192).optional(),
    scope: z.string().max(1_000).optional(),
  })
  .passthrough();

const TokenErrorSchema = z.object({ error: z.string().max(100) }).passthrough();

async function tokenRequest(params: Record<string, string>, now: number): Promise<AudioComTokens> {
  const result = await audioComRequest(AUDIOCOM_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  });
  if (result.ok) {
    const parsed = TokenResponseSchema.safeParse(result.body);
    if (!parsed.success) throw new AudioComError('invalid_response', result.status);
    const data = parsed.data;
    if (data.token_type && data.token_type.toLowerCase() !== 'bearer') {
      throw new AudioComError('invalid_response', result.status);
    }
    const expiresIn = Math.min(
      MAX_EXPIRES_IN_SECONDS,
      Math.max(MIN_EXPIRES_IN_SECONDS, Math.floor(data.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS)),
    );
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      accessExpiresAt: new Date(now + expiresIn * 1000),
      scope: data.scope ?? null,
    };
  }
  const code = TokenErrorSchema.safeParse(result.body);
  const error = code.success ? code.data.error : null;
  if (result.status === 429) throw new AudioComError('rate_limited', 429);
  // Codice o refresh token scaduto, revocato o già usato, client sconosciuto → ricollegare.
  if (error === 'invalid_grant' || error === 'invalid_client' || result.status === 401) {
    throw new AudioComError('reauth', result.status);
  }
  if (result.status >= 500) throw new AudioComError('unavailable', result.status);
  throw new AudioComError('bad_request', result.status);
}

/** Scambia il codice di autorizzazione (con il code_verifier PKCE) con i token. */
export function exchangeAudioComCode(input: {
  clientId: string;
  redirectUri: string;
  code: string;
  verifier: string;
  now?: number;
}): Promise<AudioComTokens> {
  return tokenRequest(
    {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.verifier,
    },
    input.now ?? Date.now(),
  );
}

function refreshAudioComTokens(clientId: string, refreshToken: string, now: number) {
  return tokenRequest(
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId },
    now,
  );
}

const AccountAudioSchema = z
  .object({
    author_name: z.string().max(200).optional(),
    username: z.string().max(200).optional(),
  })
  .passthrough();

/**
 * Nome dell'account collegato, se l'account ha almeno un audio (l'API non ha un endpoint
 * "chi sono": si legge l'autore dell'audio più recente). Best effort: null in ogni altro caso.
 */
export async function fetchAudioComAccountName(accessToken: string): Promise<string | null> {
  try {
    const url = new URL(AUDIOCOM_AUDIO_LIST_URL);
    url.searchParams.set('per-page', '1');
    const result = await audioComRequest(
      url.toString(),
      { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } },
      ACCOUNT_TIMEOUT_MS,
    );
    if (!result.ok || !Array.isArray(result.body)) return null;
    const first = AccountAudioSchema.safeParse(result.body[0]);
    if (!first.success) return null;
    const name = (first.data.author_name || first.data.username || '').trim();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: toglie i caratteri di controllo.
    const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100);
    return clean || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Collegamento salvato (riga unica, token cifrati)

/** Salva i token del collegamento appena fatto (cifrati) e azzera errori e lease. */
export async function saveAudioComConnection(input: {
  clientId: string;
  redirectUri: string;
  tokens: AudioComTokens;
  accountName: string | null;
  now?: Date;
}): Promise<void> {
  const data = {
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    accessToken: sealAudioComValue(input.tokens.accessToken, accessContext(input.clientId)),
    refreshToken: input.tokens.refreshToken
      ? sealAudioComValue(input.tokens.refreshToken, refreshContext(input.clientId))
      : null,
    accessExpiresAt: input.tokens.accessExpiresAt,
    scope: input.tokens.scope,
    accountName: input.accountName,
    connectedAt: input.now ?? new Date(),
    refreshLockedUntil: null,
    lastError: null,
    lastErrorAt: null,
  };
  await prisma.audioComConnection.upsert({
    where: { id: AUDIOCOM_CONNECTION_ID },
    create: { id: AUDIOCOM_CONNECTION_ID, ...data, tokenVersion: 1 },
    update: { ...data, tokenVersion: { increment: 1 } },
  });
  resetAudioComConnectionMemory();
}

/** «Scollega»: cancella i token (il client registrato resta, così non si registra di nuovo). */
export async function disconnectAudioCom(): Promise<void> {
  await prisma.audioComConnection.updateMany({
    where: { id: AUDIOCOM_CONNECTION_ID },
    data: {
      accessToken: null,
      refreshToken: null,
      accessExpiresAt: null,
      scope: null,
      accountName: null,
      connectedAt: null,
      refreshLockedUntil: null,
      lastError: null,
      lastErrorAt: null,
      tokenVersion: { increment: 1 },
    },
  });
  resetAudioComConnectionMemory();
}

function knownErrorCode(value: string | null | undefined): AudioComErrorCode | null {
  return (AUDIOCOM_ERROR_CODES as readonly string[]).includes(value ?? '')
    ? (value as AudioComErrorCode)
    : null;
}

/** Stato per la pagina admin (mai i token). */
export async function audioComConnectionStatus(
  now = Date.now(),
): Promise<AudioComConnectionStatus> {
  const config = audioComConfig();
  if (!config) {
    return {
      configured: false,
      connected: false,
      needsReconnect: false,
      clientRegistered: false,
      accountName: null,
      connectedAt: null,
      lastError: null,
      lastErrorAt: null,
      redirectUri: null,
    };
  }
  const row = await prisma.audioComConnection.findUnique({
    where: { id: AUDIOCOM_CONNECTION_ID },
    select: {
      clientId: true,
      redirectUri: true,
      accessToken: true,
      refreshToken: true,
      accessExpiresAt: true,
      accountName: true,
      connectedAt: true,
      lastError: true,
      lastErrorAt: true,
    },
  });
  const accessUsable = Boolean(
    row?.accessToken && row.accessExpiresAt && row.accessExpiresAt.getTime() > now,
  );
  const connected = Boolean(row?.clientId && row.accessToken && (row.refreshToken || accessUsable));
  const lastError = knownErrorCode(row?.lastError);
  return {
    configured: true,
    connected,
    needsReconnect: lastError === 'reauth_required' || (!connected && Boolean(row?.connectedAt)),
    clientRegistered: Boolean(row?.clientId && row.redirectUri === config.redirectUri),
    accountName: connected ? (row?.accountName ?? null) : null,
    connectedAt: connected ? (row?.connectedAt?.toISOString() ?? null) : null,
    lastError,
    lastErrorAt: lastError ? (row?.lastErrorAt?.toISOString() ?? null) : null,
    redirectUri: config.redirectUri,
  };
}

const lastErrorWrites = new Map<AudioComErrorCode, number>();

/** Registra l'ultimo problema (codice fisso), al massimo una volta al minuto per codice. */
export async function recordAudioComError(
  code: AudioComErrorCode,
  now = Date.now(),
): Promise<void> {
  const last = lastErrorWrites.get(code) ?? 0;
  if (now - last < ERROR_WRITE_INTERVAL_MS) return;
  lastErrorWrites.set(code, now);
  try {
    await prisma.audioComConnection.updateMany({
      where: { id: AUDIOCOM_CONNECTION_ID },
      data: { lastError: code, lastErrorAt: new Date(now) },
    });
  } catch {
    // Solo diagnostica: un errore qui non cambia la ricerca.
  }
}

// ---------------------------------------------------------------------------------------------
// Access token per la ricerca (in memoria per poco, rinnovo single-flight e a lease)

export type AudioComAccess =
  | { ok: true; token: string; version: number }
  | { ok: false; reason: 'disconnected' | 'unavailable' };

type MemoryToken = { token: string; version: number; expiresAt: number; checkedUntil: number };

let memoryToken: MemoryToken | null = null;
let disconnectedUntil = 0;
let accessInFlight: Promise<AudioComAccess> | null = null;

/** Dimentica lo stato in memoria (dopo collega/scollega, e nei test). */
export function resetAudioComConnectionMemory(): void {
  memoryToken = null;
  disconnectedUntil = 0;
  lastErrorWrites.clear();
}

/**
 * Access token valido per la ricerca, rinnovato se scade entro 60 s. Non lancia mai: senza
 * collegamento → `disconnected`, con un problema temporaneo → `unavailable` (la ricerca prosegue
 * con le altre fonti). Chiamate contemporanee nello stesso processo condividono un solo lavoro.
 */
export function getAudioComAccessToken(now = Date.now()): Promise<AudioComAccess> {
  if (
    memoryToken &&
    memoryToken.checkedUntil > now &&
    memoryToken.expiresAt - AUDIOCOM_REFRESH_MARGIN_MS > now
  ) {
    return Promise.resolve({ ok: true, token: memoryToken.token, version: memoryToken.version });
  }
  if (disconnectedUntil > now) return Promise.resolve({ ok: false, reason: 'disconnected' });
  if (!accessInFlight) {
    accessInFlight = loadOrRefreshAccess()
      .catch((error: unknown): AudioComAccess => {
        logProblem('token', error);
        return { ok: false, reason: 'unavailable' };
      })
      .finally(() => {
        accessInFlight = null;
      });
  }
  return accessInFlight;
}

type ConnectionRow = {
  clientId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  tokenVersion: number;
};

function readRow(): Promise<ConnectionRow | null> {
  return prisma.audioComConnection.findUnique({
    where: { id: AUDIOCOM_CONNECTION_ID },
    select: {
      clientId: true,
      accessToken: true,
      refreshToken: true,
      accessExpiresAt: true,
      tokenVersion: true,
    },
  });
}

function remember(token: string, version: number, expiresAt: number): AudioComAccess {
  memoryToken = { token, version, expiresAt, checkedUntil: Date.now() + MEMORY_TTL_MS };
  disconnectedUntil = 0;
  return { ok: true, token, version };
}

function disconnected(): AudioComAccess {
  memoryToken = null;
  disconnectedUntil = Date.now() + MEMORY_TTL_MS;
  return { ok: false, reason: 'disconnected' };
}

/** L'access token della riga se si decifra e vale ancora per più del margine. */
function usableAccess(row: ConnectionRow, marginMs = AUDIOCOM_REFRESH_MARGIN_MS): string | null {
  if (!row.clientId || !row.accessToken || !row.accessExpiresAt) return null;
  if (row.accessExpiresAt.getTime() - marginMs <= Date.now()) return null;
  return openAudioComValue(row.accessToken, accessContext(row.clientId));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadOrRefreshAccess(): Promise<AudioComAccess> {
  const row = await readRow();
  if (!row?.clientId || !row.accessToken) return disconnected();
  const access = usableAccess(row);
  if (access && row.accessExpiresAt) {
    return remember(access, row.tokenVersion, row.accessExpiresAt.getTime());
  }

  const refreshToken = row.refreshToken
    ? openAudioComValue(row.refreshToken, refreshContext(row.clientId))
    : null;
  if (!refreshToken) {
    // Niente refresh token (o non decifrabile): finché l'access token non scade del tutto si usa,
    // poi serve ricollegare.
    const lastChance = usableAccess(row, 0);
    if (lastChance && row.accessExpiresAt) {
      return remember(lastChance, row.tokenVersion, row.accessExpiresAt.getTime());
    }
    await clearTokens(row.tokenVersion);
    return disconnected();
  }

  // Lease: una sola istanza rinnova (le altre aspettano il risultato nel database).
  const now = Date.now();
  const lease = await prisma.audioComConnection.updateMany({
    where: {
      id: AUDIOCOM_CONNECTION_ID,
      tokenVersion: row.tokenVersion,
      OR: [{ refreshLockedUntil: null }, { refreshLockedUntil: { lt: new Date(now) } }],
    },
    data: { refreshLockedUntil: new Date(now + AUDIOCOM_REFRESH_LEASE_MS) },
  });
  if (lease.count === 0) return waitForOtherRefresh(row.tokenVersion);

  let tokens: AudioComTokens;
  try {
    tokens = await refreshAudioComTokens(row.clientId, refreshToken, Date.now());
  } catch (error) {
    if (error instanceof AudioComError && error.reason === 'reauth') {
      // Il refresh token è stato ruotato da un'altra istanza nel frattempo? Allora si usa il nuovo.
      const latest = await readRow();
      if (latest && latest.tokenVersion !== row.tokenVersion) {
        const fresh = usableAccess(latest);
        if (fresh && latest.accessExpiresAt) {
          return remember(fresh, latest.tokenVersion, latest.accessExpiresAt.getTime());
        }
        return { ok: false, reason: 'unavailable' };
      }
      await clearTokens(row.tokenVersion);
      await recordAudioComError('reauth_required');
      return disconnected();
    }
    // Problema temporaneo: libera il lease; l'access token vecchio vale finché non scade davvero.
    await prisma.audioComConnection
      .updateMany({
        where: { id: AUDIOCOM_CONNECTION_ID, tokenVersion: row.tokenVersion },
        data: { refreshLockedUntil: null },
      })
      .catch(() => undefined);
    await recordAudioComError(
      error instanceof AudioComError && error.reason === 'rate_limited'
        ? 'rate_limited'
        : 'refresh_failed',
    );
    const stillValid = usableAccess(row, 0);
    if (stillValid && row.accessExpiresAt) {
      return remember(stillValid, row.tokenVersion, row.accessExpiresAt.getTime());
    }
    return { ok: false, reason: 'unavailable' };
  }

  // Rotazione: se audio.com non manda un refresh token nuovo si tiene quello di prima.
  const nextRefresh = tokens.refreshToken ?? refreshToken;
  const saved = await prisma.audioComConnection.updateMany({
    where: { id: AUDIOCOM_CONNECTION_ID, tokenVersion: row.tokenVersion },
    data: {
      accessToken: sealAudioComValue(tokens.accessToken, accessContext(row.clientId)),
      refreshToken: sealAudioComValue(nextRefresh, refreshContext(row.clientId)),
      accessExpiresAt: tokens.accessExpiresAt,
      ...(tokens.scope ? { scope: tokens.scope } : {}),
      tokenVersion: { increment: 1 },
      refreshLockedUntil: null,
      lastError: null,
      lastErrorAt: null,
    },
  });
  if (saved.count === 0) {
    // Scollegato (o ricollegato) mentre si rinnovava: vale ciò che c'è ora nel database.
    const latest = await readRow();
    if (!latest?.accessToken) return disconnected();
    const fresh = usableAccess(latest);
    if (fresh && latest.accessExpiresAt) {
      return remember(fresh, latest.tokenVersion, latest.accessExpiresAt.getTime());
    }
    return { ok: false, reason: 'unavailable' };
  }
  return remember(tokens.accessToken, row.tokenVersion + 1, tokens.accessExpiresAt.getTime());
}

async function waitForOtherRefresh(version: number): Promise<AudioComAccess> {
  for (let attempt = 0; attempt < LEASE_WAIT_ATTEMPTS; attempt += 1) {
    await sleep(LEASE_WAIT_MS);
    const latest = await readRow();
    if (!latest?.accessToken) return disconnected();
    if (latest.tokenVersion !== version) {
      const fresh = usableAccess(latest);
      if (fresh && latest.accessExpiresAt) {
        return remember(fresh, latest.tokenVersion, latest.accessExpiresAt.getTime());
      }
    }
  }
  return { ok: false, reason: 'unavailable' };
}

async function clearTokens(version: number): Promise<void> {
  await prisma.audioComConnection.updateMany({
    where: { id: AUDIOCOM_CONNECTION_ID, tokenVersion: version },
    data: {
      accessToken: null,
      refreshToken: null,
      accessExpiresAt: null,
      refreshLockedUntil: null,
      tokenVersion: { increment: 1 },
    },
  });
}

/**
 * audio.com ha rifiutato l'access token (401 alla ricerca): lo si considera scaduto, così la
 * prossima ricerca lo rinnova. Solo se nel frattempo nessuno lo ha già cambiato.
 */
export async function markAudioComAccessRejected(version: number): Promise<void> {
  if (memoryToken?.version === version) memoryToken = null;
  try {
    await prisma.audioComConnection.updateMany({
      where: { id: AUDIOCOM_CONNECTION_ID, tokenVersion: version },
      data: { accessExpiresAt: new Date(0) },
    });
  } catch {
    // Al più la prossima ricerca riprova con lo stesso token e riceve di nuovo 401.
  }
}

function logProblem(what: string, error: unknown) {
  // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore (mai token).
  console.warn(
    `[audiocom] ${what}:`,
    error instanceof AudioComError
      ? error.reason
      : error instanceof Error
        ? error.name
        : typeof error,
  );
}
