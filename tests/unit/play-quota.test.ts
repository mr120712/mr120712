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
        async ({
          where,
        }: {
          where: {
            userId: string;
            month: string;
            NOT?: { qualifiedId: { startsWith: string } };
          };
        }) =>
          mocks.plays.filter(
            (p) =>
              p.userId === where.userId &&
              p.month === where.month &&
              !(where.NOT && p.qualifiedId.startsWith(where.NOT.qualifiedId.startsWith)),
          ).length,
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
      const decision = await consumePlay(user, `jamendo:${1000 + i}`, now);
      expect(decision.allowed).toBe(true);
    }
    // Same track again within 30 minutes: allowed, not counted.
    expect(await consumePlay(user, 'jamendo:1039', now)).toMatchObject({
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

  it('i video YouTube non contano e non vengono mai bloccati (norme YouTube)', async () => {
    const user = { id: 'yt-user' };
    const now = new Date('2026-11-20T10:00:00Z');
    for (let i = 0; i < FREE_MONTHLY_PLAYS; i += 1) {
      await consumePlay(user, `jamendo:${2000 + i}`, now);
    }
    // A stale YouTube row from before the exemption is ignored by the monthly count.
    mocks.plays.push({
      userId: user.id,
      qualifiedId: 'youtube:oldvideo000',
      month: romeMonth(now),
      createdAt: now,
    });
    expect(await consumePlay(user, 'radio:x', now)).toMatchObject({
      allowed: false,
      used: 40,
    });
    expect(await consumePlay(user, 'youtube:dQw4w9WgXcQ', now)).toMatchObject({
      allowed: true,
      counted: false,
      used: 40,
    });
    expect(mocks.plays.filter((p) => p.qualifiedId === 'youtube:dQw4w9WgXcQ')).toHaveLength(0);
    // Guests still need an account.
    expect(await consumePlay(null, 'youtube:dQw4w9WgXcQ', now)).toMatchObject({
      allowed: false,
      reason: 'login_required',
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
