// @polsia:user-owned — elenco della «Gestione account» (listAdminAccounts): UID assegnato anche a chi
// non l'aveva, accesso (Google, email e password, telefono), email verificata, ruolo admin anche in un
// elenco di ruoli, blocco in corso come better-auth, fonti del Premium con le regole delle statistiche
// (qui: premio in corso e Premium illimitato per email verificata), ricerca per UID scritto come
// capita oltre che per nome ed email, pagine da 25.
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import { type AccountAdminDb, listAdminAccounts } from '@/lib/admin/account-admin.server';
import { AdminAccountsResponseSchema } from '@/lib/contracts/account-admin';

const NOW = new Date('2026-11-15T12:00:00.000Z');

type Row = Record<string, unknown>;

function fakeDb(
  users: Row[],
  extra: { uids?: Row[]; accounts?: Row[]; grants?: Row[]; rewards?: Row[] } = {},
) {
  const uids = [...(extra.uids ?? [])];
  const userWhere = vi.fn();
  const empty = { findMany: vi.fn(async () => []) };
  const db = {
    user: {
      count: vi.fn(async () => users.length),
      findMany: vi.fn(async (args: { where?: Row; skip?: number; take?: number }) => {
        userWhere(args.where);
        const where = args.where ?? {};
        // Fonte «illimitato»: account con email nell'elenco ed email verificata.
        const inEmails = (where.email as { in?: string[] } | undefined)?.in;
        if (inEmails) {
          return users
            .filter(
              (user) => inEmails.includes(user.email as string) && user.emailVerified === true,
            )
            .map((user) => ({ id: user.id, email: user.email }));
        }
        const skip = args.skip ?? 0;
        return users.slice(skip, skip + (args.take ?? users.length));
      }),
    },
    userUid: {
      findUnique: vi.fn(
        async ({ where }: { where: { uid: string } }) =>
          uids.find((row) => row.uid === where.uid) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) =>
        uids.filter((row) => where.userId.in.includes(row.userId as string)),
      ),
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        for (const row of data)
          if (!uids.some((item) => item.userId === row.userId)) uids.push(row);
        return { count: data.length };
      }),
    },
    account: {
      findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) =>
        (extra.accounts ?? []).filter((row) => where.userId.in.includes(row.userId as string)),
      ),
    },
    premiumAccessGrant: { findMany: vi.fn(async () => extra.grants ?? []) },
    premiumGrant: { findMany: vi.fn(async () => extra.rewards ?? []) },
    solcoSubscription: empty,
    payPalSubscription: empty,
    solcoIapSubscription: empty,
    solcoProStripeEntitlement: empty,
    $queryRaw: vi.fn(async () => []),
  };
  return { db: db as unknown as AccountAdminDb, uids, userWhere };
}

function user(id: string, extra: Row = {}): Row {
  return {
    id,
    name: `Nome ${id}`,
    email: `${id}@example.com`,
    emailVerified: true,
    role: 'user',
    banned: false,
    banExpires: null,
    phoneNumber: null,
    createdAt: new Date('2026-11-01T10:00:00.000Z'),
    ...extra,
  };
}

describe('listAdminAccounts', () => {
  it('UID, accesso, verifica, ruolo, blocco e Premium per ogni account', async () => {
    const { db, uids } = fakeDb(
      [
        user('owner', { role: 'user, admin' }),
        user('free', { emailVerified: false }),
        user('phone', {
          email: '393331234567@telefono.solcomusic.invalid',
          phoneNumber: '+393331234567',
        }),
        user('banned', { banned: true, banExpires: null }),
        user('expired-ban', { banned: true, banExpires: new Date('2026-11-01T00:00:00.000Z') }),
      ],
      {
        uids: [{ userId: 'owner', uid: 'SOL-7K2M-9QXD' }],
        accounts: [
          { userId: 'owner', providerId: 'google' },
          { userId: 'owner', providerId: 'credential' },
          { userId: 'free', providerId: 'credential' },
          { userId: 'phone', providerId: 'credential' },
        ],
        grants: [{ email: 'owner@example.com' }, { email: 'free@example.com' }],
        rewards: [{ userId: 'free' }],
      },
    );
    const result = await listAdminAccounts({ q: '', page: 0 }, db, NOW);
    expect(AdminAccountsResponseSchema.parse(result)).toEqual(result);
    const byId = Object.fromEntries(result.items.map((item) => [item.id, item]));

    expect(byId.owner).toMatchObject({
      uid: 'SOL-7K2M-9QXD',
      role: 'admin',
      providers: ['google', 'email'],
      premium: ['unlimited'],
      banned: false,
    });
    // Email non verificata: la concessione non vale; il premio sì.
    expect(byId.free).toMatchObject({
      emailVerified: false,
      premium: ['rewards'],
      providers: ['email'],
    });
    expect(byId.phone).toMatchObject({ providers: ['phone'], premium: [] });
    expect(byId.banned?.banned).toBe(true);
    expect(byId['expired-ban']?.banned).toBe(false);
    // Chi non aveva l'UID l'ha ricevuto adesso.
    for (const item of result.items) expect(item.uid).toMatch(/^SOL-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(uids).toHaveLength(5);
    expect(result).toMatchObject({ total: 5, page: 0, hasMore: false });
  });

  it('cerca per UID scritto come capita, oltre che per nome ed email', async () => {
    const { db, userWhere } = fakeDb([user('owner')], {
      uids: [{ userId: 'owner', uid: 'SOL-7K2M-9QXD' }],
    });
    await listAdminAccounts({ q: 'sol 7k2m 9qxd', page: 0 }, db, NOW);
    expect(userWhere).toHaveBeenCalledWith({
      OR: [
        { id: 'owner' },
        { email: { contains: 'sol 7k2m 9qxd', mode: 'insensitive' } },
        { name: { contains: 'sol 7k2m 9qxd', mode: 'insensitive' } },
      ],
    });
    userWhere.mockClear();
    await listAdminAccounts({ q: 'mario', page: 0 }, db, NOW);
    expect(userWhere).toHaveBeenCalledWith({
      OR: [
        { email: { contains: 'mario', mode: 'insensitive' } },
        { name: { contains: 'mario', mode: 'insensitive' } },
      ],
    });
  });

  it('pagine da 25: hasMore finché ce ne sono altri', async () => {
    const users = Array.from({ length: 30 }, (_, index) => user(`u${index}`));
    const { db } = fakeDb(users);
    const first = await listAdminAccounts({ q: '', page: 0 }, db, NOW);
    expect(first.items).toHaveLength(25);
    expect(first.hasMore).toBe(true);
    const second = await listAdminAccounts({ q: '', page: 1 }, db, NOW);
    expect(second.items).toHaveLength(5);
    expect(second.hasMore).toBe(false);
  });
});
