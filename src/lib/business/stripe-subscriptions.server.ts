// @polsia:user-owned — abbonamenti con Stripe Checkout sull'account Stripe del titolare
// (chiave STRIPE_SECRET_KEY). Nessun webhook: lo stato si legge da Stripe alla conferma
// del checkout e si riverifica periodicamente.
import 'server-only';
import { getSolcoProPricing } from '@/lib/business/solco-pro-pricing';
import type { BillingPeriod, PaidPlanId } from '@/lib/contracts/subscriptions';
import { prisma } from '@/lib/db';

const STRIPE_API = 'https://api.stripe.com/v1';
const RECHECK_MS = 60 * 60 * 1000;
const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

export class StripeSubscriptionError extends Error {
  constructor(
    readonly code:
      | 'not_configured'
      | 'stripe_error'
      | 'not_found'
      | 'account_mismatch'
      | 'incomplete',
    message: string,
  ) {
    super(message);
    this.name = 'StripeSubscriptionError';
  }
}

type FetchLike = typeof fetch;
type StripeObject = Record<string, unknown>;

export function stripeSecretKey() {
  return process.env.STRIPE_SECRET_KEY?.trim() ?? '';
}

export function subscriptionsEnabled() {
  return /^(sk|rk)_(live|test)_/.test(stripeSecretKey());
}

/** Prezzo in centesimi del piano richiesto, dal listino Solco (unica fonte dei prezzi). */
export function planPrice(planId: PaidPlanId, period: BillingPeriod) {
  const plan = getSolcoProPricing().plans.find((item) => item.id === planId);
  if (!plan) throw new StripeSubscriptionError('not_found', 'Piano non trovato.');
  const amount = period === 'month' ? plan.monthlyEuroCents : plan.annualEuroCents;
  if (amount <= 0) throw new StripeSubscriptionError('not_found', 'Piano non a pagamento.');
  return { name: plan.name, amount };
}

function form(params: Record<string, string>) {
  return new URLSearchParams(params).toString();
}

async function stripeRequest(
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string> = {},
  fetcher: FetchLike = fetch,
): Promise<StripeObject> {
  const key = stripeSecretKey();
  if (!subscriptionsEnabled()) {
    throw new StripeSubscriptionError('not_configured', 'Pagamenti non ancora configurati.');
  }
  const query = method === 'GET' && Object.keys(params).length ? `?${form(params)}` : '';
  let response: Response;
  try {
    response = await fetcher(`${STRIPE_API}${path}${query}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': '2024-06-20',
      },
      body: method === 'POST' ? form(params) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new StripeSubscriptionError('stripe_error', 'Stripe non ha risposto. Riprova.');
  }
  const body = (await response.json().catch(() => ({}))) as StripeObject;
  if (!response.ok) {
    if (response.status === 404)
      throw new StripeSubscriptionError('not_found', 'Non trovato su Stripe.');
    throw new StripeSubscriptionError('stripe_error', 'Stripe ha rifiutato la richiesta.');
  }
  return body;
}

export async function createSubscriptionCheckout(
  input: {
    userId: string;
    email: string;
    planId: PaidPlanId;
    period: BillingPeriod;
    appUrl: string;
    customerId?: string | null;
  },
  fetcher: FetchLike = fetch,
) {
  const price = planPrice(input.planId, input.period);
  const params: Record<string, string> = {
    mode: 'subscription',
    client_reference_id: input.userId,
    success_url: `${input.appUrl}/piani/grazie?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.appUrl}/piani`,
    allow_promotion_codes: 'true',
    locale: 'it',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'eur',
    'line_items[0][price_data][unit_amount]': String(price.amount),
    'line_items[0][price_data][recurring][interval]': input.period,
    'line_items[0][price_data][product_data][name]': `Solco ${price.name}`,
    'metadata[userId]': input.userId,
    'metadata[planId]': input.planId,
    'metadata[period]': input.period,
    'subscription_data[metadata][userId]': input.userId,
    'subscription_data[metadata][planId]': input.planId,
    'subscription_data[metadata][period]': input.period,
  };
  // No payment_method_types: Stripe shows every method enabled in the Dashboard
  // (cards, PayPal, Apple Pay, Google Pay…).
  if (input.customerId) params.customer = input.customerId;
  else params.customer_email = input.email;
  const session = await stripeRequest('POST', '/checkout/sessions', params, fetcher);
  if (typeof session.url !== 'string') {
    throw new StripeSubscriptionError('stripe_error', 'Stripe non ha restituito il checkout.');
  }
  return session.url;
}

function toDate(seconds: unknown) {
  return typeof seconds === 'number' ? new Date(seconds * 1000) : null;
}

function readSubscription(sub: StripeObject) {
  const metadata = (sub.metadata ?? {}) as Record<string, string>;
  const item = ((sub.items as StripeObject | undefined)?.data as StripeObject[] | undefined)?.[0];
  return {
    id: String(sub.id ?? ''),
    customerId:
      typeof sub.customer === 'string'
        ? sub.customer
        : String((sub.customer as StripeObject)?.id ?? ''),
    status: String(sub.status ?? 'incomplete'),
    // Newer API versions moved current_period_end onto subscription items.
    currentPeriodEnd: toDate(sub.current_period_end ?? item?.current_period_end),
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    userId: metadata.userId ?? null,
    planId: metadata.planId ?? null,
    period: metadata.period ?? null,
  };
}

/** Conferma un checkout completato e salva l'abbonamento per l'utente che lo ha avviato. */
export async function confirmSubscriptionCheckout(
  userId: string,
  sessionId: string,
  fetcher: FetchLike = fetch,
) {
  const session = await stripeRequest(
    'GET',
    `/checkout/sessions/${encodeURIComponent(sessionId)}`,
    { 'expand[]': 'subscription' },
    fetcher,
  );
  if (session.client_reference_id !== userId) {
    throw new StripeSubscriptionError(
      'account_mismatch',
      'Il pagamento appartiene a un altro account.',
    );
  }
  if (
    session.status !== 'complete' ||
    typeof session.subscription !== 'object' ||
    !session.subscription
  ) {
    throw new StripeSubscriptionError('incomplete', 'Il pagamento non risulta completato.');
  }
  const sub = readSubscription(session.subscription as StripeObject);
  if (!sub.id || sub.userId !== userId || !sub.planId || !sub.period) {
    throw new StripeSubscriptionError(
      'account_mismatch',
      'Abbonamento non associato a questo account.',
    );
  }
  return prisma.solcoSubscription.upsert({
    where: { stripeSubscriptionId: sub.id },
    create: {
      userId,
      planId: sub.planId,
      period: sub.period,
      stripeCustomerId: sub.customerId,
      stripeSubscriptionId: sub.id,
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    },
    update: {
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      checkedAt: new Date(),
    },
  });
}

export function isSubscriptionActive(
  row: { status: string; currentPeriodEnd: Date | null } | null,
  now = new Date(),
) {
  if (!row || !ACTIVE_STATUSES.has(row.status)) return false;
  return !row.currentPeriodEnd || row.currentPeriodEnd.getTime() > now.getTime();
}

/** Ultimo abbonamento dell'utente; riverifica con Stripe se scaduto o non controllato da un'ora. */
export async function getUserSubscription(
  userId: string,
  now = new Date(),
  fetcher: FetchLike = fetch,
) {
  const row = await prisma.solcoSubscription.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  if (!row || !subscriptionsEnabled()) return row;
  const stale =
    now.getTime() - row.checkedAt.getTime() > RECHECK_MS ||
    (row.currentPeriodEnd !== null && row.currentPeriodEnd.getTime() <= now.getTime());
  if (!stale) return row;
  try {
    const sub = readSubscription(
      await stripeRequest(
        'GET',
        `/subscriptions/${encodeURIComponent(row.stripeSubscriptionId)}`,
        {},
        fetcher,
      ),
    );
    return await prisma.solcoSubscription.update({
      where: { id: row.id },
      data: {
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        checkedAt: now,
      },
    });
  } catch {
    // Stripe unreachable: keep the stored state rather than locking the user out.
    return row;
  }
}

export async function hasActiveSubscription(userId: string, now = new Date()) {
  return isSubscriptionActive(await getUserSubscription(userId, now), now);
}

export async function createBillingPortal(
  customerId: string,
  returnUrl: string,
  fetcher: FetchLike = fetch,
) {
  const portal = await stripeRequest(
    'POST',
    '/billing_portal/sessions',
    { customer: customerId, return_url: returnUrl, locale: 'it' },
    fetcher,
  );
  if (typeof portal.url !== 'string') {
    throw new StripeSubscriptionError('stripe_error', 'Portale di fatturazione non disponibile.');
  }
  return portal.url;
}
