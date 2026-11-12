// @polsia:user-owned — client dell'API Google Play Developer per gli abbonamenti.
//
// Lo STATO autorevole di un abbonamento vive su Google: qui lo si LEGGE (mai dal client) con
// purchases.subscriptionsv2.get, autenticandosi con un service account (JWT RS256 → access token).
// Si conferma l'acquisto (acknowledge) entro 3 giorni, altrimenti Google lo rimborsa.
import 'server-only';
import { createPrivateKey, sign } from 'node:crypto';
import type { GooglePlayConfig } from '@/lib/business/iap/config.server';
import {
  IapStoreError,
  type NormalizedIapState,
  type NormalizedIapSubscription,
} from '@/lib/business/iap/types';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ANDROID_PUBLISHER = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const REQUEST_TIMEOUT_MS = 10_000;

type FetchLike = typeof fetch;
type Json = Record<string, unknown>;

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

// --- OAuth2: service account JWT -> access token (con cache per email) ---

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function buildServiceAccountJwt(config: GooglePlayConfig, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: config.clientEmail,
      scope: ANDROID_PUBLISHER_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat,
      exp: iat + 3600,
    }),
  );
  const signature = base64url(
    sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPrivateKey(config.privateKey)),
  );
  return `${header}.${payload}.${signature}`;
}

export async function googleAccessToken(
  config: GooglePlayConfig,
  fetcher: FetchLike = fetch,
  now: Date = new Date(),
): Promise<string> {
  const cached = tokenCache.get(config.clientEmail);
  if (cached && cached.expiresAt - now.getTime() > 60_000) return cached.token;

  let assertion: string;
  try {
    assertion = buildServiceAccountJwt(config, now);
  } catch {
    throw new IapStoreError('auth_error', 'Chiave del service account non valida.');
  }

  let response: Response;
  try {
    response = await fetcher(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new IapStoreError('store_error', 'Google non ha risposto alla richiesta del token.');
  }
  const body = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok || typeof body.access_token !== 'string') {
    throw new IapStoreError(
      'auth_error',
      'Google ha rifiutato le credenziali del service account.',
    );
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  tokenCache.set(config.clientEmail, {
    token: body.access_token,
    expiresAt: now.getTime() + expiresIn * 1000,
  });
  return body.access_token;
}

/** Svuota la cache del token (per i test). */
export function clearGoogleTokenCache(): void {
  tokenCache.clear();
}

// --- subscriptionsv2.get + acknowledge ---

function mapSubscriptionState(state: unknown): NormalizedIapState {
  switch (state) {
    case 'SUBSCRIPTION_STATE_ACTIVE':
      return 'active';
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      return 'grace';
    case 'SUBSCRIPTION_STATE_CANCELED':
      return 'canceled';
    case 'SUBSCRIPTION_STATE_ON_HOLD':
      return 'on_hold';
    case 'SUBSCRIPTION_STATE_PAUSED':
      return 'paused';
    case 'SUBSCRIPTION_STATE_PENDING':
      return 'pending';
    default:
      // SUBSCRIPTION_STATE_EXPIRED, _UNSPECIFIED o sconosciuto: nessun accesso.
      return 'expired';
  }
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Normalizza la risposta SubscriptionPurchaseV2 di Google nel tipo comune. */
export function normalizePlaySubscription(
  purchaseToken: string,
  body: Json,
): NormalizedIapSubscription {
  const lineItems = Array.isArray(body.lineItems) ? body.lineItems : [];
  let productId = '';
  let autoRenew = false;
  let expiresAt: Date | null = null;
  for (const raw of lineItems) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as Json;
    if (!productId && typeof item.productId === 'string') productId = item.productId;
    const expiry = parseDate(item.expiryTime);
    if (expiry && (!expiresAt || expiry.getTime() > expiresAt.getTime())) expiresAt = expiry;
    const plan = item.autoRenewingPlan;
    if (typeof plan === 'object' && plan !== null && (plan as Json).autoRenewEnabled === true) {
      autoRenew = true;
    }
  }

  const externalIds = body.externalAccountIdentifiers;
  const accountToken =
    typeof externalIds === 'object' &&
    externalIds !== null &&
    typeof (externalIds as Json).obfuscatedExternalAccountId === 'string'
      ? ((externalIds as Json).obfuscatedExternalAccountId as string)
      : null;

  return {
    platform: 'google',
    storeSubId: purchaseToken,
    latestOrderId: typeof body.latestOrderId === 'string' ? body.latestOrderId : null,
    productId,
    state: mapSubscriptionState(body.subscriptionState),
    autoRenew,
    environment: body.testPurchase !== undefined ? 'test' : 'production',
    accountToken,
    expiresAt,
    acknowledged: body.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
  };
}

export async function getPlaySubscription(
  purchaseToken: string,
  config: GooglePlayConfig,
  fetcher: FetchLike = fetch,
  now: Date = new Date(),
): Promise<NormalizedIapSubscription> {
  const token = await googleAccessToken(config, fetcher, now);
  const url = `${ANDROID_PUBLISHER}/applications/${encodeURIComponent(
    config.packageName,
  )}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new IapStoreError('store_error', 'Google non ha risposto.');
  }
  if (response.status === 404 || response.status === 410) {
    throw new IapStoreError('not_found', 'Acquisto non trovato su Google Play.');
  }
  const body = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok) {
    throw new IapStoreError('store_error', 'Google ha rifiutato la richiesta.');
  }
  return normalizePlaySubscription(purchaseToken, body);
}

/**
 * Conferma (acknowledge) un abbonamento su Google. Idempotente: un acquisto già confermato
 * risponde comunque senza errore. subscriptionId è il productId dello store.
 */
export async function acknowledgePlaySubscription(
  subscriptionId: string,
  purchaseToken: string,
  config: GooglePlayConfig,
  fetcher: FetchLike = fetch,
  now: Date = new Date(),
): Promise<void> {
  const token = await googleAccessToken(config, fetcher, now);
  const url = `${ANDROID_PUBLISHER}/applications/${encodeURIComponent(
    config.packageName,
  )}/purchases/subscriptions/${encodeURIComponent(subscriptionId)}/tokens/${encodeURIComponent(
    purchaseToken,
  )}:acknowledge`;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new IapStoreError('store_error', 'Google non ha risposto alla conferma.');
  }
  // 200 ok; alcuni acquisti già confermati rispondono 400 "already acknowledged": non è un errore.
  if (!response.ok && response.status !== 400) {
    throw new IapStoreError('store_error', 'Conferma dell’acquisto non riuscita.');
  }
}
