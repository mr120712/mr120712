// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
} from '@/lib/business/rate-limit.server';

beforeEach(() => {
  mocks.rows.clear();
  mocks.findUnique.mockClear();
  mocks.upsert.mockClear();
  mocks.transaction.mockClear();
});

describe('limiti per azione e identità', () => {
  it('mantiene 8 ricerche ogni 10 secondi e 30 al minuto, isolando gli account', async () => {
    const now = Date.now();
    const identity = 'user:artista-a';

    for (let count = 0; count < 8; count += 1) {
      expect(await consumeRateLimit('music.search', identity, now)).toEqual({ allowed: true });
    }
    const burstBlocked = await consumeRateLimit('music.search', identity, now);
    expect(burstBlocked).toMatchObject({ allowed: false, status: 429, retryAfterSeconds: 10 });

    expect(await consumeRateLimit('music.search', 'user:artista-b', now)).toEqual({
      allowed: true,
    });
    expect(await consumeRateLimit('messages.send', identity, now)).toEqual({ allowed: true });
    expect(await consumeRateLimit('music.search', identity, now + 10_000)).toEqual({
      allowed: true,
    });

    const sustainedStart = now + 20_000;
    const sustainedIdentity = 'user:artista-c';
    const schedule = [
      { at: sustainedStart, count: 8 },
      { at: sustainedStart + 10_001, count: 8 },
      { at: sustainedStart + 20_002, count: 8 },
      { at: sustainedStart + 30_003, count: 6 },
    ];
    for (const batch of schedule) {
      for (let count = 0; count < batch.count; count += 1) {
        const result = await consumeRateLimit('music.search', sustainedIdentity, batch.at);
        expect(result.allowed).toBe(true);
      }
    }

    const sustainedBlocked = await consumeRateLimit(
      'music.search',
      sustainedIdentity,
      sustainedStart + 30_003,
    );
    expect(sustainedBlocked).toMatchObject({ allowed: false, status: 429, retryAfterSeconds: 30 });
    expect(
      await consumeRateLimit('music.search', sustainedIdentity, sustainedStart + 60_000),
    ).toEqual({
      allowed: true,
    });
  });

  it('ignora X-Forwarded-For e accetta solo IP validi dai due header fidati', () => {
    expect(
      getRateLimitIdentity(null, new Headers({ 'x-forwarded-for': '198.51.100.4' })),
    ).toBeNull();
    expect(
      getRateLimitIdentity(
        null,
        new Headers({
          'cf-connecting-ip': '203.0.113.8',
          'x-forwarded-for': '198.51.100.4',
        }),
      ),
    ).toBe('ip:203.0.113.8');
    expect(getRateLimitIdentity(null, new Headers({ 'x-real-ip': '2001:db8::8' }))).toBe(
      'ip:2001:db8::8',
    );
    expect(
      getRateLimitIdentity(null, new Headers({ 'cf-connecting-ip': '198.51.100.4, 10.0.0.1' })),
    ).toBeNull();
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
