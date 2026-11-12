// @polsia:user-owned — client dell'App Store Server API (StoreKit) per gli abbonamenti.
//
// Lo STATO autorevole vive su Apple: dato un transactionId (fornito dall'app), si chiama
// "Get All Subscription Statuses", si VERIFICA la firma JWS di ogni transazione (catena x5c →
// Apple Root CA) e si legge lo stato. Non ci si fida mai di ciò che manda il client.
import 'server-only';
import { createPrivateKey, sign } from 'node:crypto';
import { verifyAppleSignedPayload } from '@/lib/business/iap/apple-jws.server';
import type { AppleIapConfig } from '@/lib/business/iap/config.server';
import { normalizePem } from '@/lib/business/iap/config.server';
import {
  IapStoreError,
  type NormalizedIapState,
  type NormalizedIapSubscription,
} from '@/lib/business/iap/types';

// Host 2026 dell'App Store Server API (senza il vecchio segmento "itunes").
const PROD_BASE = 'https://api.storekit.apple.com';
const SANDBOX_BASE = 'https://api.storekit-sandbox.apple.com';
const REQUEST_TIMEOUT_MS = 10_000;
/** Codice Apple quando il transactionId non esiste in produzione (probabile sandbox). */
const TRANSACTION_NOT_FOUND = 4040010;

type FetchLike = typeof fetch;
type Json = Record<string, unknown>;

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/** JWT ES256 per autenticarsi all'App Store Server API (valido al massimo ~20 minuti). */
export function buildAppStoreApiToken(config: AppleIapConfig, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId, typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: config.issuerId,
      iat,
      exp: iat + 20 * 60,
      aud: 'appstoreconnect-v1',
      bid: config.bundleId,
    }),
  );
  const signature = base64url(
    sign('sha256', Buffer.from(`${header}.${payload}`), {
      key: createPrivateKey(normalizePem(config.privateKey)),
      dsaEncoding: 'ieee-p1363',
    }),
  );
  return `${header}.${payload}.${signature}`;
}

function mapAppleStatus(status: unknown): NormalizedIapState {
  switch (status) {
    case 1:
      return 'active';
    case 2:
      return 'expired';
    case 3:
      return 'on_hold'; // in retry di fatturazione
    case 4:
      return 'grace'; // periodo di tolleranza
    case 5:
      return 'revoked';
    default:
      return 'expired';
  }
}

function toDate(ms: unknown): Date | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Normalizza una risposta "Get All Subscription Statuses" nel tipo comune, per il productId chiesto. */
export function normalizeAppleStatuses(
  body: Json,
  rootCas: string,
  wantedProductId: string,
  wantedBundleId: string,
): NormalizedIapSubscription | null {
  const groups = Array.isArray(body.data) ? body.data : [];
  let best: NormalizedIapSubscription | null = null;

  for (const group of groups) {
    if (typeof group !== 'object' || group === null) continue;
    const lastTransactions = Array.isArray((group as Json).lastTransactions)
      ? ((group as Json).lastTransactions as unknown[])
      : [];
    for (const entry of lastTransactions) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Json;
      if (typeof row.signedTransactionInfo !== 'string') continue;

      // Verifica la firma: se non è autentica, salta (non concede nulla).
      let txn: Record<string, unknown>;
      try {
        txn = verifyAppleSignedPayload(row.signedTransactionInfo, rootCas);
      } catch {
        continue;
      }
      // La transazione deve essere della nostra app e del prodotto chiesto.
      if (txn.bundleId !== wantedBundleId) continue;
      const productId = typeof txn.productId === 'string' ? txn.productId : '';
      if (productId !== wantedProductId) continue;

      let autoRenew = false;
      if (typeof row.signedRenewalInfo === 'string') {
        try {
          const renewal = verifyAppleSignedPayload(row.signedRenewalInfo, rootCas);
          autoRenew = renewal.autoRenewStatus === 1;
        } catch {
          autoRenew = false;
        }
      }

      const expiresAt = toDate(txn.expiresDate);
      const candidate: NormalizedIapSubscription = {
        platform: 'apple',
        storeSubId: typeof txn.originalTransactionId === 'string' ? txn.originalTransactionId : '',
        latestOrderId: typeof txn.transactionId === 'string' ? txn.transactionId : null,
        productId,
        state: mapAppleStatus(row.status),
        autoRenew,
        environment: typeof txn.environment === 'string' ? txn.environment : 'Production',
        accountToken: typeof txn.appAccountToken === 'string' ? txn.appAccountToken : null,
        expiresAt,
        acknowledged: true,
      };
      if (!candidate.storeSubId) continue;
      // Tieni la transazione con la scadenza più recente (lo stato più aggiornato).
      if (!best || (candidate.expiresAt?.getTime() ?? 0) > (best.expiresAt?.getTime() ?? 0)) {
        best = candidate;
      }
    }
  }
  return best;
}

async function fetchStatuses(
  base: string,
  transactionId: string,
  config: AppleIapConfig,
  fetcher: FetchLike,
  now: Date,
): Promise<{ ok: true; body: Json } | { ok: false; notFound: boolean }> {
  const token = buildAppStoreApiToken(config, now);
  let response: Response;
  try {
    response = await fetcher(
      `${base}/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch {
    throw new IapStoreError('store_error', 'Apple non ha risposto.');
  }
  if (response.ok) {
    return { ok: true, body: (await response.json().catch(() => ({}))) as Json };
  }
  const body = (await response.json().catch(() => ({}))) as Json;
  const notFound = response.status === 404 && body.errorCode === TRANSACTION_NOT_FOUND;
  return { ok: false, notFound };
}

/**
 * Stato autorevole dell'abbonamento per un transactionId. Prova la produzione; se Apple dice
 * "transaction not found" e la sandbox è permessa, riprova in sandbox. Restituisce null se nessuna
 * transazione per il productId chiesto è presente.
 */
export async function getAppleSubscription(
  transactionId: string,
  productId: string,
  config: AppleIapConfig,
  options: { allowSandbox: boolean; fetcher?: FetchLike; now?: Date },
): Promise<NormalizedIapSubscription | null> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? new Date();

  const production = await fetchStatuses(PROD_BASE, transactionId, config, fetcher, now);
  if (production.ok) {
    return normalizeAppleStatuses(production.body, config.rootCas, productId, config.bundleId);
  }
  if (production.notFound && options.allowSandbox) {
    const sandbox = await fetchStatuses(SANDBOX_BASE, transactionId, config, fetcher, now);
    if (sandbox.ok) {
      return normalizeAppleStatuses(sandbox.body, config.rootCas, productId, config.bundleId);
    }
    if (sandbox.notFound) return null;
    throw new IapStoreError('store_error', 'Apple ha rifiutato la richiesta (sandbox).');
  }
  if (production.notFound) return null;
  throw new IapStoreError('store_error', 'Apple ha rifiutato la richiesta.');
}
