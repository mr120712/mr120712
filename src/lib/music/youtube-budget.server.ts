// @polsia:user-owned — budget giornaliero delle ricerche YouTube. Ogni search.list costa 100 delle
// 10.000 unità al giorno: senza un tetto, pochi utenti con ricerche sempre diverse (che saltano la
// cache) esaurirebbero la quota per tutti. Si conta solo quando la ricerca arriva davvero a YouTube.
import 'server-only';
import { consumeRateLimit, type RateLimitAction } from '@/lib/business/rate-limit.server';
import type { YouTubeSearchResult } from '@/lib/music/youtube-search.server';

/** What a search returns when the daily budget is used up: the same shape as an exhausted quota. */
export const YOUTUBE_BUDGET_EXHAUSTED: YouTubeSearchResult = {
  outcome: 'unavailable',
  videos: [],
  unavailableReason: 'quota_exceeded',
};

type Consume = typeof consumeRateLimit;

async function allowed(action: RateLimitAction, identity: string, consume: Consume) {
  const decision = await Promise.resolve()
    .then(() => consume(action, identity))
    .catch(() => null);
  // If the limiter itself is down, do not block searches: the 24 h cache in front of YouTube
  // still protects most of the quota, and YouTube's own quota is the hard stop.
  if (!decision || decision.allowed) return true;
  return decision.error === 'rate_limit_unavailable';
}

/**
 * Takes one YouTube search from the budget: first the person's share (when known), then the
 * app-wide pool, so a person already over their share never uses up the shared pool.
 */
/**
 * The YouTube Data API quota resets at midnight Pacific time (9:00 in Italy). Counting per
 * Pacific day (the date is part of the identity) makes the budget reset at the same moment,
 * instead of a rolling 24 h window that would keep search off long after the real reset.
 */
export function youtubeQuotaDay(now: Date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export async function takeYouTubeSearch(
  identity: string | null = null,
  consume: Consume = consumeRateLimit,
  now: Date = new Date(),
): Promise<boolean> {
  const day = youtubeQuotaDay(now);
  if (identity && !(await allowed('music.search.youtube', `${identity}|${day}`, consume))) {
    return false;
  }
  return allowed('youtube.search.global', `global|${day}`, consume);
}

/** Wraps a YouTube search loader (called only on cache misses) with the budget. */
export function withYouTubeSearchBudget(
  load: () => Promise<YouTubeSearchResult>,
  identity: string | null = null,
  consume: Consume = consumeRateLimit,
): () => Promise<YouTubeSearchResult> {
  return async () =>
    (await takeYouTubeSearch(identity, consume)) ? load() : YOUTUBE_BUDGET_EXHAUSTED;
}
