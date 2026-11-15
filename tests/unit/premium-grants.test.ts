// @polsia:user-owned — Premium illimitato per email: vale SOLO per l'account con quell'email
// verificata (mai email non verificate, segnaposto dei telefoni o concessioni revocate), anche se
// l'account nasce dopo; la concessione del proprietario si crea all'avvio una volta sola e non torna
// se revocata; concedere riattiva, revocare non cambia la data; l'elenco dice stato, account e UID;
// la riga dei log non contiene mai l'email; hasPremiumAccess la usa per ultima e senza rompere le
// altre fonti se non si può leggere.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

type Row = Record<string, unknown>;

const store = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {
    user: [],
    premiumAccessGrant: [],
    account: [],
    userUid: [],
  };
  let seq = 0;
  const matches = (row: Row, where: Row | undefined) =>
    Object.entries(where ?? {}).every(([field, condition]) => {
      if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
        const ops = condition as Row;
        if ('in' in ops) return (ops.in as unknown[]).includes(row[field]);
        throw new Error(`operatore non supportato: ${Object.keys(ops).join(',')}`);
      }
      return row[field] === condition;
    });
  const pick = (row: Row | undefined, select?: Row) =>
    row && select
      ? Object.fromEntries(
          Object.keys(select)
            .filter((key) => select[key])
            .map((key) => [key, row[key]]),
        )
      : (row ?? null);
  const delegate = (name: string) => ({
    findUnique: vi.fn(async (args: { where: Row; select?: Row }) =>
      pick(
        tables[name]?.find((row) => matches(row, args.where)),
        args.select,
      ),
    ),
    findMany: vi.fn(async (args: { where?: Row; select?: Row } = {}) =>
      (tables[name] ?? [])
        .filter((row) => matches(row, args.where))
        .map((row) => pick(row, args.select)),
    ),
    count: vi.fn(
      async (args: { where?: Row } = {}) =>
        (tables[name] ?? []).filter((row) => matches(row, args.where)).length,
    ),
    createMany: vi.fn(async (args: { data: Row[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const data of args.data) {
        const list = tables[name] ?? [];
        const unique = name === 'premiumAccessGrant' ? 'email' : 'userId';
        if (
          list.some(
            (row) => row[unique] === data[unique] || (name === 'userUid' && row.uid === data.uid),
          )
        )
          continue;
        seq += 1;
        list.push({
          id: `row-${seq}`,
          createdAt: new Date('2026-11-15T10:00:00.000Z'),
          revokedAt: null,
          ...data,
        });
        tables[name] = list;
        count += 1;
      }
      return { count };
    }),
    upsert: vi.fn(async (args: { where: Row; create: Row; update: Row; select?: Row }) => {
      const list = tables[name] ?? [];
      const found = list.find((row) => matches(row, args.where));
      if (found) Object.assign(found, args.update);
      else {
        seq += 1;
        list.push({
          id: `row-${seq}`,
          createdAt: new Date('2026-11-15T10:00:00.000Z'),
          revokedAt: null,
          ...args.create,
        });
        tables[name] = list;
      }
      return pick(found ?? list.at(-1), args.select);
    }),
    updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
      const list = (tables[name] ?? []).filter((row) => matches(row, args.where));
      for (const row of list) Object.assign(row, args.data);
      return { count: list.length };
    }),
  });
  const prisma = {
    user: delegate('user'),
    premiumAccessGrant: delegate('premiumAccessGrant'),
    account: delegate('account'),
    userUid: delegate('userUid'),
  };
  return { tables, prisma };
});

vi.mock('@/lib/db', () => ({ prisma: store.prisma }));

const sources = vi.hoisted(() => ({
  pro: vi.fn(async () => null as unknown),
  reward: vi.fn(async () => null as unknown),
  subscription: vi.fn(async () => false),
  iap: vi.fn(async () => false),
}));
vi.mock('@/lib/business/solco-pro-entitlement', () => ({
  findActiveSolcoProEntitlement: sources.pro,
}));
vi.mock('@/lib/business/rewards.server', () => ({ getActiveGrant: sources.reward }));
vi.mock('@/lib/business/stripe-subscriptions.server', () => ({
  hasActiveSubscription: sources.subscription,
}));
vi.mock('@/lib/business/iap/entitlement.server', () => ({
  hasActiveIapSubscription: sources.iap,
}));
vi.mock('@/lib/require-auth', () => ({ getSessionUser: vi.fn() }));

import { REQUESTED_ADMIN_EMAIL } from '@/lib/business/admin-account-policy';
import { hasPremiumAccess } from '@/lib/business/premium-access.server';
import {
  ensureOwnerPremiumGrant,
  formatOwnerStatus,
  grantPremiumToEmail,
  hasEmailPremiumGrant,
  listPremiumGrants,
  normalizeGrantEmail,
  OWNER_GRANT_EMAIL,
  ownerAccountStatus,
  revokePremiumGrant,
} from '@/lib/business/premium-grants.server';
import { PremiumGrantSchema } from '@/lib/contracts/account-admin';

function user(id: string, email: string, emailVerified: boolean, extra: Row = {}) {
  store.tables.user?.push({ id, name: `Nome ${id}`, email, emailVerified, role: 'user', ...extra });
}

function grant(email: string, revokedAt: Date | null = null) {
  store.tables.premiumAccessGrant?.push({
    id: `grant-${email}`,
    email,
    note: null,
    createdBy: 'admin-1',
    createdAt: new Date('2026-11-01T10:00:00.000Z'),
    revokedAt,
  });
}

beforeEach(() => {
  for (const name of Object.keys(store.tables)) store.tables[name] = [];
  for (const delegate of Object.values(store.prisma)) {
    for (const fn of Object.values(delegate)) fn.mockClear();
  }
  for (const fn of Object.values(sources)) fn.mockClear();
  sources.pro.mockResolvedValue(null);
  sources.reward.mockResolvedValue(null);
  sources.subscription.mockResolvedValue(false);
  sources.iap.mockResolvedValue(false);
});

describe('hasEmailPremiumGrant', () => {
  it('email verificata e concessione attiva: Premium', async () => {
    user('u1', 'amico@example.com', true);
    grant('amico@example.com');
    expect(await hasEmailPremiumGrant('u1')).toBe(true);
  });

  it('mai con email non verificata, revocata, segnaposto del telefono o senza account', async () => {
    user('unverified', 'nuovo@example.com', false);
    grant('nuovo@example.com');
    user('revoked', 'revocato@example.com', true);
    grant('revocato@example.com', new Date('2026-11-10T00:00:00.000Z'));
    user('phone', '393331234567@telefono.solcomusic.invalid', true);
    grant('393331234567@telefono.solcomusic.invalid');
    user('nogrant', 'altro@example.com', true);
    for (const id of ['unverified', 'revoked', 'phone', 'nogrant', 'missing']) {
      expect(await hasEmailPremiumGrant(id)).toBe(false);
    }
  });

  it('l’email si confronta senza maiuscole e spazi', () => {
    expect(normalizeGrantEmail('  Amico@Example.COM ')).toBe('amico@example.com');
  });
});

describe('concessione del proprietario all’avvio', () => {
  it('creata una volta per l’email del proprietario, mai riattivata se revocata', async () => {
    expect(OWNER_GRANT_EMAIL).toBe(REQUESTED_ADMIN_EMAIL.toLowerCase());
    await ensureOwnerPremiumGrant();
    await ensureOwnerPremiumGrant();
    expect(store.tables.premiumAccessGrant).toHaveLength(1);
    const [row] = store.tables.premiumAccessGrant ?? [];
    expect(row).toMatchObject({ email: OWNER_GRANT_EMAIL, createdBy: 'avvio', revokedAt: null });
    if (row) row.revokedAt = new Date('2026-11-12T00:00:00.000Z');
    await ensureOwnerPremiumGrant();
    expect(store.tables.premiumAccessGrant?.[0]?.revokedAt).toBeInstanceOf(Date);
  });

  it('l’account del proprietario creato DOPO (accesso con Google) ha subito il Premium', async () => {
    await ensureOwnerPremiumGrant();
    user('owner', OWNER_GRANT_EMAIL, true, { role: 'admin' });
    expect(await hasEmailPremiumGrant('owner')).toBe(true);
    expect(await hasPremiumAccess('owner')).toBe(true);
  });
});

describe('concedere, revocare, elencare', () => {
  it('concede a un’email senza account (in attesa), poi l’account la attiva', async () => {
    const pending = await grantPremiumToEmail({
      email: 'futuro@example.com',
      note: 'Amico del progetto',
      adminId: 'admin-1',
    });
    expect(PremiumGrantSchema.parse(pending)).toEqual(pending);
    expect(pending).toMatchObject({
      status: 'pending',
      account: null,
      owner: false,
      note: 'Amico del progetto',
    });

    user('u2', 'futuro@example.com', true);
    const [listed] = await listPremiumGrants();
    expect(listed).toMatchObject({ status: 'active', account: { name: 'Nome u2' } });
    expect(listed?.account?.uid).toMatch(/^SOL-/);
  });

  it('revoca (data invariata la seconda volta) e riattiva', async () => {
    user('u3', 'revoca@example.com', true);
    const created = await grantPremiumToEmail({ email: 'revoca@example.com', adminId: 'admin-1' });
    const revoked = await revokePremiumGrant(
      created.id,
      undefined,
      new Date('2026-11-14T10:00:00.000Z'),
    );
    expect(revoked?.status).toBe('revoked');
    expect(revoked?.revokedAt).toBe('2026-11-14T10:00:00.000Z');
    const again = await revokePremiumGrant(
      created.id,
      undefined,
      new Date('2026-11-20T10:00:00.000Z'),
    );
    expect(again?.revokedAt).toBe('2026-11-14T10:00:00.000Z');
    expect(await hasEmailPremiumGrant('u3')).toBe(false);

    const restored = await grantPremiumToEmail({ email: 'revoca@example.com', adminId: 'admin-1' });
    expect(restored.status).toBe('active');
    expect(await hasEmailPremiumGrant('u3')).toBe(true);
    expect(await revokePremiumGrant('inesistente')).toBeNull();
  });

  it('stati nell’elenco: attiva, in attesa, email non verificata, revocata; proprietario segnato', async () => {
    await ensureOwnerPremiumGrant();
    user('owner', OWNER_GRANT_EMAIL, true);
    user('nv', 'nonverificata@example.com', false);
    grant('nonverificata@example.com');
    grant('nessuno@example.com');
    grant('revocata@example.com', new Date('2026-11-10T00:00:00.000Z'));
    const items = await listPremiumGrants();
    const byEmail = Object.fromEntries(items.map((item) => [item.email, item]));
    expect(byEmail[OWNER_GRANT_EMAIL]).toMatchObject({ status: 'active', owner: true });
    expect(byEmail['nonverificata@example.com']).toMatchObject({
      status: 'unverified',
      owner: false,
    });
    expect(byEmail['nessuno@example.com']).toMatchObject({ status: 'pending', account: null });
    expect(byEmail['revocata@example.com']).toMatchObject({ status: 'revoked' });
    for (const item of items) expect(PremiumGrantSchema.parse(item)).toEqual(item);
  });
});

describe('stato del proprietario nei log', () => {
  it('account assente: lo dice, senza email', async () => {
    await ensureOwnerPremiumGrant();
    const line = formatOwnerStatus(await ownerAccountStatus());
    expect(line).toContain('account non ancora creato');
    expect(line).toContain('Premium illimitato attivo');
    expect(line).not.toContain('@');
  });

  it('account con Google, verificato e admin: Premium in vigore e UID', async () => {
    await ensureOwnerPremiumGrant();
    user('owner', OWNER_GRANT_EMAIL, true, { role: 'admin' });
    store.tables.account?.push({ userId: 'owner', providerId: 'google' });
    store.tables.userUid?.push({ userId: 'owner', uid: 'SOL-7K2M-9QXD' });
    const status = await ownerAccountStatus();
    expect(status).toEqual({
      account: true,
      emailVerified: true,
      admin: true,
      google: true,
      premium: 'attivo',
      uid: 'SOL-7K2M-9QXD',
    });
    const line = formatOwnerStatus(status);
    expect(line).toContain('Premium illimitato attivo (in vigore)');
    expect(line).toContain('UID SOL-7K2M-9QXD');
    expect(line).not.toContain('@');
    expect(line).not.toContain('owner');
  });

  it('email non verificata: in attesa della verifica', () => {
    const line = formatOwnerStatus({
      account: true,
      emailVerified: false,
      admin: true,
      google: false,
      premium: 'attivo',
      uid: null,
    });
    expect(line).toContain('in attesa della verifica');
    expect(line).toContain('UID non ancora assegnato');
  });
});

describe('hasPremiumAccess', () => {
  it('le altre fonti decidono prima; l’illimitato per ultimo', async () => {
    user('u4', 'pro@example.com', true);
    sources.subscription.mockResolvedValue(true);
    expect(await hasPremiumAccess('u4')).toBe(true);
    expect(store.prisma.premiumAccessGrant.findUnique).not.toHaveBeenCalled();
  });

  it('se la concessione non si può leggere, nessun Premium da lì (le altre fonti restano)', async () => {
    user('u5', 'rotto@example.com', true);
    store.prisma.premiumAccessGrant.findUnique.mockRejectedValueOnce(new Error('relation missing'));
    expect(await hasPremiumAccess('u5')).toBe(false);
    sources.iap.mockResolvedValue(true);
    expect(await hasPremiumAccess('u5')).toBe(true);
  });

  it('Free senza nessuna fonte', async () => {
    user('u6', 'free@example.com', true);
    expect(await hasPremiumAccess('u6')).toBe(false);
  });
});
