// @polsia:user-owned — UID leggibile degli account: forma SOL-XXXX-XXXX con l'alfabeto Crockford
// (niente I, L, O, U), lettura tollerante di quello che scrive l'admin (minuscole, spazi, senza
// trattini o senza "SOL", I/L → 1 e O → 0), assegnazione ai soli account che non l'hanno (anche in
// caso di collisione, mai doppioni) e backfill all'avvio a gruppi, con l'uscita rapida quando sono già
// tutti assegnati.
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import {
  ACCOUNT_UID_PATTERN,
  generateAccountUid,
  isAccountUid,
  parseAccountUid,
} from '@/lib/account/uid';
import { backfillAccountUids, ensureAccountUids, type UidDb } from '@/lib/account/uid.server';

describe('generateAccountUid', () => {
  it('forma SOL-XXXX-XXXX con l’alfabeto Crockford, uniforme sui 32 simboli', () => {
    const bytes = new Uint8Array([0, 1, 9, 10, 17, 18, 30, 31]);
    expect(generateAccountUid(() => bytes)).toBe('SOL-019A-HJYZ');
    // Il byte vale & 31: 32 e 0 danno lo stesso simbolo (nessuna distorsione).
    expect(generateAccountUid(() => new Uint8Array([32, 64, 96, 128, 160, 192, 224, 255]))).toBe(
      'SOL-0000-000Z',
    );
  });

  it('casuale, sempre valida e senza lettere ambigue', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      const uid = generateAccountUid();
      expect(uid).toMatch(ACCOUNT_UID_PATTERN);
      expect(uid.slice(4)).not.toMatch(/[ILOU]/);
      seen.add(uid);
    }
    expect(seen.size).toBeGreaterThan(495);
  });
});

describe('isAccountUid e parseAccountUid', () => {
  it('riconosce solo la forma canonica', () => {
    expect(isAccountUid('SOL-7K2M-9QXD')).toBe(true);
    expect(isAccountUid('sol-7k2m-9qxd')).toBe(false);
    expect(isAccountUid('SOL-7K2M-9QXU')).toBe(false);
    expect(isAccountUid(42)).toBe(false);
  });

  it('legge un UID scritto come capita', () => {
    for (const input of [
      'SOL-7K2M-9QXD',
      'sol 7k2m 9qxd',
      '7K2M9QXD',
      'sol7k2m9qxd',
      ' 7k2m-9qxd ',
    ]) {
      expect(parseAccountUid(input)).toBe('SOL-7K2M-9QXD');
    }
    // Come Crockford: I e L valgono 1, O vale 0.
    expect(parseAccountUid('SOL-IL0O-0000')).toBe('SOL-1100-0000');
  });

  it('null per testi che non sono un UID', () => {
    for (const input of [
      '',
      'mario',
      'mario@example.com',
      'SOL-7K2M',
      'SOL-7K2M-9QXU',
      '123456789',
    ]) {
      expect(parseAccountUid(input)).toBeNull();
    }
  });
});

/** Un database finto per userUid e user (solo quello che serve). */
function fakeDb(userIds: string[], existing: Array<{ userId: string; uid: string }> = []) {
  const rows = [...existing];
  const createMany = vi.fn(
    async ({ data }: { data: Array<{ userId: string; uid: string }>; skipDuplicates: boolean }) => {
      let count = 0;
      for (const row of data) {
        if (rows.some((item) => item.userId === row.userId || item.uid === row.uid)) continue;
        rows.push(row);
        count += 1;
      }
      return { count };
    },
  );
  const db = {
    userUid: {
      findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) =>
        rows.filter((row) => where.userId.in.includes(row.userId)),
      ),
      createMany,
      count: vi.fn(async (args?: { where?: { userId: { in: string[] } } }) =>
        args?.where
          ? rows.filter((row) => args.where?.userId.in.includes(row.userId)).length
          : rows.length,
      ),
    },
    user: {
      count: vi.fn(async () => userIds.length),
      findMany: vi.fn(async (args: { take: number; skip?: number; cursor?: { id: string } }) => {
        const sorted = [...userIds].sort();
        const start = args.cursor ? sorted.indexOf(args.cursor.id) + (args.skip ?? 0) : 0;
        return sorted.slice(start, start + args.take).map((id) => ({ id }));
      }),
    },
  };
  return { db: db as unknown as UidDb, rows, createMany };
}

describe('ensureAccountUids', () => {
  it('crea l’UID solo per chi non l’ha e restituisce quelli esistenti', async () => {
    const { db, rows, createMany } = fakeDb(['a', 'b'], [{ userId: 'a', uid: 'SOL-AAAA-AAAA' }]);
    const uids = await ensureAccountUids(['a', 'b', 'b', ''], db, () => 'SOL-BBBB-BBBB');
    expect(Object.fromEntries(uids)).toEqual({ a: 'SOL-AAAA-AAAA', b: 'SOL-BBBB-BBBB' });
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0]?.[0]).toEqual({
      data: [{ userId: 'b', uid: 'SOL-BBBB-BBBB' }],
      skipDuplicates: true,
    });
    expect(rows).toHaveLength(2);
  });

  it('collisione con un UID già preso: riprova con un altro, mai doppioni', async () => {
    const { db, rows } = fakeDb(['a', 'b'], [{ userId: 'a', uid: 'SOL-AAAA-AAAA' }]);
    const next = ['SOL-AAAA-AAAA', 'SOL-AAAA-AAAA', 'SOL-CCCC-CCCC'];
    const uids = await ensureAccountUids(['b'], db, () => next.shift() ?? 'SOL-ZZZZ-ZZZZ');
    expect(uids.get('b')).toBe('SOL-CCCC-CCCC');
    expect(new Set(rows.map((row) => row.uid)).size).toBe(rows.length);
  });

  it('nessun id: nessuna lettura', async () => {
    const { db } = fakeDb([]);
    expect((await ensureAccountUids([], db)).size).toBe(0);
    expect(
      (db as unknown as { userUid: { findMany: ReturnType<typeof vi.fn> } }).userUid.findMany,
    ).not.toHaveBeenCalled();
  });
});

describe('backfillAccountUids', () => {
  it('tutti già assegnati: due conteggi e basta', async () => {
    const { db, createMany } = fakeDb(['a'], [{ userId: 'a', uid: 'SOL-AAAA-AAAA' }]);
    expect(await backfillAccountUids(db)).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('assegna l’UID a tutti gli account che non l’hanno', async () => {
    const ids = Array.from({ length: 7 }, (_, index) => `user-${index}`);
    const { db, rows } = fakeDb(ids, [{ userId: 'user-3', uid: 'SOL-3333-3333' }]);
    expect(await backfillAccountUids(db)).toBe(6);
    expect(rows.map((row) => row.userId).sort()).toEqual(ids.sort());
    for (const row of rows) expect(row.uid).toMatch(ACCOUNT_UID_PATTERN);
    // Di nuovo: niente da fare.
    expect(await backfillAccountUids(db)).toBe(0);
  });
});
