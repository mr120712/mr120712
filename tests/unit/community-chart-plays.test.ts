// @polsia:user-owned — classifica «Brani più ascoltati dalla community»: un ascolto conta al
// massimo una volta per ascoltatore, per brano, per giorno di Roma; chiave HMAC mai in chiaro e
// diversa per ogni brano e giorno (righe non collegabili); un IPv6 vale per il suo /64; riga e
// incremento nella stessa transazione; l'autore e le richieste senza identità non contano.
// @vitest-environment node
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
// Logica della libreria pubblica con l'interruttore ACCESO (src/lib/features.ts): così resta
// verificata e pronta per la riattivazione. Lo stato spento ha i suoi test (public-uploads-disabled).
vi.mock('@/lib/features', () => ({ publicUploadsEnabled: () => true }));

const SECRET = 'segreto-del-server-per-i-test-0123456789';

const mocks = vi.hoisted(() => ({
  env: { BLOB_READ_WRITE_TOKEN: 'tok_test', BETTER_AUTH_SECRET: '' as string | undefined },
  findUnique: vi.fn(),
  transaction: vi.fn(),
  createMany: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@vercel/blob', () => ({ head: vi.fn(), del: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: mocks.env }));
vi.mock('@/lib/db', () => ({
  prisma: {
    publicUpload: { findUnique: mocks.findUnique, update: mocks.update },
    publicUploadPlay: { createMany: mocks.createMany },
    $transaction: mocks.transaction,
  },
}));

import { networkIdentity } from '@/lib/business/auth-guards.server';
import {
  publicUploadListenerKey,
  publicUploadPlayDay,
  recordPublicUploadPlay,
} from '@/lib/music/public-uploads.server';

const UPLOAD = 'c'.repeat(25);
const OTHER_UPLOAD = 'd'.repeat(25);
const OWNER = 'owner-user-id';
const IP = '203.0.113.7';
/** La rete come la scrive networkIdentity() per un IPv4. */
const NET = `ip:${IP}`;
// 14 novembre 2026, 15:30 a Roma (ora solare, UTC+1).
const NOW = new Date('2026-11-14T14:30:00.000Z');

type PlayRow = { uploadId: string; listenerKey: string; day: string };

/**
 * Database finto in memoria con la stessa semantica di Postgres per quello che serve qui:
 * indice unico (uploadId, listenerKey, day), createMany con skipDuplicates (ON CONFLICT DO
 * NOTHING), e transazioni che tornano allo stato iniziale se la callback lancia.
 */
function fakeDatabase() {
  const plays = new Map<string, PlayRow>();
  const playCount = new Map<string, number>([
    [UPLOAD, 0],
    [OTHER_UPLOAD, 0],
  ]);

  mocks.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    playCount.has(where.id) ? { uploaderUserId: OWNER } : null,
  );
  mocks.createMany.mockImplementation(
    async ({ data, skipDuplicates }: { data: PlayRow[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const row of data) {
        const key = `${row.uploadId}|${row.listenerKey}|${row.day}`;
        if (plays.has(key)) {
          if (!skipDuplicates) throw Object.assign(new Error('unique'), { code: 'P2002' });
          continue;
        }
        plays.set(key, row);
        count += 1;
      }
      return { count };
    },
  );
  mocks.update.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: { id: string };
      data: { playCount: { increment: number } };
    }) => {
      const current = playCount.get(where.id);
      if (current === undefined) throw Object.assign(new Error('missing'), { code: 'P2025' });
      playCount.set(where.id, current + data.playCount.increment);
      return {};
    },
  );
  mocks.transaction.mockImplementation(async (run: (client: unknown) => Promise<unknown>) => {
    const snapshotPlays = new Map(plays);
    const snapshotCounts = new Map(playCount);
    try {
      return await run(transactionClient());
    } catch (error) {
      plays.clear();
      for (const [key, value] of snapshotPlays) plays.set(key, value);
      playCount.clear();
      for (const [key, value] of snapshotCounts) playCount.set(key, value);
      throw error;
    }
  });

  return {
    plays,
    count: (uploadId = UPLOAD) => playCount.get(uploadId) ?? 0,
  };
}

/** Il client della transazione interattiva: gli stessi metodi del client normale. */
function transactionClient() {
  return {
    publicUploadPlay: { createMany: mocks.createMany },
    publicUpload: { update: mocks.update },
  };
}

const DAY = '2026-11-14';

function expectedKey(source: string, uploadId = UPLOAD, day = DAY, secret = SECRET) {
  const subkey = createHmac('sha256', secret).update('solco-public-upload-plays-v1').digest();
  return createHmac('sha256', subkey).update(`${day}|${uploadId}|${source}`).digest('hex');
}

/** La rete di un indirizzo, letta come fa la route (x-real-ip → networkIdentity). */
function networkOf(address: string) {
  return networkIdentity(new Headers({ 'x-real-ip': address }));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.env.BETTER_AUTH_SECRET = SECRET;
});

describe('recordPublicUploadPlay: un ascolto al giorno per ascoltatore', () => {
  it('stesso utente due volte nello stesso giorno → +1', async () => {
    const db = fakeDatabase();
    const listener = { userId: 'user-1', network: NET };
    expect(await recordPublicUploadPlay(UPLOAD, listener, NOW)).toBe(true);
    expect(
      await recordPublicUploadPlay(UPLOAD, listener, new Date('2026-11-14T22:30:00.000Z')),
    ).toBe(false);
    expect(db.count()).toBe(1);
    expect(db.plays.size).toBe(1);
  });

  it('lo stesso utente il giorno dopo → +1 di nuovo', async () => {
    const db = fakeDatabase();
    const listener = { userId: 'user-1', network: null };
    await recordPublicUploadPlay(UPLOAD, listener, NOW);
    expect(
      await recordPublicUploadPlay(UPLOAD, listener, new Date('2026-11-15T09:00:00.000Z')),
    ).toBe(true);
    expect(db.count()).toBe(2);
  });

  it('anonimo con lo stesso IP → conta una volta sola', async () => {
    const db = fakeDatabase();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await recordPublicUploadPlay(UPLOAD, { userId: null, network: NET }, NOW);
    }
    expect(db.count()).toBe(1);
  });

  it('anonimo IPv6: indirizzi diversi dello stesso /64 → conta una volta sola', async () => {
    const db = fakeDatabase();
    const first = networkOf('2001:db8:1234:5678::1');
    const second = networkOf('2001:db8:1234:5678:abcd:ef01:2345:6789');
    expect(first).toBe('ip6:2001:db8:1234:5678::/64');
    expect(second).toBe(first);
    expect(await recordPublicUploadPlay(UPLOAD, { userId: null, network: first }, NOW)).toBe(true);
    expect(await recordPublicUploadPlay(UPLOAD, { userId: null, network: second }, NOW)).toBe(
      false,
    );
    expect(db.count()).toBe(1);
    // Un altro /64 è un altro ascoltatore.
    const other = networkOf('2001:db8:1234:9999::1');
    expect(await recordPublicUploadPlay(UPLOAD, { userId: null, network: other }, NOW)).toBe(true);
    expect(db.count()).toBe(2);
  });

  it('un IPv6 intero (non ridotto al /64) non vale come identità', async () => {
    const db = fakeDatabase();
    expect(
      await recordPublicUploadPlay(UPLOAD, { userId: null, network: 'ip:2001:db8::1' }, NOW),
    ).toBe(false);
    expect(db.count()).toBe(0);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it('ascoltatori diversi → +2 (due utenti, o un utente e un IP)', async () => {
    const db = fakeDatabase();
    await recordPublicUploadPlay(UPLOAD, { userId: 'user-1', network: NET }, NOW);
    await recordPublicUploadPlay(UPLOAD, { userId: 'user-2', network: NET }, NOW);
    expect(db.count()).toBe(2);

    const other = fakeDatabase();
    await recordPublicUploadPlay(UPLOAD, { userId: 'user-1', network: null }, NOW);
    await recordPublicUploadPlay(UPLOAD, { userId: null, network: 'ip:198.51.100.20' }, NOW);
    expect(other.count()).toBe(2);
  });

  it('lo stesso ascoltatore su brani diversi conta per ciascun brano', async () => {
    const db = fakeDatabase();
    const listener = { userId: 'user-1', network: null };
    await recordPublicUploadPlay(UPLOAD, listener, NOW);
    await recordPublicUploadPlay(OTHER_UPLOAD, listener, NOW);
    expect(db.count(UPLOAD)).toBe(1);
    expect(db.count(OTHER_UPLOAD)).toBe(1);
  });

  it('l’autore del brano non conta (nemmeno una volta al giorno)', async () => {
    const db = fakeDatabase();
    expect(await recordPublicUploadPlay(UPLOAD, { userId: OWNER, network: NET }, NOW)).toBe(false);
    expect(db.count()).toBe(0);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.createMany).not.toHaveBeenCalled();
  });

  it('senza sessione e senza IP non conta e non tocca il database', async () => {
    fakeDatabase();
    expect(await recordPublicUploadPlay(UPLOAD, { userId: null, network: null }, NOW)).toBe(false);
    expect(await recordPublicUploadPlay(UPLOAD, { userId: '  ', network: '' }, NOW)).toBe(false);
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('una “rete” che non è un’identità valida non conta', async () => {
    const db = fakeDatabase();
    for (const network of ['anon', '203.0.113.7', 'ip:1.2.3.4, 5.6.7.8', 'ip6:2001:db8::/64']) {
      expect(await recordPublicUploadPlay(UPLOAD, { userId: null, network }, NOW)).toBe(false);
    }
    expect(db.count()).toBe(0);
  });

  it('senza il segreto del server non conta (mai una chiave debole o in chiaro)', async () => {
    const db = fakeDatabase();
    mocks.env.BETTER_AUTH_SECRET = undefined;
    expect(await recordPublicUploadPlay(UPLOAD, { userId: 'user-1', network: NET }, NOW)).toBe(
      false,
    );
    expect(db.count()).toBe(0);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it('brano inesistente: non conta e non lancia', async () => {
    fakeDatabase();
    expect(
      await recordPublicUploadPlay('e'.repeat(25), { userId: 'user-1', network: null }, NOW),
    ).toBe(false);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe('recordPublicUploadPlay: transazione e errori', () => {
  it('inserisce la riga e incrementa playCount nella STESSA transazione, in quest’ordine', async () => {
    fakeDatabase();
    await recordPublicUploadPlay(UPLOAD, { userId: 'user-1', network: NET }, NOW);

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(typeof mocks.transaction.mock.calls[0]?.[0]).toBe('function');
    expect(mocks.createMany).toHaveBeenCalledWith({
      data: [{ uploadId: UPLOAD, listenerKey: expectedKey('u:user-1'), day: '2026-11-14' }],
      skipDuplicates: true,
    });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: UPLOAD },
      data: { playCount: { increment: 1 } },
    });
    const [createOrder] = mocks.createMany.mock.invocationCallOrder;
    const [updateOrder] = mocks.update.mock.invocationCallOrder;
    expect(createOrder).toBeLessThan(updateOrder ?? 0);
    // Nessun incremento fuori dalla transazione.
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it('riga già presente oggi (count 0): nessun incremento', async () => {
    mocks.findUnique.mockResolvedValue({ uploaderUserId: OWNER });
    mocks.transaction.mockImplementation(async (run: (client: unknown) => Promise<unknown>) =>
      run(transactionClient()),
    );
    mocks.createMany.mockResolvedValue({ count: 0 });
    expect(await recordPublicUploadPlay(UPLOAD, { userId: 'user-1', network: null }, NOW)).toBe(
      false,
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('violazione di unicità (P2002, richieste concorrenti): nessun incremento, nessun throw', async () => {
    mocks.findUnique.mockResolvedValue({ uploaderUserId: OWNER });
    mocks.transaction.mockImplementation(async (run: (client: unknown) => Promise<unknown>) =>
      run(transactionClient()),
    );
    mocks.createMany.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(
      recordPublicUploadPlay(UPLOAD, { userId: 'user-1', network: null }, NOW),
    ).resolves.toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('se l’incremento fallisce la riga torna indietro: l’ascolto si può contare dopo', async () => {
    const db = fakeDatabase();
    mocks.update.mockRejectedValueOnce(new Error('db down'));
    const listener = { userId: 'user-1', network: null };
    expect(await recordPublicUploadPlay(UPLOAD, listener, NOW)).toBe(false);
    expect(db.plays.size).toBe(0);
    expect(db.count()).toBe(0);
    expect(await recordPublicUploadPlay(UPLOAD, listener, NOW)).toBe(true);
    expect(db.count()).toBe(1);
  });

  it('database non raggiungibile: non lancia mai verso il player', async () => {
    mocks.findUnique.mockRejectedValue(new Error('db down'));
    await expect(
      recordPublicUploadPlay(UPLOAD, { userId: 'user-1', network: NET }, NOW),
    ).resolves.toBe(false);
  });
});

describe('chiave dell’ascoltatore (HMAC)', () => {
  /** La chiave per il brano e il giorno di riferimento dei test. */
  const keyOf = (listener: { userId: string | null; network: string | null }) =>
    publicUploadListenerKey(listener, UPLOAD, DAY);

  it('è HMAC-SHA256 esadecimale di "<giorno>|<brano>|<fonte>" con la sottochiave del segreto', () => {
    expect(keyOf({ userId: 'user-1', network: null })).toBe(expectedKey('u:user-1'));
    expect(keyOf({ userId: null, network: NET })).toBe(expectedKey(`net:${NET}`));
    expect(keyOf({ userId: 'user-1', network: null })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cambia per ogni brano e per ogni giorno: le righe di una persona non si collegano', async () => {
    const db = fakeDatabase();
    const listener = { userId: 'user-1', network: null };
    const keys = [
      publicUploadListenerKey(listener, UPLOAD, DAY),
      publicUploadListenerKey(listener, OTHER_UPLOAD, DAY),
      publicUploadListenerKey(listener, UPLOAD, '2026-11-20'),
    ];
    expect(new Set(keys).size).toBe(3);
    // Stesso brano e stesso giorno: la chiave resta la stessa, quindi il doppione si riconosce.
    expect(publicUploadListenerKey(listener, UPLOAD, DAY)).toBe(keys[0]);

    await recordPublicUploadPlay(UPLOAD, listener, NOW);
    await recordPublicUploadPlay(OTHER_UPLOAD, listener, NOW);
    await recordPublicUploadPlay(UPLOAD, listener, new Date('2026-11-20T10:00:00.000Z'));
    await recordPublicUploadPlay(UPLOAD, listener, NOW);
    const written = [...db.plays.values()].map((row) => row.listenerKey);
    expect(written).toHaveLength(3);
    expect(new Set(written).size).toBe(3);
  });

  it('non contiene mai l’IP o l’id utente in chiaro, nemmeno nei dati scritti', async () => {
    fakeDatabase();
    const userId = 'utente-riconoscibile-42';
    const ipv6 = '2001:db8:1234:5678::1234';
    const ipv6Network = networkOf(ipv6);
    for (const listener of [
      { userId, network: NET },
      { userId: null, network: NET },
      { userId: null, network: ipv6Network },
    ]) {
      const key = keyOf(listener) ?? '';
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(key).not.toContain(userId);
      expect(key).not.toContain(IP);
      expect(key).not.toContain('2001:db8');
      await recordPublicUploadPlay(UPLOAD, listener, NOW);
    }
    const written = JSON.stringify(mocks.createMany.mock.calls);
    expect(mocks.createMany).toHaveBeenCalledTimes(3);
    expect(written).not.toContain(userId);
    expect(written).not.toContain(IP);
    expect(written).not.toContain('2001:db8');
    // Nemmeno uno SHA-256 semplice (senza segreto) dell'IP: non si ricava provando gli IP.
    expect(written).not.toContain(createHmac('sha256', '').update(`ip:${IP}`).digest('hex'));
  });

  it('con l’accesso conta l’utente (non la rete); senza accesso la rete, in minuscolo', () => {
    expect(keyOf({ userId: 'user-1', network: NET })).toBe(
      keyOf({ userId: 'user-1', network: 'ip:198.51.100.20' }),
    );
    expect(keyOf({ userId: null, network: 'IP6:2001:DB8:1234:5678::/64' })).toBe(
      keyOf({ userId: null, network: 'ip6:2001:db8:1234:5678::/64' }),
    );
  });

  it('dipende dal segreto e separa utenti e reti con lo stesso testo', () => {
    const withSecret = keyOf({ userId: NET, network: null });
    expect(withSecret).not.toBe(keyOf({ userId: null, network: NET }));
    mocks.env.BETTER_AUTH_SECRET = 'un-altro-segreto-0123456789abcdef';
    expect(keyOf({ userId: NET, network: null })).not.toBe(withSecret);
  });
});

describe('giorno di Roma', () => {
  it('mezzanotte di Roma, non di UTC (ora solare, UTC+1)', () => {
    expect(publicUploadPlayDay(new Date('2026-11-14T22:59:59.999Z'))).toBe('2026-11-14');
    expect(publicUploadPlayDay(new Date('2026-11-14T23:00:00.000Z'))).toBe('2026-11-15');
  });

  it('ora legale (UTC+2)', () => {
    expect(publicUploadPlayDay(new Date('2026-07-01T21:59:59.999Z'))).toBe('2026-07-01');
    expect(publicUploadPlayDay(new Date('2026-07-01T22:00:00.000Z'))).toBe('2026-07-02');
  });

  it('stesso giorno UTC ma giorni diversi a Roma → due ascolti; e viceversa uno solo', async () => {
    const db = fakeDatabase();
    const listener = { userId: 'user-1', network: null };
    // 23:30 e 00:30 a Roma: due giorni diversi, anche se in UTC è sempre il 14.
    await recordPublicUploadPlay(UPLOAD, listener, new Date('2026-11-14T22:30:00.000Z'));
    await recordPublicUploadPlay(UPLOAD, listener, new Date('2026-11-14T23:30:00.000Z'));
    expect(db.count()).toBe(2);
    // 00:30 e 09:00 del 15 a Roma: stesso giorno, anche se in UTC sono il 14 e il 15.
    await recordPublicUploadPlay(UPLOAD, listener, new Date('2026-11-15T08:00:00.000Z'));
    expect(db.count()).toBe(2);
    expect([...db.plays.values()].map((row) => row.day).sort()).toEqual([
      '2026-11-14',
      '2026-11-15',
    ]);
  });
});
