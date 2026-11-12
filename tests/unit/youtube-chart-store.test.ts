// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import {
  storedYouTubeChart,
  YOUTUBE_CHART_FRESH_MS,
  YOUTUBE_CHART_RETRY_MS,
  YOUTUBE_CHART_STALE_MS,
  type YouTubeChartLoad,
  youtubeChartKey,
} from '@/lib/music/youtube-chart-store.server';
import { createYouTubeDbFake, type YouTubeDbFake } from './support/youtube-db-fake';

const NOW = new Date('2026-11-11T12:00:00Z');
const chart = {
  outcome: 'results' as const,
  videos: [
    {
      provider: 'youtube' as const,
      videoId: 'aaaaaaaaaaa',
      title: 'Hit',
      channelTitle: 'Canale',
      channelId: null,
      description: null,
      publishedAt: null,
      thumbnailUrl: null,
      durationSeconds: 200,
    },
  ],
};

let db: YouTubeDbFake;
beforeEach(() => {
  db = createYouTubeDbFake();
});

const run = (
  load: () => Promise<YouTubeChartLoad>,
  options: {
    now?: Date;
    takeUnit?: () => Promise<boolean>;
    quotaExceeded?: () => Promise<void>;
  } = {},
) =>
  storedYouTubeChart('IT', load, {
    now: options.now ?? NOW,
    db: db as never,
    takeUnit: options.takeUnit ?? (async () => true),
    quotaExceeded: options.quotaExceeded ?? (async () => undefined),
  });
const unavailable = async (): Promise<YouTubeChartLoad> => ({ outcome: 'unavailable', videos: [] });
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe('classifiche YouTube salvate nel database', () => {
  it('chiama YouTube una volta ogni 2 ore per paese, qualunque sia l’URL', async () => {
    const load = vi.fn(async () => chart);
    await run(load);
    await run(load, { now: new Date(NOW.getTime() + YOUTUBE_CHART_FRESH_MS - 1000) });
    expect(load).toHaveBeenCalledOnce();
    expect(db.searches.has(youtubeChartKey('IT'))).toBe(true);
    await run(load, { now: new Date(NOW.getTime() + YOUTUBE_CHART_FRESH_MS) });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a budget finito o con YouTube non disponibile mostra l’ultima classifica (7 giorni)', async () => {
    await run(async () => chart);
    const later = new Date(NOW.getTime() + 3 * 60 * 60 * 1000);
    const load = vi.fn(async () => chart);
    const noBudget = await run(load, { now: later, takeUnit: async () => false });
    expect(noBudget).toEqual({ chart, stale: true, fetchedAt: NOW });
    expect(load).not.toHaveBeenCalled();
    const tooOld = new Date(NOW.getTime() + YOUTUBE_CHART_STALE_MS + 1000);
    const expired = await run(unavailable, { now: tooOld });
    expect(expired).toEqual({
      chart: { outcome: 'unavailable', videos: [] },
      stale: false,
      fetchedAt: null,
    });
  });

  it('dopo un aggiornamento fallito aspetta 30 minuti prima di spendere un’altra unità', async () => {
    await run(async () => chart);
    const takeUnit = vi.fn(async () => true);
    const failing = vi.fn(unavailable);
    const refresh = YOUTUBE_CHART_FRESH_MS;
    for (const minutes of [0, 1, 5, 29]) {
      const result = await run(failing, { now: at(refresh + minutes * 60_000), takeUnit });
      expect(result).toMatchObject({ chart, stale: true });
    }
    expect(failing).toHaveBeenCalledOnce();
    expect(takeUnit).toHaveBeenCalledOnce();
    await run(failing, { now: at(refresh + YOUTUBE_CHART_RETRY_MS), takeUnit });
    expect(failing).toHaveBeenCalledTimes(2);

    // Same without any saved chart: the placeholder row holds the wait.
    db.reset();
    const empty = vi.fn(unavailable);
    await run(empty);
    await run(empty, { now: at(60_000) });
    expect(empty).toHaveBeenCalledOnce();
    expect(await run(async () => chart, { now: at(YOUTUBE_CHART_RETRY_MS) })).toMatchObject({
      chart,
      stale: false,
    });
  });

  it('allo scadere delle 2 ore un solo aggiornamento alla volta', async () => {
    await run(async () => chart);
    const load = vi.fn(async () => chart);
    const takeUnit = vi.fn(async () => true);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => run(load, { now: at(YOUTUBE_CHART_FRESH_MS), takeUnit })),
    );
    expect(takeUnit).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
    expect(results.every((result) => result.chart.videos.length === 1)).toBe(true);
  });

  it('segnala "quota esaurita" al budget delle chiamate da 1 unità', async () => {
    const quotaExceeded = vi.fn(async () => undefined);
    await run(async () => ({ outcome: 'unavailable', videos: [], quotaExceeded: true }), {
      quotaExceeded,
    });
    expect(quotaExceeded).toHaveBeenCalledOnce();
  });
});
