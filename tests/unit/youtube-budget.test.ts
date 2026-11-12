// @polsia:user-owned
// @vitest-environment node
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import type { RateLimitDecision } from '@/lib/business/rate-limit.server';
import {
  deleteOldYouTubeQuotaUsage,
  readYouTubeQuotaUsage,
  takeYouTubeSearch,
  takeYouTubeUnits,
  withYouTubeSearchBudget,
  YOUTUBE_BLOCK_RETRY_MS,
  YOUTUBE_QUOTA_USAGE_KEEP_MS,
  YOUTUBE_SEARCH_DAILY_CAP,
  YOUTUBE_SEARCH_PURPOSE_CAPS,
  YOUTUBE_UNITS_DAILY_CAP,
  YOUTUBE_UNITS_PURPOSE_CAPS,
  youtubeQuotaDay,
} from '@/lib/music/youtube-budget.server';
import { createYouTubeDbFake, type YouTubeDbFake } from './support/youtube-db-fake';

// 11:00 in Italy on 11 Nov = 02:00 Pacific: quota day 2026-11-11 (started 08:00 UTC).
const NOW = new Date('2026-11-11T10:00:00Z');
const DAY = '2026-11-11';

const ok: RateLimitDecision = { allowed: true };
const personalLimit = {
  allowed: false,
  retryAfterSeconds: 60,
  status: 429,
  error: 'rate_limited',
  message: 'x',
} as RateLimitDecision;
const limiterDown = {
  allowed: false,
  retryAfterSeconds: 5,
  status: 503,
  error: 'rate_limit_unavailable',
  message: 'x',
} as RateLimitDecision;

let db: YouTubeDbFake;
beforeEach(() => {
  db = createYouTubeDbFake();
});

function consumer(decision: RateLimitDecision = ok) {
  return vi.fn(async () => decision);
}

const take = (options: Parameters<typeof takeYouTubeSearch>[0] = {}) =>
  takeYouTubeSearch({ now: NOW, db: db as never, consume: consumer() as never, ...options });

describe('budget giornaliero delle ricerche YouTube', () => {
  it('conta la quota della persona e quella di tutta l’app per giorno del Pacifico', async () => {
    const consume = consumer();
    await expect(take({ identity: 'user:u1', consume: consume as never })).resolves.toEqual({
      ok: true,
    });
    expect(consume).toHaveBeenCalledWith('music.search.youtube', `user:u1|${DAY}`);
    expect(db.usage.get(`${DAY}|search`)).toBe(1);
  });

  it('si azzera quando si azzera la quota YouTube: mezzanotte del Pacifico (9:00 in Italia)', async () => {
    // 8:59 in Italy (CET) = 23:59 Pacific of the previous day.
    expect(youtubeQuotaDay(new Date('2026-11-12T07:59:00Z'))).toBe('2026-11-11');
    expect(youtubeQuotaDay(new Date('2026-11-12T08:00:00Z'))).toBe('2026-11-12');
    db.usage.set(`${DAY}|search`, YOUTUBE_SEARCH_DAILY_CAP);
    await expect(take()).resolves.toEqual({ ok: false, reason: 'budget_exhausted' });
    await expect(take({ now: new Date('2026-11-12T08:00:00Z') })).resolves.toEqual({ ok: true });
  });

  it('a pool comune finito non consuma la quota personale', async () => {
    db.usage.set(`${DAY}|search`, YOUTUBE_SEARCH_DAILY_CAP);
    const consume = consumer();
    await expect(take({ identity: 'ip:1.2.3.4', consume: consume as never })).resolves.toEqual({
      ok: false,
      reason: 'budget_exhausted',
    });
    expect(consume).not.toHaveBeenCalled();
  });

  it('distingue le ricerche personali finite e non tocca il pool comune', async () => {
    await expect(
      take({ identity: 'user:u1', consume: consumer(personalLimit) as never }),
    ).resolves.toEqual({ ok: false, reason: 'personal_limit' });
    // The slot taken before the personal share is given back.
    expect(db.usage.get(`${DAY}|search`) ?? 0).toBe(0);
    await expect(
      take({ purpose: 'genre', identity: 'user:u1', consume: consumer(personalLimit) as never }),
    ).resolves.toEqual({ ok: false, reason: 'personal_limit' });
    expect(db.usage.get(`${DAY}|search:genre`) ?? 0).toBe(0);
  });

  it('con molte richieste contemporanee la quota personale si spende solo per ricerche vere', async () => {
    // Pool at 84/85: only one search can still run.
    db.usage.set(`${DAY}|search`, YOUTUBE_SEARCH_DAILY_CAP - 1);
    const consume = consumer();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        take({ identity: `user:u${index}`, consume: consume as never }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(consume).toHaveBeenCalledOnce();

    // After an expired block: only the single new try spends a personal slot.
    db.reset();
    db.usage.set(`${DAY}|blocked:search`, 1);
    db.updated.set(`${DAY}|blocked:search`, new Date(NOW.getTime() - YOUTUBE_BLOCK_RETRY_MS));
    const afterBlock = consumer();
    const tries = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        take({ identity: `user:u${index}`, consume: afterBlock as never }),
      ),
    );
    expect(tries.filter((result) => result.ok)).toEqual([{ ok: true, probe: true }]);
    expect(afterBlock).toHaveBeenCalledOnce();
  });

  it('se la quota personale è finita, il tentativo dopo il blocco resta per un altro', async () => {
    const blockedAt = new Date(NOW.getTime() - YOUTUBE_BLOCK_RETRY_MS);
    db.usage.set(`${DAY}|blocked:search`, 1);
    db.updated.set(`${DAY}|blocked:search`, blockedAt);
    await expect(
      take({ identity: 'user:u1', consume: consumer(personalLimit) as never }),
    ).resolves.toEqual({ ok: false, reason: 'personal_limit' });
    expect(db.updated.get(`${DAY}|blocked:search`)).toEqual(blockedAt);
    expect(db.usage.get(`${DAY}|blocked:search`)).toBe(1);
    expect(db.usage.get(`${DAY}|search`)).toBe(0);
    await expect(take({ identity: 'user:u2' })).resolves.toEqual({ ok: true, probe: true });
  });

  it('se la quota del genere non si può scrivere non ne toglie una ad altri', async () => {
    db.usage.set(`${DAY}|search:genre`, 10);
    db.usage.set(`${DAY}|search`, 10);
    db.youTubeQuotaUsage.updateMany.mockRejectedValueOnce(new Error('db down'));
    await expect(take({ purpose: 'genre' })).resolves.toEqual({ ok: false, reason: 'api_error' });
    expect(db.usage.get(`${DAY}|search:genre`)).toBe(10);
    expect(db.usage.get(`${DAY}|search`)).toBe(10);
  });

  it('un limitatore personale non raggiungibile non blocca: il pool comune resta il tetto', async () => {
    await expect(
      take({ identity: 'user:u1', consume: consumer(limiterDown) as never }),
    ).resolves.toEqual({ ok: true });
    const throwing = vi.fn(async () => {
      throw new Error('db down');
    });
    await expect(take({ identity: 'user:u1', consume: throwing as never })).resolves.toEqual({
      ok: true,
    });
  });

  it('se il contatore comune non è leggibile non cerca su YouTube (fail closed)', async () => {
    db.youTubeQuotaUsage.findMany.mockRejectedValueOnce(new Error('db down'));
    const load = vi.fn();
    const wrapped = withYouTubeSearchBudget(load, { now: NOW, db: db as never });
    await expect(wrapped('jazz', 25)).resolves.toEqual({
      outcome: 'unavailable',
      videos: [],
      unavailableReason: 'api_error',
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('non supera mai il tetto, anche con molte ricerche contemporanee', async () => {
    const results = await Promise.all(Array.from({ length: 120 }, () => take()));
    expect(results.filter((result) => result.ok)).toHaveLength(YOUTUBE_SEARCH_DAILY_CAP);
    expect(db.usage.get(`${DAY}|search`)).toBe(YOUTUBE_SEARCH_DAILY_CAP);
  });

  it('i generi e i brani importati hanno una quota propria dentro il pool', async () => {
    for (let index = 0; index < YOUTUBE_SEARCH_PURPOSE_CAPS.genre; index += 1) {
      await expect(take({ purpose: 'genre' })).resolves.toEqual({ ok: true });
    }
    await expect(take({ purpose: 'genre' })).resolves.toEqual({
      ok: false,
      reason: 'budget_exhausted',
    });
    expect(db.usage.get(`${DAY}|search`)).toBe(YOUTUBE_SEARCH_PURPOSE_CAPS.genre);
    // Listeners still search.
    await expect(take()).resolves.toEqual({ ok: true });
    await expect(take({ purpose: 'song' })).resolves.toEqual({ ok: true });
    expect(db.usage.get(`${DAY}|search:song`)).toBe(1);
  });

  it('restituisce la quota del genere se il pool comune si riempie nel frattempo', async () => {
    // The pool looks free when read, then fills before the atomic take.
    db.youTubeQuotaUsage.findMany.mockResolvedValueOnce([]);
    db.usage.set(`${DAY}|search`, YOUTUBE_SEARCH_DAILY_CAP);
    await expect(take({ purpose: 'genre' })).resolves.toEqual({
      ok: false,
      reason: 'budget_exhausted',
    });
    expect(db.usage.get(`${DAY}|search:genre`)).toBe(0);
  });

  it('riporta le ricerche già fatte oggi con i vecchi contatori (cambio a metà giornata)', async () => {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const dayStart = Date.parse('2026-11-11T08:00:00Z');
    db.legacy.push(
      {
        action: 'youtube.search.global',
        identityHash: hash('global'),
        // 50 this morning (counted) + 30 yesterday afternoon (other quota day, not counted).
        timestamps: [
          ...Array.from({ length: 50 }, (_, index) => dayStart + 1000 * (index + 1)),
          ...Array.from({ length: 30 }, (_, index) => dayStart - 1000 * (index + 1)),
        ],
      },
      {
        action: 'youtube.search.global',
        identityHash: hash(`global|${DAY}`),
        timestamps: Array.from({ length: 30 }, (_, index) => dayStart + 60_000 * (index + 1)),
      },
    );
    await expect(take()).resolves.toEqual({ ok: true });
    expect(db.usage.get(`${DAY}|search`)).toBe(81);
    const results = await Promise.all(Array.from({ length: 10 }, () => take()));
    expect(results.filter((result) => result.ok)).toHaveLength(YOUTUBE_SEARCH_DAILY_CAP - 81);
  });

  it('se i vecchi contatori non sono leggibili non riparte da zero', async () => {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const dayStart = Date.parse('2026-11-11T08:00:00Z');
    db.legacy.push({
      action: 'youtube.search.global',
      identityHash: hash(`global|${DAY}`),
      timestamps: Array.from({ length: 84 }, (_, index) => dayStart + 1000 * (index + 1)),
    });
    db.actionRateLimit.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(take()).resolves.toEqual({ ok: false, reason: 'api_error' });
    // No row seeded at zero: the next search reads the old count again.
    expect(db.usage.has(`${DAY}|search`)).toBe(false);
    await expect(take()).resolves.toEqual({ ok: true });
    expect(db.usage.get(`${DAY}|search`)).toBe(85);
    await expect(take()).resolves.toEqual({ ok: false, reason: 'budget_exhausted' });
  });

  it('dopo "quota esaurita" da YouTube non chiama YouTube per 30 minuti né il giorno dopo', async () => {
    const quota = vi.fn(async () => ({
      outcome: 'unavailable' as const,
      videos: [],
      unavailableReason: 'quota_exceeded' as const,
    }));
    const consume = consumer();
    const wrapped = withYouTubeSearchBudget(quota, {
      now: NOW,
      db: db as never,
      identity: 'user:u1',
      consume: consume as never,
    });
    await wrapped('jazz', 25);
    expect(quota).toHaveBeenCalledOnce();
    await expect(wrapped('rock', 25)).resolves.toMatchObject({
      unavailableReason: 'quota_exceeded',
    });
    expect(quota).toHaveBeenCalledOnce();
    // The person's share is not spent while YouTube is blocked.
    expect(consume).toHaveBeenCalledOnce();
    const tomorrow = withYouTubeSearchBudget(quota, {
      now: new Date('2026-11-12T08:00:00Z'),
      db: db as never,
    });
    await tomorrow('jazz', 25);
    expect(quota).toHaveBeenCalledTimes(2);
  });

  it('un "quota esaurita" subito dopo l’azzeramento non blocca tutto il giorno', async () => {
    // 00:01 Pacific time on 11 Nov (08:01 UTC): Google's counters may not have rolled over yet.
    const at = (minutes: number) => new Date(Date.UTC(2026, 10, 11, 8, minutes));
    const answers = [
      { outcome: 'unavailable' as const, videos: [], unavailableReason: 'quota_exceeded' as const },
      { outcome: 'results' as const, videos: [] },
    ];
    const load = vi.fn(
      async () => answers.shift() ?? { outcome: 'no_results' as const, videos: [] },
    );
    const search = (minutes: number) =>
      withYouTubeSearchBudget(load, { now: at(minutes), db: db as never })('jazz', 25);

    await search(1);
    expect(load).toHaveBeenCalledOnce();
    // Blocked for the next 30 minutes: YouTube is not asked.
    await expect(search(20)).resolves.toMatchObject({ unavailableReason: 'quota_exceeded' });
    expect(load).toHaveBeenCalledOnce();
    expect((await readYouTubeQuotaUsage(at(20), db as never)).searchBlocked).toBe(true);

    // After 30 minutes only one search tries again; another one at the same moment waits.
    const later = 1 + YOUTUBE_BLOCK_RETRY_MS / 60_000;
    const [probe, other] = await Promise.all([search(later), search(later)]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(
      [probe, other].filter((result) => result.unavailableReason === 'quota_exceeded'),
    ).toHaveLength(1);
    // The try worked: the block is lifted and searches work again for everyone.
    expect(db.usage.has(`${DAY}|blocked:search`)).toBe(false);
    await search(later + 1);
    expect(load).toHaveBeenCalledTimes(3);
    // The waiting search did not keep its slot of the shared pool.
    expect(db.usage.get(`${DAY}|search`)).toBe(3);
  });

  it('se anche il tentativo dopo il blocco trova la quota finita, il blocco dura altri 30 minuti', async () => {
    const quota = vi.fn(async () => ({
      outcome: 'unavailable' as const,
      videos: [],
      unavailableReason: 'quota_exceeded' as const,
    }));
    const search = (now: Date) => withYouTubeSearchBudget(quota, { now, db: db as never })('x', 25);
    await search(NOW);
    const retry = new Date(NOW.getTime() + YOUTUBE_BLOCK_RETRY_MS);
    await search(retry);
    expect(quota).toHaveBeenCalledTimes(2);
    await search(new Date(retry.getTime() + YOUTUBE_BLOCK_RETRY_MS - 60_000));
    expect(quota).toHaveBeenCalledTimes(2);
    await search(new Date(retry.getTime() + YOUTUBE_BLOCK_RETRY_MS));
    expect(quota).toHaveBeenCalledTimes(3);
  });

  it('un rallentamento temporaneo di YouTube non blocca la giornata', async () => {
    const busy = vi.fn(async () => ({
      outcome: 'unavailable' as const,
      videos: [],
      unavailableReason: 'rate_limited' as const,
    }));
    const wrapped = withYouTubeSearchBudget(busy, { now: NOW, db: db as never });
    await wrapped('jazz', 25);
    await wrapped('jazz', 25);
    expect(busy).toHaveBeenCalledTimes(2);
    expect((await readYouTubeQuotaUsage(NOW, db as never)).searchBlocked).toBe(false);
  });

  it('passa a YouTube la query e il numero di risultati ricevuti', async () => {
    const load = vi.fn(async () => ({ outcome: 'no_results' as const, videos: [] }));
    await withYouTubeSearchBudget(load, { now: NOW, db: db as never })('vasco rossi', 25);
    expect(load).toHaveBeenCalledWith('vasco rossi', 25);
  });
});

describe('budget delle chiamate da 1 unità', () => {
  const units = (
    purpose: Parameters<typeof takeYouTubeUnits>[1]['purpose'] = 'recheck',
    now: Date = NOW,
  ) => takeYouTubeUnits(1, { purpose, now, db: db as never });

  it('conta le unità con un tetto giornaliero e si ferma dopo "quota esaurita"', async () => {
    await expect(units()).resolves.toBe(true);
    expect(db.usage.get(`${DAY}|units`)).toBe(1);
    db.usage.set(`${DAY}|units`, YOUTUBE_UNITS_DAILY_CAP);
    await expect(units()).resolves.toBe(false);
    db.usage.set(`${DAY}|units`, 0);
    db.usage.set(`${DAY}|blocked:units`, 1);
    db.updated.set(`${DAY}|blocked:units`, new Date(NOW.getTime() - 60_000));
    await expect(units()).resolves.toBe(false);
    // The block expires after 30 minutes (a new refusal would renew it).
    const later = new Date(NOW.getTime() + YOUTUBE_BLOCK_RETRY_MS);
    await expect(units('recheck', later)).resolves.toBe(true);
  });

  it('dettagli video, classifiche e libreria hanno una quota propria: i ricontrolli restano', async () => {
    const reserved =
      YOUTUBE_UNITS_DAILY_CAP -
      Object.values(YOUTUBE_UNITS_PURPOSE_CAPS).reduce((sum, cap) => sum + cap, 0);
    expect(reserved).toBeGreaterThanOrEqual(400);
    // An anonymous client asking random video IDs uses up only the details share.
    const details = await Promise.all(
      Array.from({ length: YOUTUBE_UNITS_PURPOSE_CAPS.details + 20 }, () => units('details')),
    );
    expect(details.filter(Boolean)).toHaveLength(YOUTUBE_UNITS_PURPOSE_CAPS.details);
    expect(db.usage.get(`${DAY}|units`)).toBe(YOUTUBE_UNITS_PURPOSE_CAPS.details);
    await expect(units('recheck')).resolves.toBe(true);
    await expect(units('chart')).resolves.toBe(true);
    // With the pool full, the share taken is given back.
    db.usage.set(`${DAY}|units`, YOUTUBE_UNITS_DAILY_CAP);
    db.youTubeQuotaUsage.findMany.mockResolvedValueOnce([]);
    await expect(units('library')).resolves.toBe(false);
    expect(db.usage.get(`${DAY}|units:library`)).toBe(0);
  });

  it('la pulizia toglie i contatori dei giorni passati', async () => {
    await deleteOldYouTubeQuotaUsage(NOW, db as never);
    expect(db.youTubeQuotaUsage.deleteMany).toHaveBeenCalledWith({
      where: { updatedAt: { lt: new Date(NOW.getTime() - YOUTUBE_QUOTA_USAGE_KEEP_MS) } },
    });
  });
});
