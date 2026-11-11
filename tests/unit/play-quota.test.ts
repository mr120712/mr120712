// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  premium: vi.fn(async () => false),
  user: vi.fn(async () => null as { id: string } | null),
  plays: [] as Array<{ userId: string; qualifiedId: string; month: string; createdAt: Date }>,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/business/premium-access.server', () => ({ hasPremiumAccess: mocks.premium }));
vi.mock('@/lib/require-auth', () => ({ getSessionUser: mocks.user }));
vi.mock('@/lib/db', () => ({
  prisma: {
    musicPlay: {
      count: vi.fn(
        async ({ where }: { where: { userId: string; month: string } }) =>
          mocks.plays.filter((p) => p.userId === where.userId && p.month === where.month).length,
      ),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { userId: string; qualifiedId: string; createdAt: { gt: Date } };
        }) =>
          mocks.plays.find(
            (p) =>
              p.userId === where.userId &&
              p.qualifiedId === where.qualifiedId &&
              p.createdAt > where.createdAt.gt,
          ) ?? null,
      ),
      create: vi.fn(
        async ({ data }: { data: { userId: string; qualifiedId: string; month: string } }) => {
          const row = { createdAt: new Date(), ...data };
          mocks.plays.push(row);
          return row;
        },
      ),
    },
  },
}));

import {
  decidePlay,
  FREE_MONTHLY_PLAYS,
  isValidPlayId,
  romeMonth,
} from '@/lib/business/play-quota';
import { consumePlay } from '@/lib/business/play-quota.server';

beforeEach(() => {
  mocks.plays.length = 0;
  mocks.premium.mockReset().mockResolvedValue(false);
});

describe('limite di ascolti per gli account free', () => {
  it('gli ospiti devono accedere, Premium è illimitato', () => {
    expect(
      decidePlay({ signedIn: false, premium: false, usedThisMonth: 0, recentSameTrack: false }),
    ).toMatchObject({
      allowed: false,
      reason: 'login_required',
    });
    expect(
      decidePlay({ signedIn: true, premium: true, usedThisMonth: 500, recentSameTrack: false }),
    ).toMatchObject({
      allowed: true,
      limit: null,
    });
  });

  it('blocca il 41° ascolto del mese e non conta le riprese dello stesso brano', async () => {
    const user = { id: 'free-user' };
    const now = new Date('2026-11-20T10:00:00Z');
    for (let i = 0; i < FREE_MONTHLY_PLAYS; i += 1) {
      const decision = await consumePlay(user, `youtube:video${String(i).padStart(6, '0')}`, now);
      expect(decision.allowed).toBe(true);
    }
    // Same track again within 30 minutes: allowed, not counted.
    expect(await consumePlay(user, 'youtube:video000039', now)).toMatchObject({
      allowed: true,
      counted: false,
    });
    expect(await consumePlay(user, 'radio:new-station', now)).toMatchObject({
      allowed: false,
      reason: 'monthly_limit',
      used: 40,
    });
    // A new month resets the count.
    const nextMonth = new Date('2026-12-01T10:00:00Z');
    expect(romeMonth(nextMonth)).toBe('2026-12');
    expect(await consumePlay(user, 'radio:new-station', nextMonth)).toMatchObject({
      allowed: true,
      used: 1,
    });
  });

  it('Premium non registra ascolti e accetta solo id validi', async () => {
    mocks.premium.mockResolvedValue(true);
    expect(await consumePlay({ id: 'paid' }, 'jamendo:123')).toMatchObject({
      allowed: true,
      counted: false,
    });
    expect(mocks.plays).toHaveLength(0);
    expect(isValidPlayId('youtube:dQw4w9WgXcQ')).toBe(true);
    expect(isValidPlayId('youtube:../../etc')).toBe(false);
  });
});
