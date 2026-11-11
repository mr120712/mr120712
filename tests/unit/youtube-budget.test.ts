// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import type { RateLimitDecision } from '@/lib/business/rate-limit.server';
import {
  takeYouTubeSearch,
  withYouTubeSearchBudget,
  YOUTUBE_BUDGET_EXHAUSTED,
} from '@/lib/music/youtube-budget.server';

const ok: RateLimitDecision = { allowed: true };
const limited = {
  allowed: false,
  retryAfterSeconds: 60,
  status: 429,
  error: 'rate_limited',
  message: 'x',
} as RateLimitDecision;
const backendDown = {
  allowed: false,
  retryAfterSeconds: 5,
  status: 503,
  error: 'rate_limit_unavailable',
  message: 'x',
} as RateLimitDecision;

function consumer(decisions: Record<string, RateLimitDecision>) {
  return vi.fn(async (action: string) => decisions[action] ?? ok) as never;
}

describe('budget giornaliero delle ricerche YouTube', () => {
  it('conta prima la quota della persona e poi quella di tutta l’app', async () => {
    const consume = consumer({});
    await expect(takeYouTubeSearch('user:u1', consume)).resolves.toBe(true);
    expect((consume as unknown as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ['music.search.youtube', 'user:u1'],
      ['youtube.search.global', 'global'],
    ]);
  });

  it('chi ha finito la sua quota non consuma quella comune', async () => {
    const consume = consumer({ 'music.search.youtube': limited });
    await expect(takeYouTubeSearch('ip:1.2.3.4', consume)).resolves.toBe(false);
    expect((consume as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('blocca quando la quota comune è finita, anche senza identità', async () => {
    await expect(
      takeYouTubeSearch(null, consumer({ 'youtube.search.global': limited })),
    ).resolves.toBe(false);
  });

  it('non blocca le ricerche se il limitatore non è raggiungibile', async () => {
    await expect(
      takeYouTubeSearch('user:u1', consumer({ 'youtube.search.global': backendDown })),
    ).resolves.toBe(true);
    const throwing = vi.fn(async () => {
      throw new Error('db down');
    }) as never;
    await expect(takeYouTubeSearch('user:u1', throwing)).resolves.toBe(true);
  });

  it('a budget finito non chiama YouTube e restituisce "quota esaurita"', async () => {
    const load = vi.fn(async () => ({ outcome: 'results' as const, videos: [] }));
    const wrapped = withYouTubeSearchBudget(
      load,
      'user:u1',
      consumer({ 'youtube.search.global': limited }),
    );
    await expect(wrapped()).resolves.toEqual(YOUTUBE_BUDGET_EXHAUSTED);
    expect(load).not.toHaveBeenCalled();
  });
});
