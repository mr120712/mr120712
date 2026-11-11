// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown> & { id: string };

// Minimal in-memory Prisma double for the reward tables.
const db = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {};
  let seq = 0;
  const table = (name: string) => {
    tables[name] ??= [];
    return tables[name] as Row[];
  };
  const match = (row: Row, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (key.includes('_') && cond && typeof cond === 'object' && !(cond instanceof Date)) {
        return match(row, cond as Record<string, unknown>);
      }
      const value = row[key];
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        const c = cond as Record<string, unknown>;
        if ('gt' in c) return value instanceof Date && value > (c.gt as Date);
        if ('lte' in c) return value instanceof Date && value <= (c.lte as Date);
        if ('not' in c) return value !== c.not;
        if ('in' in c) return (c.in as unknown[]).includes(value);
      }
      if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
      return value === cond;
    });
  const model = (name: string) => ({
    findUnique: vi.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        table(name).find((row) => match(row, where)) ?? null,
    ),
    findFirst: vi.fn(
      async ({
        where,
        orderBy,
      }: {
        where?: Record<string, unknown>;
        orderBy?: Record<string, string>;
      }) => {
        const rows = table(name).filter((row) => match(row, where));
        if (orderBy) {
          const [key, dir] = Object.entries(orderBy)[0] ?? [];
          if (key)
            rows.sort(
              (a, b) => ((a[key] as Date) > (b[key] as Date) ? 1 : -1) * (dir === 'desc' ? -1 : 1),
            );
        }
        return rows[0] ?? null;
      },
    ),
    findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
      table(name).filter((row) => match(row, where)),
    ),
    count: vi.fn(
      async ({ where }: { where?: Record<string, unknown> } = {}) =>
        table(name).filter((row) => match(row, where)).length,
    ),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (name === 'premiumGrant' && table(name).some((r) => r.refKey === data.refKey))
        throw new Error('unique');
      const row = {
        id: `id${++seq}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      } as Row;
      table(name).push(row);
      return row;
    }),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: Record<string, unknown>;
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const found = table(name).find((row) => match(row, where));
        if (!found) {
          const row = {
            id: `id${++seq}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...create,
          } as Row;
          table(name).push(row);
          return row;
        }
        for (const [key, value] of Object.entries(update)) {
          found[key] =
            value && typeof value === 'object' && 'increment' in (value as object)
              ? (found[key] as number) + (value as { increment: number }).increment
              : value;
        }
        found.updatedAt = new Date();
        return found;
      },
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const rows = table(name).filter((row) => match(row, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    ),
  });
  const prisma = {
    premiumGrant: model('premiumGrant'),
    referralCode: model('referralCode'),
    referral: model('referral'),
    listeningDay: model('listeningDay'),
    userRewardProfile: model('userRewardProfile'),
    user: model('user'),
    solcoSubscription: model('solcoSubscription'),
    payPalSubscription: model('payPalSubscription'),
  };
  return {
    tables,
    table,
    prisma,
    reset: () => {
      for (const key of Object.keys(tables)) delete tables[key];
    },
  };
});

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: db.prisma }));

import {
  grantWindow,
  isBirthdayToday,
  isReferralQualified,
  listeningRewardsEarned,
  monthsBetween,
  normalizeBirthday,
  referralMilestonesReached,
} from '@/lib/business/rewards';
import {
  claimReferral,
  evaluateRewards,
  getActiveGrant,
  grantPremium,
  recordListening,
} from '@/lib/business/rewards.server';

const now = new Date('2026-11-11T12:00:00Z');
const day = (offset: number) => new Date(now.getTime() + offset * 86_400_000);

function addUser(id: string, createdAt: Date) {
  db.table('user').push({ id, createdAt });
}

beforeEach(() => db.reset());

describe('regole dei premi', () => {
  it('somma i periodi di Premium e rispetta la data di inizio', () => {
    expect(grantWindow({ now, days: 30, latestEnd: null }).endsAt).toEqual(day(30));
    expect(grantWindow({ now, days: 7, latestEnd: day(10) })).toEqual({
      startsAt: day(10),
      endsAt: day(17),
    });
    expect(grantWindow({ now, days: 30, latestEnd: null, startsAt: day(20) }).startsAt).toEqual(
      day(20),
    );
  });

  it('qualifica un invito solo con 30 minuti in almeno 2 giorni', () => {
    expect(isReferralQualified([{ day: 'a', seconds: 3600 }])).toBe(false);
    expect(
      isReferralQualified([
        { day: 'a', seconds: 600 },
        { day: 'b', seconds: 600 },
      ]),
    ).toBe(false);
    expect(
      isReferralQualified([
        { day: 'a', seconds: 1200 },
        { day: 'b', seconds: 600 },
      ]),
    ).toBe(true);
  });

  it('calcola ascolta e guadagna, traguardi, compleanno e mesi', () => {
    const tenDays = Array.from({ length: 10 }, (_, i) => ({ day: `d${i}`, seconds: 600 }));
    expect(listeningRewardsEarned(tenDays)).toBe(1);
    expect(listeningRewardsEarned(tenDays.slice(1))).toBe(0);
    expect(referralMilestonesReached(4).map((m) => m.friends)).toEqual([3]);
    expect(normalizeBirthday('02-29')).toBe('02-29');
    expect(normalizeBirthday('02-30')).toBeNull();
    expect(isBirthdayToday('11-11', now)).toBe(true);
    // 23:30 UTC on 10 Nov is already 11 Nov in Italy.
    expect(isBirthdayToday('11-11', new Date('2026-11-10T23:30:00Z'))).toBe(true);
    expect(isBirthdayToday('02-29', new Date('2027-02-28T12:00:00Z'))).toBe(true);
    expect(monthsBetween(new Date('2026-05-12T00:00:00Z'), now)).toBe(5);
    expect(monthsBetween(new Date('2026-05-11T00:00:00Z'), now)).toBe(6);
  });
});

describe('premi sul server', () => {
  it('assegna ogni premio una sola volta e lo rende attivo', async () => {
    await grantPremium({ userId: 'u1', reason: 'birthday', days: 7, refKey: 'bday:u1:2026', now });
    await grantPremium({ userId: 'u1', reason: 'birthday', days: 7, refKey: 'bday:u1:2026', now });
    expect(db.table('premiumGrant')).toHaveLength(1);
    expect(await getActiveGrant('u1', now)).not.toBeNull();
    expect(await getActiveGrant('u1', day(8))).toBeNull();
  });

  it('accetta inviti solo per account nuovi, non propri e una volta sola', async () => {
    addUser('inviter', day(-60));
    addUser('fresh', day(-1));
    addUser('old', day(-30));
    db.table('referralCode').push({ id: 'c', userId: 'inviter', code: 'abcd2345' });
    expect(await claimReferral('inviter', 'abcd2345', now)).toBe('own_code');
    expect(await claimReferral('old', 'abcd2345', now)).toBe('account_too_old');
    expect(await claimReferral('fresh', 'nope', now)).toBe('invalid_code');
    expect(await claimReferral('fresh', 'ABCD2345', now)).toBe('claimed');
    expect(await claimReferral('fresh', 'abcd2345', now)).toBe('already_referred');
  });

  it('ignora i tick di ascolto troppo ravvicinati e limita i secondi', async () => {
    expect(await recordListening('u1', 500, now)).toBe(true);
    expect(db.table('listeningDay')[0]?.seconds).toBe(60);
    expect(await recordListening('u1', 60, now)).toBe(false);
  });

  it('premia invitato e invitante quando l’amico si qualifica, con i traguardi', async () => {
    for (let i = 0; i < 150; i += 1) addUser(`early${i}`, day(-400 + i)); // nobody else is a founder
    addUser('inviter', day(-60));
    for (const friend of ['f1', 'f2', 'f3']) {
      addUser(friend, day(-3));
      db.table('referral').push({
        id: `r-${friend}`,
        inviterId: 'inviter',
        inviteeId: friend,
        qualifiedAt: null,
      });
      db.table('listeningDay').push(
        { id: `${friend}-a`, userId: friend, day: '2026-11-09', seconds: 1200, updatedAt: day(-2) },
        { id: `${friend}-b`, userId: friend, day: '2026-11-10', seconds: 900, updatedAt: day(-1) },
      );
      await evaluateRewards(friend, now);
    }
    const grants = db.table('premiumGrant');
    expect(grants.filter((g) => g.reason === 'referral_invitee')).toHaveLength(3);
    expect(
      grants.filter((g) => g.userId === 'inviter' && g.reason === 'referral_inviter'),
    ).toHaveLength(3);
    expect(grants.filter((g) => g.reason === 'referral_milestone').map((g) => g.days)).toEqual([
      90,
    ]);
    // Re-evaluating never grants twice.
    await evaluateRewards('f1', now);
    expect(db.table('premiumGrant')).toHaveLength(grants.length);
  });

  it('i primi 100 iscritti sono fondatori', async () => {
    addUser('first', day(-10));
    addUser('second', day(-5));
    await evaluateRewards('second', now);
    expect(db.table('userRewardProfile')[0]).toMatchObject({ userId: 'second', founderNumber: 2 });
    expect(db.table('premiumGrant')[0]).toMatchObject({ reason: 'founder', days: 30 });
  });
});
