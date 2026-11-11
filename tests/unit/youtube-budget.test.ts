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
  youtubeQuotaDay,
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
    const calls = (consume as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]).toBe('music.search.youtube');
    expect(String(calls[0]?.[1])).toMatch(/^user:u1\|\d{4}-\d{2}-\d{2}$/);
    expect(calls[1]?.[0]).toBe('youtube.search.global');
    expect(String(calls[1]?.[1])).toMatch(/^global\|\d{4}-\d{2}-\d{2}$/);
  });

  it('si azzera quando si azzera la quota YouTube: mezzanotte del Pacifico (9:00 in Italia)', () => {
    // 8:59 in Italy (CET) = 23:59 Pacific of the previous day.
    expect(youtubeQuotaDay(new Date('2026-11-12T07:59:00Z'))).toBe('2026-11-11');
    // 9:00 in Italy = midnight Pacific: a new quota day.
    expect(youtubeQuotaDay(new Date('2026-11-12T08:00:00Z'))).toBe('2026-11-12');
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
