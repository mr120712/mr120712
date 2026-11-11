// @polsia:user-owned — abbonamenti con PayPal Subscriptions sull'account PayPal Business del
// titolare (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET, PAYPAL_ENV=live|sandbox).
// Prodotto e piani PayPal vengono creati alla prima richiesta dai prezzi del listino Solco.
import 'server-only';
import { planPrice } from '@/lib/business/stripe-subscriptions.server';
import type { BillingPeriod, PaidPlanId } from '@/lib/contracts/subscriptions';
import { prisma } from '@/lib/db';

const RECHECK_MS = 60 * 60 * 1000;
const PRODUCT_KEY = 'product:solco';

export class PayPalSubscriptionError extends Error {
  constructor(
    readonly code:
      | 'not_configured'
      | 'paypal_error'
      | 'not_found'
      | 'account_mismatch'
      | 'incomplete',
    message: string,
  ) {
    super(message);
    this.name = 'PayPalSubscriptionError';
  }
}

type FetchLike = typeof fetch;
type PayPalObject = Record<string, unknown>;

function credentials() {
  return {
    id: process.env.PAYPAL_CLIENT_ID?.trim() ?? '',
    secret: process.env.PAYPAL_CLIENT_SECRET?.trim() ?? '',
  };
}

export function paypalEnabled() {
  const { id, secret } = credentials();
  return id.length > 10 && secret.length > 10;
}

export function paypalApiBase() {
  return process.env.PAYPAL_ENV?.trim() === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';
}

let cachedToken: { value: string; expires: number } | null = null;

async function accessToken(fetcher: FetchLike) {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  const { id, secret } = credentials();
  if (!paypalEnabled()) {
    throw new PayPalSubscriptionError('not_configured', 'PayPal non è ancora configurato.');
  }
  let response: Response;
  try {
    response = await fetcher(`${paypalApiBase()}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new PayPalSubscriptionError('paypal_error', 'PayPal non ha risposto. Riprova.');
  }
  const body = (await response.json().catch(() => ({}))) as PayPalObject;
  if (!response.ok || typeof body.access_token !== 'string') {
    throw new PayPalSubscriptionError('paypal_error', 'Credenziali PayPal non valide.');
  }
  const ttl = typeof body.expires_in === 'number' ? body.expires_in * 1000 : 5 * 60_000;
  cachedToken = { value: body.access_token, expires: Date.now() + ttl };
  return cachedToken.value;
}

export function resetPayPalTokenCache() {
  cachedToken = null;
}

async function paypalRequest(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  fetcher: FetchLike,
): Promise<PayPalObject> {
  const token = await accessToken(fetcher);
  let response: Response;
  try {
    response = await fetcher(`${paypalApiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new PayPalSubscriptionError('paypal_error', 'PayPal non ha risposto. Riprova.');
  }
  const json = (await response.json().catch(() => ({}))) as PayPalObject;
  if (response.status === 404)
    throw new PayPalSubscriptionError('not_found', 'Non trovato su PayPal.');
  if (!response.ok)
    throw new PayPalSubscriptionError('paypal_error', 'PayPal ha rifiutato la richiesta.');
  return json;
}

async function ensureProduct(fetcher: FetchLike) {
  const existing = await prisma.payPalBillingPlan.findUnique({ where: { key: PRODUCT_KEY } });
  if (existing) return existing.paypalPlanId;
  const product = await paypalRequest(
    'POST',
    '/v1/catalogs/products',
    { name: 'Solco Premium', type: 'SERVICE', category: 'SOFTWARE' },
    fetcher,
  );
  const id = String(product.id ?? '');
  if (!id) throw new PayPalSubscriptionError('paypal_error', 'Prodotto PayPal non creato.');
  await prisma.payPalBillingPlan.upsert({
    where: { key: PRODUCT_KEY },
    create: { key: PRODUCT_KEY, paypalPlanId: id },
    update: {},
  });
  return id;
}

/** ID del piano PayPal per piano+periodo+prezzo; un cambio di prezzo crea un piano nuovo. */
export async function ensurePayPalPlan(
  planId: PaidPlanId,
  period: BillingPeriod,
  fetcher: FetchLike = fetch,
  trialDays = 0,
) {
  const price = planPrice(planId, period);
  const key = `${planId}:${period}:${price.amount}${trialDays > 0 ? `:trial${trialDays}` : ''}`;
  const regular = {
    frequency: { interval_unit: period === 'month' ? 'MONTH' : 'YEAR', interval_count: 1 },
    tenure_type: 'REGULAR',
    sequence: trialDays > 0 ? 2 : 1,
    total_cycles: 0,
    pricing_scheme: {
      fixed_price: { value: (price.amount / 100).toFixed(2), currency_code: 'EUR' },
    },
  };
  // Free trial cycle (no pricing_scheme = free) before the regular cycle.
  const trial = {
    frequency: { interval_unit: 'DAY', interval_count: trialDays },
    tenure_type: 'TRIAL',
    sequence: 1,
    total_cycles: 1,
  };
  const existing = await prisma.payPalBillingPlan.findUnique({ where: { key } });
  if (existing) return existing.paypalPlanId;
  const productId = await ensureProduct(fetcher);
  const plan = await paypalRequest(
    'POST',
    '/v1/billing/plans',
    {
      product_id: productId,
      name: `Solco ${price.name} (${period === 'month' ? 'mensile' : 'annuale'})${trialDays > 0 ? ` · prova ${trialDays} giorni` : ''}`,
      status: 'ACTIVE',
      billing_cycles: trialDays > 0 ? [trial, regular] : [regular],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
    },
    fetcher,
  );
  const id = String(plan.id ?? '');
  if (!id) throw new PayPalSubscriptionError('paypal_error', 'Piano PayPal non creato.');
  await prisma.payPalBillingPlan.upsert({
    where: { key },
    create: { key, paypalPlanId: id },
    update: {},
  });
  return id;
}

export async function createPayPalSubscription(
  input: {
    userId: string;
    planId: PaidPlanId;
    period: BillingPeriod;
    appUrl: string;
    trialDays?: number;
  },
  fetcher: FetchLike = fetch,
) {
  const paypalPlanId = await ensurePayPalPlan(
    input.planId,
    input.period,
    fetcher,
    input.trialDays ?? 0,
  );
  const subscription = await paypalRequest(
    'POST',
    '/v1/billing/subscriptions',
    {
      plan_id: paypalPlanId,
      custom_id: `${input.userId}|${input.planId}|${input.period}`,
      application_context: {
        brand_name: 'Solco',
        locale: 'it-IT',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'SUBSCRIBE_NOW',
        return_url: `${input.appUrl}/piani/paypal`,
        cancel_url: `${input.appUrl}/piani`,
      },
    },
    fetcher,
  );
  const links = Array.isArray(subscription.links) ? (subscription.links as PayPalObject[]) : [];
  const approve = links.find((link) => link.rel === 'approve')?.href;
  if (typeof approve !== 'string' || !approve.startsWith('https://')) {
    throw new PayPalSubscriptionError(
      'paypal_error',
      'PayPal non ha restituito il link di pagamento.',
    );
  }
  return approve;
}

function parseCustomId(value: unknown) {
  const [userId, planId, period] = String(value ?? '').split('|');
  return { userId, planId, period };
}

/** PayPal reports the last captured payment; a positive amount means money was charged. */
export function paypalPaymentVerified(sub: PayPalObject) {
  const last = (sub.billing_info as PayPalObject | undefined)?.last_payment as
    | PayPalObject
    | undefined;
  const value = Number((last?.amount as PayPalObject | undefined)?.value ?? 0);
  return sub.status === 'ACTIVE' && Number.isFinite(value) && value > 0;
}

async function markPayPalFirstPayment(rowId: string) {
  await prisma.payPalSubscription.updateMany({
    where: { id: rowId, firstPaidAt: null },
    data: { firstPaidAt: new Date() },
  });
}

function nextBilling(sub: PayPalObject) {
  const time = (sub.billing_info as PayPalObject | undefined)?.next_billing_time;
  const date = typeof time === 'string' ? new Date(time) : null;
  return date && !Number.isNaN(date.valueOf()) ? date : null;
}

/** Conferma l'abbonamento approvato su PayPal e lo salva per l'utente che lo ha avviato. */
export async function confirmPayPalSubscription(
  userId: string,
  subscriptionId: string,
  fetcher: FetchLike = fetch,
) {
  const sub = await paypalRequest(
    'GET',
    `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
    null,
    fetcher,
  );
  const meta = parseCustomId(sub.custom_id);
  if (meta.userId !== userId || !meta.planId || !meta.period) {
    throw new PayPalSubscriptionError(
      'account_mismatch',
      'L’abbonamento appartiene a un altro account.',
    );
  }
  const status = String(sub.status ?? 'APPROVAL_PENDING');
  if (status === 'APPROVAL_PENDING') {
    throw new PayPalSubscriptionError(
      'incomplete',
      'L’abbonamento non è stato approvato su PayPal.',
    );
  }
  const row = await prisma.payPalSubscription.upsert({
    where: { paypalSubscriptionId: subscriptionId },
    create: {
      userId,
      planId: meta.planId,
      period: meta.period,
      paypalSubscriptionId: subscriptionId,
      status,
      nextBillingAt: nextBilling(sub),
    },
    update: { status, nextBillingAt: nextBilling(sub), checkedAt: new Date() },
  });
  if (paypalPaymentVerified(sub) && !row.firstPaidAt) await markPayPalFirstPayment(row.id);
  return prisma.payPalSubscription.findUniqueOrThrow({ where: { id: row.id } });
}

export function isPayPalSubscriptionActive(row: { status: string } | null) {
  // APPROVED = payment authorised, activation in progress on PayPal's side.
  return row?.status === 'ACTIVE' || row?.status === 'APPROVED';
}

export async function getUserPayPalSubscription(
  userId: string,
  now = new Date(),
  fetcher: FetchLike = fetch,
) {
  const row = await prisma.payPalSubscription.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  if (!row || !paypalEnabled()) return row;
  if (now.getTime() - row.checkedAt.getTime() <= RECHECK_MS) return row;
  try {
    const sub = await paypalRequest(
      'GET',
      `/v1/billing/subscriptions/${encodeURIComponent(row.paypalSubscriptionId)}`,
      null,
      fetcher,
    );
    if (!row.firstPaidAt && paypalPaymentVerified(sub)) await markPayPalFirstPayment(row.id);
    return await prisma.payPalSubscription.update({
      where: { id: row.id },
      data: {
        status: String(sub.status ?? row.status),
        nextBillingAt: nextBilling(sub),
        checkedAt: now,
      },
    });
  } catch {
    return row;
  }
}
