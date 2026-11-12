// @polsia:user-owned — il cuore degli acquisti in-app: verifica presso lo store, lega l'acquisto
// all'account, salva l'abbonamento e decide l'accesso. Un abbonamento in-app attivo concede lo
// STESSO accesso Pro di Stripe/PayPal (vedi premium-access.server.ts e solco-pro-entitlement.ts).
import 'server-only';
import { iapAccountTokenMatches } from '@/lib/business/iap/account-token';
import { getAppleSubscription } from '@/lib/business/iap/apple-store.server';
import { findIapProduct } from '@/lib/business/iap/catalog';
import {
  appleIapConfig,
  googlePlayConfig,
  iapAllowSandbox,
} from '@/lib/business/iap/config.server';
import {
  acknowledgePlaySubscription,
  getPlaySubscription,
} from '@/lib/business/iap/google-play.server';
import {
  ACCESS_GRANTING_IAP_STATES,
  IapStoreError,
  type NormalizedIapSubscription,
} from '@/lib/business/iap/types';
import { prisma } from '@/lib/db';

type IapRow = {
  id: string;
  userId: string;
  platform: string;
  storeSubId: string;
  productId: string;
  planId: string;
  period: string;
  state: string;
  autoRenew: boolean;
  environment: string;
  accountToken: string | null;
  validFrom: Date;
  validUntil: Date | null;
  acknowledged: boolean;
  firstPaidAt: Date | null;
  checkedAt: Date;
};

const RECHECK_MS = 60 * 60 * 1000;
const EXPIRED_RECHECK_MS = 5 * 60 * 1000;

export type VerifyIapInput = {
  userId: string;
  platform: 'apple' | 'google';
  productId: string;
  /** Apple: il transactionId. Google: il purchaseToken. */
  token: string;
  now?: Date;
};

export type VerifyIapResult =
  | {
      confirmed: true;
      active: boolean;
      validUntil: Date | null;
      planId: string;
      /** true se questo è il primo pagamento verificato (per le ricompense referral). */
      firstPaid: boolean;
    }
  | {
      confirmed: false;
      reason:
        | 'not_configured'
        | 'unknown_product'
        | 'not_found'
        | 'account_mismatch'
        | 'sandbox_not_allowed'
        | 'store_error';
    };

/** L'abbonamento concede accesso adesso? Stato valido + non scaduto. */
export function iapGrantsAccess(
  row: Pick<IapRow, 'state' | 'validUntil'>,
  now = new Date(),
): boolean {
  if (!ACCESS_GRANTING_IAP_STATES.has(row.state as never)) return false;
  return !row.validUntil || row.validUntil.getTime() > now.getTime();
}

async function fetchFromStore(
  input: VerifyIapInput,
  now: Date,
): Promise<
  | { ok: true; subscription: NormalizedIapSubscription | null }
  | { ok: false; reason: 'not_configured' | 'store_error' }
> {
  try {
    if (input.platform === 'apple') {
      const config = appleIapConfig();
      if (!config) return { ok: false, reason: 'not_configured' };
      const subscription = await getAppleSubscription(input.token, input.productId, config, {
        allowSandbox: iapAllowSandbox(),
        now,
      });
      return { ok: true, subscription };
    }
    const config = googlePlayConfig();
    if (!config) return { ok: false, reason: 'not_configured' };
    const subscription = await getPlaySubscription(input.token, config, fetch, now);
    return { ok: true, subscription };
  } catch (error) {
    if (error instanceof IapStoreError && error.code === 'not_found') {
      return { ok: true, subscription: null };
    }
    if (error instanceof IapStoreError && error.code === 'not_configured') {
      return { ok: false, reason: 'not_configured' };
    }
    return { ok: false, reason: 'store_error' };
  }
}

/**
 * Allowlist dell'ambiente di PRODUZIONE esatto (Apple 'Production', Google 'production'): in
 * produzione accettiamo solo quello. Un denylist di "sandbox" mancherebbe 'Xcode'/'LocalTesting'
 * di Apple, che non devono mai concedere Premium reale.
 */
function isProductionEnvironment(platform: 'apple' | 'google', environment: string): boolean {
  return platform === 'apple' ? environment === 'Production' : environment === 'production';
}

/** Verifica un acquisto presso lo store, lo lega all'account e lo salva. Non si fida del client. */
export async function verifyAndPersistIapPurchase(input: VerifyIapInput): Promise<VerifyIapResult> {
  const now = input.now ?? new Date();
  const product = findIapProduct(input.productId);
  if (!product) return { confirmed: false, reason: 'unknown_product' };

  const fetched = await fetchFromStore(input, now);
  if (!fetched.ok) return { confirmed: false, reason: fetched.reason };
  const subscription = fetched.subscription;
  if (!subscription) return { confirmed: false, reason: 'not_found' };

  // Il productId riportato dallo store deve combaciare con quello richiesto.
  if (subscription.productId !== input.productId) {
    return { confirmed: false, reason: 'not_found' };
  }

  // Ambiente: in produzione accettiamo SOLO l'ambiente di produzione esatto (allowlist),
  // salvo abilitazione esplicita della sandbox per i tester.
  if (
    !isProductionEnvironment(subscription.platform, subscription.environment) &&
    !iapAllowSandbox()
  ) {
    return { confirmed: false, reason: 'sandbox_not_allowed' };
  }

  // Legame con l'account: il token dello store deve appartenere a QUESTO utente.
  if (!iapAccountTokenMatches(subscription.accountToken, input.userId)) {
    return { confirmed: false, reason: 'account_mismatch' };
  }

  // Un abbonamento può appartenere a un solo account Solco.
  const existing = (await prisma.solcoIapSubscription.findUnique({
    where: {
      platform_storeSubId: {
        platform: subscription.platform,
        storeSubId: subscription.storeSubId,
      },
    },
  })) as IapRow | null;
  if (existing && existing.userId !== input.userId) {
    return { confirmed: false, reason: 'account_mismatch' };
  }

  // Google: conferma l'acquisto (acknowledge) entro 3 giorni, se non già fatto.
  let acknowledged = subscription.acknowledged;
  if (
    subscription.platform === 'google' &&
    !acknowledged &&
    ACCESS_GRANTING_IAP_STATES.has(subscription.state)
  ) {
    const config = googlePlayConfig();
    if (config) {
      try {
        await acknowledgePlaySubscription(
          product.productId,
          subscription.storeSubId,
          config,
          fetch,
          now,
        );
        acknowledged = true;
      } catch {
        // Riproveremo alla prossima sincronizzazione; non blocca la concessione.
      }
    }
  }

  const grantsAccess = iapGrantsAccess(
    { state: subscription.state, validUntil: subscription.expiresAt },
    now,
  );
  const firstPaid = grantsAccess && !existing?.firstPaidAt;

  const data = {
    userId: input.userId,
    platform: subscription.platform,
    storeSubId: subscription.storeSubId,
    latestOrderId: subscription.latestOrderId,
    productId: subscription.productId,
    planId: product.planId,
    period: product.period,
    state: subscription.state,
    autoRenew: subscription.autoRenew,
    environment: subscription.environment,
    accountToken: subscription.accountToken,
    validFrom: existing?.validFrom ?? now,
    validUntil: subscription.expiresAt,
    acknowledged,
    firstPaidAt: existing?.firstPaidAt ?? (firstPaid ? now : null),
    checkedAt: now,
  };

  await prisma.solcoIapSubscription.upsert({
    where: {
      platform_storeSubId: {
        platform: subscription.platform,
        storeSubId: subscription.storeSubId,
      },
    },
    create: data,
    update: {
      latestOrderId: data.latestOrderId,
      productId: data.productId,
      planId: data.planId,
      period: data.period,
      state: data.state,
      autoRenew: data.autoRenew,
      environment: data.environment,
      accountToken: data.accountToken,
      validUntil: data.validUntil,
      acknowledged: data.acknowledged,
      ...(firstPaid ? { firstPaidAt: now } : {}),
      checkedAt: now,
    },
  });

  return {
    confirmed: true,
    active: grantsAccess,
    validUntil: subscription.expiresAt,
    planId: product.planId,
    firstPaid,
  };
}

/** Serve una nuova verifica presso lo store? Ogni ora; dopo la scadenza, al massimo ogni 5 minuti. */
function needsRecheck(row: Pick<IapRow, 'checkedAt' | 'validUntil'>, now: Date): boolean {
  const sinceCheck = now.getTime() - row.checkedAt.getTime();
  if (sinceCheck > RECHECK_MS) return true;
  const end = row.validUntil?.getTime();
  if (end === undefined || end > now.getTime()) return false;
  return row.checkedAt.getTime() <= end || sinceCheck > EXPIRED_RECHECK_MS;
}

/** Ri-legge lo stato dallo store e aggiorna la riga. Fail-open: su errore mantiene lo stato salvato. */
async function syncRow(row: IapRow, now: Date): Promise<IapRow> {
  const platform = row.platform === 'apple' ? 'apple' : 'google';
  const fetched = await fetchFromStore(
    { userId: row.userId, platform, productId: row.productId, token: row.storeSubId, now },
    now,
  );
  if (!fetched.ok) {
    // Store irraggiungibile: registra il tentativo ma non togliere l'accesso di colpo.
    const expired = row.validUntil !== null && row.validUntil.getTime() <= now.getTime();
    const attemptedAt = expired ? now : new Date(now.getTime() - RECHECK_MS + EXPIRED_RECHECK_MS);
    await prisma.solcoIapSubscription
      .updateMany({ where: { id: row.id }, data: { checkedAt: attemptedAt } })
      .catch(() => undefined);
    return { ...row, checkedAt: attemptedAt };
  }
  const subscription = fetched.subscription;
  if (!subscription) {
    const updated = (await prisma.solcoIapSubscription.update({
      where: { id: row.id },
      data: { state: 'expired', checkedAt: now },
    })) as IapRow;
    return updated;
  }
  const updated = (await prisma.solcoIapSubscription.update({
    where: { id: row.id },
    data: {
      latestOrderId: subscription.latestOrderId,
      state: subscription.state,
      autoRenew: subscription.autoRenew,
      validUntil: subscription.expiresAt,
      acknowledged: subscription.acknowledged || row.acknowledged,
      checkedAt: now,
    },
  })) as IapRow;
  return updated;
}

/** true se l'utente ha un abbonamento in-app attivo (con ri-verifica pigra presso lo store). */
export async function hasActiveIapSubscription(userId: string, now = new Date()): Promise<boolean> {
  const rows = (await prisma.solcoIapSubscription.findMany({
    where: { userId },
    orderBy: { validFrom: 'desc' },
  })) as IapRow[];
  if (rows.length === 0) return false;

  for (const row of rows) {
    const current = needsRecheck(row, now) ? await syncRow(row, now) : row;
    if (iapGrantsAccess(current, now)) return true;
  }
  return false;
}

/**
 * Ri-sincronizza (se presente) la riga di un abbonamento noto, dato il suo id presso lo store.
 * Usato dai webhook: la notifica è solo un INNESCO, lo stato autorevole si rilegge dallo store.
 * Best-effort: non lancia.
 */
export async function resyncIapSubscription(
  platform: 'apple' | 'google',
  storeSubId: string,
  now = new Date(),
): Promise<void> {
  try {
    const row = (await prisma.solcoIapSubscription.findUnique({
      where: { platform_storeSubId: { platform, storeSubId } },
    })) as IapRow | null;
    if (!row) return;
    await syncRow(row, now);
  } catch {
    // Ignorato: il prossimo accesso dell'utente riverificherà comunque.
  }
}

/** Lo stato dell'abbonamento in-app dell'utente (per /status), con ri-verifica pigra. */
export async function getIapSubscriptionStatus(
  userId: string,
  now = new Date(),
): Promise<{ active: boolean; validUntil: Date | null; planId: string | null }> {
  const rows = (await prisma.solcoIapSubscription.findMany({
    where: { userId },
    orderBy: { validFrom: 'desc' },
  })) as IapRow[];

  let bestValidUntil: Date | null = null;
  let planId: string | null = null;
  for (const row of rows) {
    const current = needsRecheck(row, now) ? await syncRow(row, now) : row;
    if (iapGrantsAccess(current, now)) {
      if (
        !bestValidUntil ||
        (current.validUntil?.getTime() ?? Infinity) > bestValidUntil.getTime()
      ) {
        bestValidUntil = current.validUntil;
        planId = current.planId;
      }
    }
  }
  return { active: planId !== null, validUntil: bestValidUntil, planId };
}
