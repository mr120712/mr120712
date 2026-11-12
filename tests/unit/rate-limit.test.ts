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
