// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  count: vi.fn(async () => 0),
  txCount: vi.fn(async () => 0),
  txCreate: vi.fn(async () => ({})),
  hasPremium: vi.fn(async (_userId?: string) => false),
}));

vi.mock('@/lib/business/premium-access.server', () => ({ hasPremiumAccess: mocks.hasPremium }));
vi.mock('@/lib/db', () => ({
  prisma: {
    botUse: { count: mocks.count },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({ botUse: { count: mocks.txCount, create: mocks.txCreate } }),
  },
}));

import {
  botQuotaStatus,
  consumeBotUse,
  FREE_MONTHLY_BOT_USES,
} from '@/lib/business/bot-quota.server';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasPremium.mockResolvedValue(false);
  mocks.count.mockResolvedValue(0);
  mocks.txCount.mockResolvedValue(0);
  mocks.txCreate.mockResolvedValue({});
});

describe('bot-quota · consumeBotUse', () => {
  it('senza utente: login richiesto', async () => {
    const decision = await consumeBotUse(null);
    expect(decision).toEqual({
      allowed: false,
      reason: 'login_required',
      used: 0,
      limit: FREE_MONTHLY_BOT_USES,
      remaining: 0,
    });
  });

  it('Premium: illimitato, nessuna riga scritta', async () => {
    mocks.hasPremium.mockResolvedValue(true);
    const decision = await consumeBotUse({ id: 'u1' });
    expect(decision).toEqual({
      allowed: true,
      premium: true,
      used: 0,
      limit: null,
      remaining: null,
    });
    expect(mocks.txCreate).not.toHaveBeenCalled();
  });

  it('free sotto il limite: registra e scala il residuo', async () => {
    mocks.txCount.mockResolvedValue(5);
    const decision = await consumeBotUse({ id: 'u1' });
    expect(mocks.txCreate).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({ allowed: true, used: 6, limit: 30, remaining: 24 });
  });

  it('free al limite (30): bloccato, nessuna scrittura', async () => {
    mocks.txCount.mockResolvedValue(FREE_MONTHLY_BOT_USES);
    const decision = await consumeBotUse({ id: 'u1' });
    expect(mocks.txCreate).not.toHaveBeenCalled();
    expect(decision).toEqual({
      allowed: false,
      reason: 'quota_reached',
      used: 30,
      limit: 30,
      remaining: 0,
    });
  });
});

describe('bot-quota · botQuotaStatus (senza scrivere)', () => {
  it('Premium: limite null', async () => {
    mocks.hasPremium.mockResolvedValue(true);
    expect(await botQuotaStatus({ id: 'u1' })).toEqual({
      premium: true,
      used: 0,
      limit: null,
      remaining: null,
    });
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it('free: used/limit/remaining dal conteggio del mese', async () => {
    mocks.count.mockResolvedValue(12);
    expect(await botQuotaStatus({ id: 'u1' })).toEqual({
      premium: false,
      used: 12,
      limit: 30,
      remaining: 18,
    });
  });
});
