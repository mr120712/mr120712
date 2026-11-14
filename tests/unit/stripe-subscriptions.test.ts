// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let stored: Record<string, unknown> | null = null;
  return {
    upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
      stored = { id: 'row-1', firstPaidAt: null, ...args.create };
      return stored;
    }),
    updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
      if (stored) Object.assign(stored, args.data);
      return { count: 1 };
    }),
    findUniqueOrThrow: vi.fn(async () => stored),
  };
});
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  prisma: {
    solcoSubscription: {
      upsert: mocks.upsert,
      updateMany: mocks.updateMany,
      findUniqueOrThrow: mocks.findUniqueOrThrow,
    },
  },
}));

import {
  confirmSubscriptionCheckout,
  createSubscriptionCheckout,
  isSubscriptionActive,
  planPrice,
  subscriptionsEnabled,
} from '@/lib/business/stripe-subscriptions.server';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_example');
  mocks.upsert.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe('abbonamenti Stripe', () => {
  it('usa i prezzi del listino Solco', () => {
    expect(planPrice('premium', 'month')).toEqual({ name: 'Premium', amount: 499 });
    expect(planPrice('family', 'year')).toEqual({ name: 'Family', amount: 12999 });
  });

  it('è disattivato senza una chiave Stripe valida', () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    expect(subscriptionsEnabled()).toBe(false);
    vi.stubEnv('STRIPE_SECRET_KEY', 'not-a-key');
    expect(subscriptionsEnabled()).toBe(false);
  });

  it('account col telefono: niente email provvisoria precompilata nel checkout', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(json({ url: 'https://checkout.stripe.com/c/pay/cs_test_2' }));
    await createSubscriptionCheckout(
      {
        userId: 'user-2',
        email: '393331234567@telefono.solcomusic.invalid',
        planId: 'premium',
        period: 'month',
        appUrl: 'https://solco.test',
      },
      fetcher as unknown as typeof fetch,
    );
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).has('customer_email')).toBe(false);
  });

  it('crea un checkout in abbonamento senza limitare i metodi (PayPal incluso)', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(json({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }));
    const url = await createSubscriptionCheckout(
      {
        userId: 'user-1',
        email: 'a@example.com',
        planId: 'premium-plus',
        period: 'year',
        appUrl: 'https://solco.test',
      },
      fetcher as unknown as typeof fetch,
    );
    expect(url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    const [endpoint, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe('https://api.stripe.com/v1/checkout/sessions');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('mode')).toBe('subscription');
    expect(body.get('client_reference_id')).toBe('user-1');
    expect(body.get('line_items[0][price_data][unit_amount]')).toBe('7999');
    expect(body.get('line_items[0][price_data][recurring][interval]')).toBe('year');
    expect(body.get('subscription_data[metadata][planId]')).toBe('premium-plus');
    expect(body.get('line_items[0][price_data][product_data][tax_code]')).toBe('txcd_10000000');
    expect([...body.keys()].some((key) => key.startsWith('payment_method_types'))).toBe(false);
    expect(body.get('success_url')).toBe(
      'https://solco.test/piani/grazie?session_id={CHECKOUT_SESSION_ID}',
    );
  });

  it('aggiunge 10 giorni di prova quando richiesto, raccogliendo subito il metodo di pagamento', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(json({ url: 'https://checkout.stripe.com/c/pay/cs_test_2' }));
    await createSubscriptionCheckout(
      {
        userId: 'user-1',
        email: 'a@example.com',
        planId: 'premium',
        period: 'month',
        appUrl: 'https://solco.test',
        trialDays: 10,
      },
      fetcher as unknown as typeof fetch,
    );
    const body = new URLSearchParams(
      String((fetcher.mock.calls[0] as [string, RequestInit])[1].body),
    );
    expect(body.get('subscription_data[trial_period_days]')).toBe('10');
    expect(body.get('payment_method_collection')).toBe('always');

    const noTrial = vi
      .fn()
      .mockResolvedValue(json({ url: 'https://checkout.stripe.com/c/pay/cs_test_3' }));
    await createSubscriptionCheckout(
      {
        userId: 'user-1',
        email: 'a@example.com',
        planId: 'premium',
        period: 'month',
        appUrl: 'https://solco.test',
      },
      noTrial as unknown as typeof fetch,
    );
    const plain = new URLSearchParams(
      String((noTrial.mock.calls[0] as [string, RequestInit])[1].body),
    );
    expect(plain.has('subscription_data[trial_period_days]')).toBe(false);
  });

  it('conferma solo checkout completati dello stesso utente', async () => {
    const subscription = {
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      current_period_end: 1_900_000_000,
      cancel_at_period_end: false,
      metadata: { userId: 'user-1', planId: 'premium', period: 'month' },
    };
    const other = vi
      .fn()
      .mockResolvedValue(json({ client_reference_id: 'user-2', status: 'complete', subscription }));
    await expect(
      confirmSubscriptionCheckout('user-1', 'cs_test_1', other as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'account_mismatch' });

    const open = vi
      .fn()
      .mockResolvedValue(
        json({ client_reference_id: 'user-1', status: 'open', subscription: null }),
      );
    await expect(
      confirmSubscriptionCheckout('user-1', 'cs_test_1', open as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: 'incomplete' });
    expect(mocks.upsert).not.toHaveBeenCalled();

    // Completed but nothing charged (e.g. a 100% coupon): no verified payment.
    const free = vi.fn().mockResolvedValue(
      json({
        client_reference_id: 'user-1',
        status: 'complete',
        payment_status: 'no_payment_required',
        amount_total: 0,
        subscription,
      }),
    );
    const unpaid = await confirmSubscriptionCheckout(
      'user-1',
      'cs_test_1',
      free as unknown as typeof fetch,
    );
    expect(unpaid).toMatchObject({ firstPaidAt: null });

    const ok = vi.fn().mockResolvedValue(
      json({
        client_reference_id: 'user-1',
        status: 'complete',
        payment_status: 'paid',
        amount_total: 499,
        subscription,
      }),
    );
    const row = await confirmSubscriptionCheckout(
      'user-1',
      'cs_test_1',
      ok as unknown as typeof fetch,
    );
    expect(row).toMatchObject({
      userId: 'user-1',
      planId: 'premium',
      stripeSubscriptionId: 'sub_1',
      status: 'active',
    });
    expect((row as { firstPaidAt: unknown }).firstPaidAt).toBeInstanceOf(Date);
  });

  it('considera attivo solo uno stato valido e non scaduto', () => {
    const now = new Date('2026-11-11T00:00:00Z');
    const future = new Date('2026-12-11T00:00:00Z');
    expect(isSubscriptionActive({ status: 'active', currentPeriodEnd: future }, now)).toBe(true);
    expect(isSubscriptionActive({ status: 'canceled', currentPeriodEnd: future }, now)).toBe(false);
    expect(
      isSubscriptionActive({ status: 'active', currentPeriodEnd: new Date('2026-11-01') }, now),
    ).toBe(false);
    expect(isSubscriptionActive(null, now)).toBe(false);
  });
});
