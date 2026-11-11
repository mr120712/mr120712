// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({
  prisma: {
    solcoSubscription: {
      findFirst: mocks.findFirst,
      update: mocks.update,
      updateMany: mocks.updateMany,
    },
  },
}));

import {
  getUserSubscription,
  needsStripeRecheck,
} from '@/lib/business/stripe-subscriptions.server';

const now = new Date('2026-11-11T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    userId: 'user-1',
    stripeSubscriptionId: 'sub_1',
    status: 'canceled',
    currentPeriodEnd: minutesAgo(60 * 24),
    cancelAtPeriodEnd: false,
    firstPaidAt: new Date('2026-10-01T00:00:00Z'),
    checkedAt: minutesAgo(1),
    ...overrides,
  };
}

function stripeSubscription(periodEndSeconds: number, status = 'canceled') {
  return new Response(
    JSON.stringify({
      id: 'sub_1',
      customer: 'cus_1',
      status,
      current_period_end: periodEndSeconds,
      cancel_at_period_end: false,
      metadata: { userId: 'user-1', planId: 'premium', period: 'month' },
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_example');
  mocks.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    ...row(),
    ...args.data,
  }));
  mocks.updateMany.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.unstubAllEnvs());

describe('payments: riverifica Stripe limitata', () => {
  it('riverifica ogni ora un abbonamento ancora valido', () => {
    const future = new Date(now.getTime() + 86_400_000);
    expect(needsStripeRecheck({ checkedAt: minutesAgo(30), currentPeriodEnd: future }, now)).toBe(
      false,
    );
    expect(needsStripeRecheck({ checkedAt: minutesAgo(61), currentPeriodEnd: future }, now)).toBe(
      true,
    );
    expect(needsStripeRecheck({ checkedAt: minutesAgo(30), currentPeriodEnd: null }, now)).toBe(
      false,
    );
  });

  it('riverifica subito dopo la scadenza, poi al massimo ogni 5 minuti', () => {
    const endedAt = minutesAgo(2);
    // Last check before the period ended: a renewal must be seen right away.
    expect(needsStripeRecheck({ checkedAt: minutesAgo(10), currentPeriodEnd: endedAt }, now)).toBe(
      true,
    );
    // Already checked after the period ended: wait a few minutes before the next call.
    expect(needsStripeRecheck({ checkedAt: minutesAgo(1), currentPeriodEnd: endedAt }, now)).toBe(
      false,
    );
    const longEnded = minutesAgo(60 * 24);
    expect(needsStripeRecheck({ checkedAt: minutesAgo(4), currentPeriodEnd: longEnded }, now)).toBe(
      false,
    );
    expect(needsStripeRecheck({ checkedAt: minutesAgo(6), currentPeriodEnd: longEnded }, now)).toBe(
      true,
    );
  });

  it('non richiama Stripe a ogni richiesta per un abbonamento scaduto appena verificato', async () => {
    mocks.findFirst.mockResolvedValue(row({ checkedAt: minutesAgo(1) }));
    const fetcher = vi.fn();
    for (let i = 0; i < 5; i += 1) {
      const result = await getUserSubscription('user-1', now, fetcher as unknown as typeof fetch);
      expect(result).toMatchObject({ status: 'canceled' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('vede il rinnovo alla prima richiesta dopo la scadenza e salva la verifica', async () => {
    const endedAt = minutesAgo(2);
    mocks.findFirst.mockResolvedValue(
      row({ status: 'active', currentPeriodEnd: endedAt, checkedAt: minutesAgo(10) }),
    );
    const renewedEnd = Math.floor(now.getTime() / 1000) + 30 * 86_400;
    const fetcher = vi.fn().mockResolvedValue(stripeSubscription(renewedEnd, 'active'));
    const result = await getUserSubscription('user-1', now, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: {
        status: 'active',
        currentPeriodEnd: new Date(renewedEnd * 1000),
        cancelAtPeriodEnd: false,
        checkedAt: now,
      },
    });
    expect(result).toMatchObject({ status: 'active', checkedAt: now });
  });

  it('registra il tentativo fallito di un abbonamento scaduto senza cambiarne lo stato', async () => {
    mocks.findFirst.mockResolvedValue(row({ checkedAt: minutesAgo(10) }));
    const fetcher = vi.fn().mockRejectedValue(new Error('network down'));
    const result = await getUserSubscription('user-1', now, fetcher as unknown as typeof fetch);
    expect(result).toMatchObject({ status: 'canceled', checkedAt: minutesAgo(10) });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { checkedAt: now },
    });
    // The recorded attempt throttles the next call.
    expect(
      needsStripeRecheck({ checkedAt: now, currentPeriodEnd: row().currentPeriodEnd }, now),
    ).toBe(false);
  });

  it('dopo un errore su un abbonamento valido riprova dopo pochi minuti, non a ogni richiesta', async () => {
    const future = new Date(now.getTime() + 86_400_000);
    mocks.findFirst.mockResolvedValue(
      row({ status: 'active', currentPeriodEnd: future, checkedAt: minutesAgo(90) }),
    );
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await getUserSubscription('user-1', now, fetcher as unknown as typeof fetch);
    errorLog.mockRestore();
    expect(result).toMatchObject({ status: 'active' });
    const recorded = (mocks.updateMany.mock.calls[0] as [{ data: { checkedAt: Date } }])[0].data
      .checkedAt;
    expect(needsStripeRecheck({ checkedAt: recorded, currentPeriodEnd: future }, now)).toBe(false);
    const later = new Date(now.getTime() + 6 * 60_000);
    expect(needsStripeRecheck({ checkedAt: recorded, currentPeriodEnd: future }, later)).toBe(true);
  });

  it('una scrittura del tentativo non riuscita non blocca la risposta', async () => {
    mocks.findFirst.mockResolvedValue(row({ checkedAt: minutesAgo(10) }));
    mocks.updateMany.mockRejectedValue(new Error('db down'));
    const fetcher = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(
      getUserSubscription('user-1', now, fetcher as unknown as typeof fetch),
    ).resolves.toMatchObject({ status: 'canceled' });
  });
});
