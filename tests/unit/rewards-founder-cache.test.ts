// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Profile = {
  userId: string;
  founderNumber?: number | null;
  founderCheckedAt?: Date | null;
  birthday?: string | null;
};

const state = vi.hoisted(() => ({
  profiles: new Map<string, Profile>(),
  users: new Map<string, Date>(),
  usersBefore: 0,
}));

const prisma = vi.hoisted(() => ({
  userRewardProfile: {
    findUnique: vi.fn(
      async ({ where }: { where: { userId: string } }) => state.profiles.get(where.userId) ?? null,
    ),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { userId: string };
        create: Profile;
        update: Partial<Profile>;
      }) => {
        const found = state.profiles.get(where.userId);
        const row = found ? { ...found, ...update } : { ...create };
        state.profiles.set(where.userId, row);
        return row;
      },
    ),
  },
  user: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const createdAt = state.users.get(where.id);
      return createdAt ? { createdAt } : null;
    }),
    count: vi.fn(async () => state.usersBefore),
  },
  premiumGrant: {
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
  },
  listeningDay: { findMany: vi.fn(async () => []) },
  referral: { findUnique: vi.fn(async () => null) },
  solcoSubscription: { findMany: vi.fn(async () => []) },
  payPalSubscription: { findMany: vi.fn(async () => []) },
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma }));

import { evaluateRewards } from '@/lib/business/rewards.server';

const now = new Date('2026-11-11T12:00:00Z');

beforeEach(() => {
  state.profiles.clear();
  state.users.clear();
  state.usersBefore = 0;
  vi.clearAllMocks();
});

describe('rewards founder evaluation cache', () => {
  it('conta gli utenti una sola volta per chi non è fondatore', async () => {
    state.users.set('late', new Date('2026-10-01T00:00:00Z'));
    state.usersBefore = 250;

    expect((await evaluateRewards('late', now)).founderNumber).toBeNull();
    expect(prisma.user.count).toHaveBeenCalledTimes(1);
    expect(state.profiles.get('late')).toMatchObject({ founderCheckedAt: now });
    expect(state.profiles.get('late')?.founderNumber ?? null).toBeNull();

    expect((await evaluateRewards('late', now)).founderNumber).toBeNull();
    expect((await evaluateRewards('late', now)).founderNumber).toBeNull();
    expect(prisma.user.count).toHaveBeenCalledTimes(1);
    expect(prisma.premiumGrant.create).not.toHaveBeenCalled();
  });

  it('un fondatore resta fondatore senza ricontare', async () => {
    state.users.set('early', new Date('2026-01-01T00:00:00Z'));
    state.usersBefore = 7;

    expect((await evaluateRewards('early', now)).founderNumber).toBe(7);
    expect((await evaluateRewards('early', now)).founderNumber).toBe(7);
    expect(prisma.user.count).toHaveBeenCalledTimes(1);
    expect(prisma.premiumGrant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ reason: 'founder', refKey: 'founder:early' }),
    });
  });

  it('non salva nulla se l’utente non esiste', async () => {
    expect((await evaluateRewards('ghost', now)).founderNumber).toBeNull();
    expect(prisma.user.count).not.toHaveBeenCalled();
    expect(state.profiles.size).toBe(0);
  });
});
