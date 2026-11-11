// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
  confirmSubscriptionCheckout: vi.fn(),
  confirmPayPalSubscription: vi.fn(),
  getUserSubscription: vi.fn(),
  createBillingPortal: vi.fn(),
  evaluateRewards: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/site', () => ({ siteUrl: 'https://solco.example' }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: (userId: string | null) => (userId ? `user:${userId}` : null),
}));
vi.mock('@/lib/business/rewards.server', () => ({ evaluateRewards: mocks.evaluateRewards }));
vi.mock('@/lib/business/stripe-subscriptions.server', () => ({
  StripeSubscriptionError: class StripeSubscriptionError extends Error {},
  confirmSubscriptionCheckout: mocks.confirmSubscriptionCheckout,
  createBillingPortal: mocks.createBillingPortal,
  getUserSubscription: mocks.getUserSubscription,
  isSubscriptionActive: () => true,
}));
vi.mock('@/lib/business/paypal-subscriptions.server', () => ({
  PayPalSubscriptionError: class PayPalSubscriptionError extends Error {},
  confirmPayPalSubscription: mocks.confirmPayPalSubscription,
  isPayPalSubscriptionActive: () => true,
}));

import { POST as confirmStripe } from '@/app/api/subscriptions/confirm/route';
import { POST as confirmPayPal } from '@/app/api/subscriptions/paypal/confirm/route';
import { POST as openPortal } from '@/app/api/subscriptions/portal/route';

const account = { id: 'listener-1', email: 'listener@example.test' };

function post(path: string, body?: unknown) {
  return new Request(`https://solco.example${path}`, {
    method: 'POST',
    headers: { origin: 'https://solco.example', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const tooMany = () =>
  Response.json(
    { error: 'rate_limited', message: 'Hai raggiunto il limite.', retryAfterSeconds: 60 },
    { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'private, no-store' } },
  );

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAuth.mockResolvedValue(account);
  mocks.sameOrigin.mockReturnValue(true);
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.evaluateRewards.mockResolvedValue(undefined);
  mocks.confirmSubscriptionCheckout.mockResolvedValue({ planId: 'premium', period: 'month' });
  mocks.confirmPayPalSubscription.mockResolvedValue({ planId: 'premium', period: 'month' });
  mocks.getUserSubscription.mockResolvedValue({ stripeCustomerId: 'cus_1' });
  mocks.createBillingPortal.mockResolvedValue('https://billing.stripe.com/p/session_1');
});

const routes = [
  {
    name: 'conferma Stripe',
    call: () => confirmStripe(post('/api/subscriptions/confirm', { sessionId: 'cs_test_1' })),
    provider: () => mocks.confirmSubscriptionCheckout,
  },
  {
    name: 'conferma PayPal',
    call: () =>
      confirmPayPal(
        post('/api/subscriptions/paypal/confirm', { subscriptionId: 'I-ABCDEF123456' }),
      ),
    provider: () => mocks.confirmPayPalSubscription,
  },
  {
    name: 'portale di fatturazione',
    call: () => openPortal(post('/api/subscriptions/portal')),
    provider: () => mocks.createBillingPortal,
  },
];

describe('payments: limite subscriptions.sync', () => {
  for (const route of routes) {
    it(`${route.name}: applica il limite per account prima di chiamare il provider`, async () => {
      const response = await route.call();
      expect(response.status).toBe(200);
      expect(mocks.enforceRateLimit).toHaveBeenCalledWith(
        'subscriptions.sync',
        `user:${account.id}`,
      );
      expect(route.provider()).toHaveBeenCalledTimes(1);
    });

    it(`${route.name}: oltre il limite risponde 429 senza contattare il provider`, async () => {
      mocks.enforceRateLimit.mockResolvedValueOnce(tooMany());
      const response = await route.call();
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('60');
      expect(route.provider()).not.toHaveBeenCalled();
      expect(mocks.getUserSubscription).not.toHaveBeenCalled();
    });

    it(`${route.name}: una sessione anonima non consuma il limite`, async () => {
      mocks.requireAuth.mockRejectedValueOnce(
        Response.json({ error: 'Unauthorized' }, { status: 401 }),
      );
      const response = await route.call();
      expect(response.status).toBe(401);
      expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
      expect(route.provider()).not.toHaveBeenCalled();
    });

    it(`${route.name}: un'origine estranea viene rifiutata prima del limite`, async () => {
      mocks.sameOrigin.mockReturnValueOnce(false);
      const response = await route.call();
      expect(response.status).toBe(403);
      expect(mocks.enforceRateLimit).not.toHaveBeenCalled();
    });
  }
});
