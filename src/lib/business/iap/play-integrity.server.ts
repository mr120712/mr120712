// @polsia:user-owned — Play Integrity API: verifica lato server che un acquisto Android arrivi
// dall'app AUTENTICA di Solco, su un dispositivo integro (non un bot, un emulatore manomesso o
// un'app riconfezionata). L'app chiede un "integrity token" a Google Play al momento dell'acquisto e
// lo manda insieme al purchaseToken; qui lo DECODIFICHIAMO con l'API Play Integrity
// (playintegrity.googleapis.com) usando lo stesso service account del Play Developer, e controlliamo
// i verdetti. È una difesa IN PIÙ: lo stato autorevole dell'abbonamento resta quello letto dallo
// store (google-play.server.ts); questo aggiunge l'attestazione di app + dispositivo. Nessun segreto
// nel codice: la chiave arriva dalla config (env del service account), mai loggata.
import 'server-only';
import { createPrivateKey, sign } from 'node:crypto';
import type { GooglePlayConfig } from '@/lib/business/iap/config.server';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PLAY_INTEGRITY_SCOPE = 'https://www.googleapis.com/auth/playintegrity';
const PLAY_INTEGRITY_API = 'https://playintegrity.googleapis.com/v1';
const REQUEST_TIMEOUT_MS = 10_000;
/** Un token Integrity vale pochi minuti: oltre questa età lo consideriamo vecchio (anti-replay). */
const MAX_TOKEN_AGE_MS = 10 * 60 * 1000;

type FetchLike = typeof fetch;
type Json = Record<string, unknown>;

export type IntegrityVerdict = {
  /** L'app è una versione riconosciuta, installata/aggiornata da Google Play. */
  appRecognized: boolean;
  /** Il dispositivo supera i controlli d'integrità (non rooted/manomesso). */
  deviceIntegrity: boolean;
  /** L'account possiede una licenza Play per l'app (diagnostica, non blocca). */
  licensed: boolean;
  packageName: string | null;
};

export type IntegrityResult =
  | { ok: true; verdict: IntegrityVerdict }
  // "hard": verdetto genuinamente negativo (app non riconosciuta, dispositivo non integro, pacchetto
  // sbagliato, token vecchio) → motivo di rifiuto SE l'enforcement è acceso.
  | { ok: false; hard: true; reason: string }
  // "soft": non abbiamo potuto verificare (token assente, rete, credenziali) → non puniamo l'acquirente.
  | { ok: false; hard: false; reason: string };

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/** Access token OAuth2 per l'API Play Integrity (scope diverso dal Play Developer). */
async function integrityAccessToken(
  config: GooglePlayConfig,
  fetcher: FetchLike,
  now: Date,
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: config.clientEmail,
      scope: PLAY_INTEGRITY_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat,
      exp: iat + 3600,
    }),
  );
  const signature = base64url(
    sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPrivateKey(config.privateKey)),
  );
  const assertion = `${header}.${payload}.${signature}`;
  const response = await fetcher(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok || typeof body.access_token !== 'string') {
    throw new Error('play_integrity_auth_failed');
  }
  return body.access_token;
}

/** Legge i verdetti dal payload decodificato e decide esito/durezza. */
export function readIntegrityVerdict(
  payload: Json,
  expectedPackage: string,
  now: Date = new Date(),
): IntegrityResult {
  const requestDetails = (payload.requestDetails ?? {}) as Json;
  const appIntegrity = (payload.appIntegrity ?? {}) as Json;
  const deviceIntegrity = (payload.deviceIntegrity ?? {}) as Json;
  const accountDetails = (payload.accountDetails ?? {}) as Json;

  const requestPackage =
    typeof requestDetails.requestPackageName === 'string'
      ? requestDetails.requestPackageName
      : null;
  if (requestPackage && requestPackage !== expectedPackage) {
    return { ok: false, hard: true, reason: 'package_mismatch' };
  }

  // Freschezza del token: timestampMillis entro MAX_TOKEN_AGE_MS da adesso.
  const ts = Number(requestDetails.timestampMillis);
  if (Number.isFinite(ts) && Math.abs(now.getTime() - ts) > MAX_TOKEN_AGE_MS) {
    return { ok: false, hard: true, reason: 'stale_token' };
  }

  const appPackage =
    typeof appIntegrity.packageName === 'string' ? appIntegrity.packageName : requestPackage;
  if (appPackage && appPackage !== expectedPackage) {
    return { ok: false, hard: true, reason: 'package_mismatch' };
  }

  const appRecognized =
    (typeof appIntegrity.appRecognitionVerdict === 'string'
      ? appIntegrity.appRecognitionVerdict
      : '') === 'PLAY_RECOGNIZED';
  const deviceVerdicts = Array.isArray(deviceIntegrity.deviceRecognitionVerdict)
    ? (deviceIntegrity.deviceRecognitionVerdict as unknown[])
    : [];
  const deviceOk =
    deviceVerdicts.includes('MEETS_DEVICE_INTEGRITY') ||
    deviceVerdicts.includes('MEETS_STRONG_INTEGRITY');
  const licensed =
    (typeof accountDetails.appLicensingVerdict === 'string'
      ? accountDetails.appLicensingVerdict
      : '') === 'LICENSED';

  if (!appRecognized || !deviceOk) {
    return {
      ok: false,
      hard: true,
      reason: !appRecognized ? 'app_unrecognized' : 'device_untrusted',
    };
  }
  return {
    ok: true,
    verdict: { appRecognized, deviceIntegrity: deviceOk, licensed, packageName: appPackage },
  };
}

/**
 * Decodifica e verifica un token Play Integrity. Esito "soft" (non blocca mai) quando non si è potuto
 * verificare: token assente, API irraggiungibile o credenziali non valide. Esito "hard" su un verdetto
 * genuinamente negativo. Inietta `fetcher`/`now` per i test; nessuna rete reale nei test.
 */
export async function verifyPlayIntegrityToken(
  token: string | null | undefined,
  config: GooglePlayConfig,
  fetcher: FetchLike = fetch,
  now: Date = new Date(),
): Promise<IntegrityResult> {
  if (!token || token.trim().length === 0) return { ok: false, hard: false, reason: 'absent' };

  let accessToken: string;
  try {
    accessToken = await integrityAccessToken(config, fetcher, now);
  } catch {
    return { ok: false, hard: false, reason: 'auth_unavailable' };
  }

  const url = `${PLAY_INTEGRITY_API}/${encodeURIComponent(config.packageName)}:decodeIntegrityToken`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ integrity_token: token }),
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, hard: false, reason: 'unreachable' };
  }
  const body = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok) return { ok: false, hard: false, reason: 'decode_failed' };
  const payload = body.tokenPayloadExternal as Json | undefined;
  if (!payload || typeof payload !== 'object') {
    return { ok: false, hard: false, reason: 'empty_payload' };
  }
  return readIntegrityVerdict(payload, config.packageName, now);
}
