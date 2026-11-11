// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  premium: vi.fn(async () => false),
  user: vi.fn(async () => null as { id: string } | null),
  plays: [] as Array<{ userId: string; qualifiedId: string; month: string; createdAt: Date }>,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/business/premium-access.server', () => ({ hasPremiumAccess: mocks.premium }));
vi.mock('@/lib/require-auth', () => ({ getSessionUser: mocks.user }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: () => true }));
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
            NOT?: Array<{ qualifiedId: { startsWith: string } }>;
          };
        }) =>
          mocks.plays.filter(
            (p) =>
              p.userId === where.userId &&
              p.month === where.month &&
              !(where.NOT ?? []).some((rule) =>
                p.qualifiedId.startsWith(rule.qualifiedId.startsWith),
              ),
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
    // consumePlay reads and writes in one Serializable transaction (concurrency: play-quota-concurrency).
    $transaction(run: (transaction: unknown) => Promise<unknown>) {
      return run(this);
    },
  },
}));

import { POST as playsRoute } from '@/app/api/music/plays/route';
import {
  countsTowardFreeQuota,
  decidePlay,
  FREE_MONTHLY_PLAYS,
  isValidPlayId,
  romeMonth,
} from '@/lib/business/play-quota';
import { consumePlay, monthlyPlays } from '@/lib/business/play-quota.server';

beforeEach(() => {
  mocks.plays.length = 0;
  mocks.premium.mockReset().mockResolvedValue(false);
});
afterEach(() => vi.unstubAllEnvs());

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
      const decision = await consumePlay(user, `audius:track${1000 + i}`, now);
      expect(decision.allowed).toBe(true);
    }
    // Same track again within 30 minutes: allowed, not counted.
    expect(await consumePlay(user, 'audius:track1039', now)).toMatchObject({
      allowed: true,
      counted: false,
    });
    expect(await consumePlay(user, 'podcast:123~episode-1', now)).toMatchObject({
      allowed: false,
      reason: 'monthly_limit',
      used: 40,
    });
    // A new month resets the count.
    const nextMonth = new Date('2026-12-01T10:00:00Z');
    expect(romeMonth(nextMonth)).toBe('2026-12');
    expect(await consumePlay(user, 'podcast:123~episode-1', nextMonth)).toMatchObject({
      allowed: true,
      used: 1,
    });
  });

  it('i video YouTube non contano e non vengono mai bloccati (norme YouTube)', async () => {
    const user = { id: 'yt-user' };
    const now = new Date('2026-11-20T10:00:00Z');
    for (let i = 0; i < FREE_MONTHLY_PLAYS; i += 1) {
      await consumePlay(user, `audius:track${2000 + i}`, now);
    }
    // A stale YouTube row from before the exemption is ignored by the monthly count.
    mocks.plays.push({
      userId: user.id,
      qualifiedId: 'youtube:oldvideo000',
      month: romeMonth(now),
      createdAt: now,
    });
    expect(await consumePlay(user, 'audius:another', now)).toMatchObject({
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

  it('le radio dal vivo non contano e non vengono mai bloccate, ma serve un account', async () => {
    const user = { id: 'radio-user' };
    const now = new Date('2026-11-20T10:00:00Z');
    expect(countsTowardFreeQuota('radio:station-1')).toBe(false);
    expect(countsTowardFreeQuota('youtube:dQw4w9WgXcQ')).toBe(false);
    expect(countsTowardFreeQuota('audius:track')).toBe(true);
    expect(countsTowardFreeQuota('podcast:1~ep')).toBe(true);
    for (let i = 0; i < FREE_MONTHLY_PLAYS; i += 1) {
      await consumePlay(user, `podcast:${3000 + i}~ep`, now);
    }
    // A stale radio row from before the exemption is ignored by the monthly count.
    mocks.plays.push({
      userId: user.id,
      qualifiedId: 'radio:old-station',
      month: romeMonth(now),
      createdAt: now,
    });
    expect(await monthlyPlays(user.id, now)).toBe(40);
    expect(await consumePlay(user, 'radio:new-station', now)).toMatchObject({
      allowed: true,
      counted: false,
      used: 40,
      limit: FREE_MONTHLY_PLAYS,
    });
    expect(mocks.plays.filter((p) => p.qualifiedId === 'radio:new-station')).toHaveLength(0);
    // Guests still need an account.
    expect(await consumePlay(null, 'radio:new-station', now)).toMatchObject({
      allowed: false,
      reason: 'login_required',
    });
  });

  it('Jamendo spento (manca la licenza commerciale) non consuma ascolti Free', async () => {
    vi.stubEnv('JAMENDO_CLIENT_ID', 'jamendo-id');
    vi.stubEnv('JAMENDO_COMMERCIAL_LICENSE', '');
    const user = { id: 'jamendo-user' };
    const now = new Date();
    for (let i = 0; i < FREE_MONTHLY_PLAYS; i += 1) {
      await consumePlay(user, `audius:track${4000 + i}`, now);
    }
    // A saved Jamendo track (library, queue, history) asks the player's permit first.
    mocks.user.mockResolvedValueOnce(user);
    const response = await playsRoute(
      new Request('https://solco.test/api/music/plays', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ qualifiedId: 'jamendo:1532771' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ allowed: true, used: 40, limit: FREE_MONTHLY_PLAYS });
    expect(mocks.plays.filter((p) => p.qualifiedId.startsWith('jamendo:'))).toHaveLength(0);

    // With the commercial licence confirmed, Jamendo counts like Audius and podcasts.
    vi.stubEnv('JAMENDO_COMMERCIAL_LICENSE', 'confirmed');
    expect(await consumePlay(user, 'jamendo:1532771', now)).toMatchObject({
      allowed: false,
      reason: 'monthly_limit',
    });
    expect(await consumePlay({ id: 'fresh-user' }, 'jamendo:1532771', now)).toMatchObject({
      allowed: true,
      counted: true,
      used: 1,
    });
  });

  it('Premium non registra ascolti e accetta solo id validi', async () => {
    mocks.premium.mockResolvedValue(true);
    expect(await consumePlay({ id: 'paid' }, 'audius:paid-track')).toMatchObject({
      allowed: true,
      counted: false,
    });
    expect(mocks.plays).toHaveLength(0);
    expect(isValidPlayId('youtube:dQw4w9WgXcQ')).toBe(true);
    expect(isValidPlayId('youtube:../../etc')).toBe(false);
  });
});
