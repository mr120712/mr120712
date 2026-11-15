// @polsia:user-owned
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const rows = new Map<string, { action: string; identityHash: string; timestamps: unknown }>();
  const keyFromWhere = (where: { action_identityHash: { action: string; identityHash: string } }) =>
    `${where.action_identityHash.action}:${where.action_identityHash.identityHash}`;
  const findUnique = vi.fn(
    async (args: { where: { action_identityHash: { action: string; identityHash: string } } }) =>
      rows.get(keyFromWhere(args.where)) ?? null,
  );
  const upsert = vi.fn(
    async (args: {
      where: { action_identityHash: { action: string; identityHash: string } };
      create: { action: string; identityHash: string; timestamps: unknown };
      update: { timestamps: unknown };
    }) => {
      const key = keyFromWhere(args.where);
      const current = rows.get(key);
      const next = current ? { ...current, timestamps: args.update.timestamps } : args.create;
      rows.set(key, next);
      return next;
    },
  );
  const client = { actionRateLimit: { findUnique, upsert } };
  const transaction = vi.fn(async (operation: (value: typeof client) => Promise<unknown>) =>
    operation(client),
  );
  return { rows, findUnique, upsert, transaction };
});

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: { $transaction: mocks.transaction } }));

import {
  ACTION_RATE_LIMITS,
  consumeRateLimit,
  enforceRateLimit,
  evaluateRateLimit,
  getRateLimitIdentity,
  RATE_LIMIT_TRANSACTION_ATTEMPTS,
  rateLimitRetryDelayMs,
  releaseRateLimit,
} from '@/lib/business/rate-limit.server';

const defaultTransaction = mocks.transaction.getMockImplementation();

beforeEach(() => {
  mocks.rows.clear();
  mocks.findUnique.mockClear();
  mocks.upsert.mockClear();
  mocks.transaction.mockClear();
  if (defaultTransaction) mocks.transaction.mockImplementation(defaultTransaction);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('limiti per azione e identità', () => {
  it('sulle ricerche tiene solo un tetto anti-raffica generoso, isolando gli account', async () => {
    const now = Date.now();
    const identity = 'user:artista-a';

    // 60 ricerche in 10 secondi passano (di fatto illimitate per un utente vero).
    for (let count = 0; count < 60; count += 1) {
      expect(await consumeRateLimit('music.search', identity, now)).toEqual({ allowed: true });
    }
    const burstBlocked = await consumeRateLimit('music.search', identity, now);
    expect(burstBlocked).toMatchObject({ allowed: false, status: 429, retryAfterSeconds: 10 });

    // Un altro account non è toccato dal tetto del primo.
    expect(await consumeRateLimit('music.search', 'user:artista-b', now)).toEqual({
      allowed: true,
    });
    expect(await consumeRateLimit('messages.send', identity, now)).toEqual({ allowed: true });

    // Passata la finestra di 10 secondi, di nuovo libero.
    expect(await consumeRateLimit('music.search', identity, now + 10_000)).toEqual({
      allowed: true,
    });
  });

  it('ignora X-Forwarded-For e cf-connecting-ip (falsificabili), si fida di x-real-ip', () => {
    expect(
      getRateLimitIdentity(null, new Headers({ 'x-forwarded-for': '198.51.100.4' })),
    ).toBeNull();
    // Without Cloudflare in front, anyone can send cf-connecting-ip: it must not count.
    expect(
      getRateLimitIdentity(null, new Headers({ 'cf-connecting-ip': '203.0.113.8' })),
    ).toBeNull();
    expect(
      getRateLimitIdentity(
        null,
        new Headers({ 'cf-connecting-ip': '203.0.113.8', 'x-real-ip': '198.51.100.7' }),
      ),
    ).toBe('ip:198.51.100.7');
    expect(getRateLimitIdentity(null, new Headers({ 'x-real-ip': '2001:db8::8' }))).toBe(
      'ip:2001:db8::8',
    );
    expect(
      getRateLimitIdentity(null, new Headers({ 'x-real-ip': '198.51.100.4, 10.0.0.1' })),
    ).toBeNull();
  });

  it('con Cloudflare davanti (TRUST_CLOUDFLARE_IP=1) usa cf-connecting-ip', () => {
    vi.stubEnv('TRUST_CLOUDFLARE_IP', '1');
    expect(getRateLimitIdentity(null, new Headers({ 'cf-connecting-ip': '203.0.113.8' }))).toBe(
      'ip:203.0.113.8',
    );
    vi.unstubAllEnvs();
  });

  it('restituisce Retry-After e un messaggio con il tempo di attesa, poi consente il recupero', async () => {
    const identity = 'user:messaggero';
    const now = Date.now();
    const limit = ACTION_RATE_LIMITS['messages.send'][0];
    if (!limit) throw new Error('Limite messaggi non definito.');

    for (let count = 0; count < limit.requests; count += 1) {
      expect(await consumeRateLimit('messages.send', identity, now)).toEqual({ allowed: true });
    }
    const writesBeforeDeniedRequest = mocks.upsert.mock.calls.length;
    const response = await enforceRateLimit('messages.send', identity);
    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toBe('60');
    expect(await response?.json()).toMatchObject({
      error: 'rate_limited',
      message: expect.stringContaining('60 secondi'),
      retryAfterSeconds: 60,
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(writesBeforeDeniedRequest);
    expect(await consumeRateLimit('messages.send', identity, now + 60_000)).toEqual({
      allowed: true,
    });
  });

  it('non modifica lo stato quando un budget è superato', () => {
    const decision = evaluateRateLimit([100, 101], [{ requests: 2, windowMs: 10_000 }], 102);
    expect(decision).toEqual({ allowed: false, retryAfterSeconds: 10 });
  });
});

type RowKey = { action_identityHash: { action: string; identityHash: string } };
const rowKey = (where: RowKey) =>
  `${where.action_identityHash.action}:${where.action_identityHash.identityHash}`;
const conflict = () => Object.assign(new Error('write conflict'), { code: 'P2034' });

describe('richieste concorrenti della stessa identità (es. ~20 copertine della Home)', () => {
  it('attese brevi, crescenti e sparpagliate prima di riprovare', () => {
    expect(rateLimitRetryDelayMs(0, () => 0)).toBe(10);
    expect(rateLimitRetryDelayMs(0, () => 1)).toBe(20);
    expect(rateLimitRetryDelayMs(3, () => 0.5)).toBe(120);
    expect(rateLimitRetryDelayMs(5, () => 1)).toBe(400);
    expect(rateLimitRetryDelayMs(9, () => 1)).toBe(400);
    let total = 0;
    for (let attempt = 0; attempt < RATE_LIMIT_TRANSACTION_ATTEMPTS - 1; attempt += 1) {
      total += rateLimitRetryDelayMs(attempt, () => 1);
    }
    expect(total).toBeLessThanOrEqual(1500);
  });

  it('20 richieste insieme su una riga «serializable»: nessun 503 e conteggio esatto', async () => {
    vi.useFakeTimers();
    let step = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      step += 1;
      return (step * 0.381966) % 1;
    });
    // Transazione finta con controllo dei conflitti: legge la versione della riga e, al momento di
    // scrivere, fallisce con P2034 se nel frattempo un'altra transazione l'ha già cambiata.
    const versions = new Map<string, number>();
    mocks.transaction.mockImplementation(async (operation) => {
      const seen = new Map<string, number>();
      return operation({
        actionRateLimit: {
          findUnique: async (args: { where: RowKey }) => {
            const key = rowKey(args.where);
            seen.set(key, versions.get(key) ?? 0);
            await Promise.resolve();
            return mocks.rows.get(key) ?? null;
          },
          upsert: async (args: {
            where: RowKey;
            create: { action: string; identityHash: string; timestamps: unknown };
            update: { timestamps: unknown };
          }) => {
            const key = rowKey(args.where);
            await Promise.resolve();
            if ((versions.get(key) ?? 0) !== seen.get(key)) throw conflict();
            const current = mocks.rows.get(key);
            const next = current ? { ...current, timestamps: args.update.timestamps } : args.create;
            mocks.rows.set(key, next);
            versions.set(key, (versions.get(key) ?? 0) + 1);
            return next;
          },
        },
      } as never);
    });

    const now = Date.now();
    const pending = Promise.all(
      Array.from({ length: 20 }, () => consumeRateLimit('music.cover', 'ip:203.0.113.7', now)),
    );
    await vi.runAllTimersAsync();
    const decisions = await pending;

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(20);
    const row = [...mocks.rows.values()].find((value) => value.action === 'music.cover');
    expect(Array.isArray(row?.timestamps) ? row.timestamps : []).toHaveLength(20);
    // Ci sono stati davvero dei conflitti (riprovati), non solo transazioni in fila.
    expect(mocks.transaction.mock.calls.length).toBeGreaterThan(20);
  });

  it('conflitto senza fine: dopo l’ultimo tentativo 503 (mai via libera)', async () => {
    vi.useFakeTimers();
    mocks.transaction.mockImplementation(async () => {
      throw conflict();
    });
    const pending = consumeRateLimit('music.cover', 'ip:203.0.113.8');
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      allowed: false,
      status: 503,
      error: 'rate_limit_unavailable',
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(RATE_LIMIT_TRANSACTION_ATTEMPTS);
  });

  it('un errore che non è un conflitto: 503 subito, senza riprovare', async () => {
    mocks.transaction.mockImplementation(async () => {
      throw new Error('database down');
    });
    expect(await consumeRateLimit('music.cover', 'ip:203.0.113.9')).toMatchObject({
      allowed: false,
      status: 503,
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it('il rimborso riprova anche lui sui conflitti e non lancia mai', async () => {
    vi.useFakeTimers();
    let calls = 0;
    mocks.transaction.mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw conflict();
      return undefined;
    });
    const pending = releaseRateLimit('music.cover', 'ip:203.0.113.10');
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });
});
