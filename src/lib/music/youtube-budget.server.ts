// @polsia:user-owned — budget giornaliero della quota YouTube Data API. Una ricerca (search.list)
// è la chiamata più cara: Google ne concede circa 100 al giorno per progetto (o 100 delle 10.000
// unità), e una ricerca nuova di pochi utenti esaurirebbe la quota per tutti. Si conta solo
// quando una chiamata arriva davvero a YouTube (le risposte salvate non costano nulla).
//
// Contatori atomici per giorno del Pacifico (quando Google azzera la quota, 9:00 in Italia):
// un'unica istruzione UPDATE … WHERE count < tetto, senza transazioni: concorrenza e
// database lento non possono far passare ricerche in più. Se il contatore non è leggibile la
// ricerca NON parte (si usano i risultati salvati). Quando YouTube risponde "quota finita",
// un blocco ferma le chiamate dello stesso tipo per 30 minuti; poi una sola ricerca di prova
// riprova (una chiamata rifiutata per quota non consuma quota): se riesce il blocco cade,
// altrimenti dura altri 30 minuti. Così un "quota finita" passeggero (subito dopo
// l'azzeramento, o un limite al minuto) non spegne la ricerca per tutto il giorno.
import 'server-only';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { consumeRateLimit } from '@/lib/business/rate-limit.server';
import { prisma } from '@/lib/db';
import {
  nextYouTubeQuotaReset,
  youtubeQuotaDay,
  youtubeQuotaDayStart,
} from '@/lib/music/youtube-query';
import type {
  YouTubeSearchResult,
  YouTubeUnavailableReason,
} from '@/lib/music/youtube-search.server';

export { youtubeQuotaDay };

/**
 * search.list calls per quota day for the whole app: 85 of the ~100 YouTube allows (8,500 of
 * 10,000 units under the older accounting), so the 1-unit calls always keep some headroom.
 */
export const YOUTUBE_SEARCH_DAILY_CAP = 85;
/** Shares of that pool for fixed or automatic searches, so listeners keep most of it. */
export const YOUTUBE_SEARCH_PURPOSE_CAPS = { genre: 15, song: 20 } as const;
/** 1-unit calls counted here (re-checks of saved results, charts, video details, library) per day. */
export const YOUTUBE_UNITS_DAILY_CAP = 1_000;
/**
 * Shares of that pool for the calls that are not re-checks of saved searches, so the re-checks
 * (which keep the saved-results fallback alive) always keep at least 400 units: anonymous video
 * details, chart refreshes and library writes can never starve them. Uncounted: the monitor's
 * quota check, bounded by its own run limits (about 100 a day) inside the remaining headroom.
 */
export const YOUTUBE_UNITS_PURPOSE_CAPS = { chart: 200, details: 50, library: 350 } as const;
/** Usage rows older than this are removed by the daily cleanup. */
export const YOUTUBE_QUOTA_USAGE_KEEP_MS = 3 * 24 * 60 * 60 * 1000;
/** How long a "quota exceeded" answer from YouTube stops calls of that kind before a new try. */
export const YOUTUBE_BLOCK_RETRY_MS = 30 * 60 * 1000;

/** Who a search is for: a listener (with a per-person share), a genre page or an imported song. */
export type YouTubeSearchPurpose = 'listener' | keyof typeof YOUTUBE_SEARCH_PURPOSE_CAPS;
/** What a 1-unit call is for: a re-check of saved searches, or a call with its own share. */
export type YouTubeUnitsPurpose = 'recheck' | keyof typeof YOUTUBE_UNITS_PURPOSE_CAPS;
export type YouTubeSearchLoader = (
  term: string,
  maxResults: number,
) => Promise<YouTubeSearchResult>;
export type QuotaDb = Pick<PrismaClient, 'youTubeQuotaUsage' | 'actionRateLimit'>;
type Consume = typeof consumeRateLimit;
type Denial = Extract<
  YouTubeUnavailableReason,
  'personal_limit' | 'budget_exhausted' | 'quota_exceeded' | 'api_error'
>;

const SEARCH = 'search';
const UNITS = 'units';
const BLOCKED_SEARCH = 'blocked:search';
const BLOCKED_UNITS = 'blocked:units';

function denied(reason: Denial): YouTubeSearchResult {
  return { outcome: 'unavailable', videos: [], unavailableReason: reason };
}

/** What a search returns when Solco's daily searches for everyone are used up. */
export const YOUTUBE_BUDGET_EXHAUSTED: YouTubeSearchResult = denied('budget_exhausted');

export type YouTubeQuotaUsage = {
  day: string;
  searches: number;
  searchCap: number;
  genreSearches: number;
  songSearches: number;
  units: number;
  unitsCap: number;
  /** YouTube itself answered "quota exceeded" in the last 30 minutes (YOUTUBE_BLOCK_RETRY_MS). */
  searchBlocked: boolean;
  unitsBlocked: boolean;
  /** When YouTube last answered "quota exceeded" today (null if it did not). */
  searchBlockedAt: Date | null;
  unitsBlockedAt: Date | null;
  resetsAt: Date;
};

function activeBlock(blockedAt: Date | null, now: Date) {
  return blockedAt !== null && now.getTime() - blockedAt.getTime() < YOUTUBE_BLOCK_RETRY_MS;
}

/** Today's counters (missing rows count as zero). Throws if the database cannot be read. */
export async function readYouTubeQuotaUsage(
  now: Date = new Date(),
  db: Pick<QuotaDb, 'youTubeQuotaUsage'> = prisma,
): Promise<YouTubeQuotaUsage> {
  const day = youtubeQuotaDay(now);
  const rows = await db.youTubeQuotaUsage.findMany({ where: { day } });
  const count = (bucket: string) => rows.find((row) => row.bucket === bucket)?.count ?? 0;
  const blockedAt = (bucket: string) =>
    rows.find((row) => row.bucket === bucket && row.count > 0)?.updatedAt ?? null;
  const searchBlockedAt = blockedAt(BLOCKED_SEARCH);
  const unitsBlockedAt = blockedAt(BLOCKED_UNITS);
  return {
    day,
    searches: count(SEARCH),
    searchCap: YOUTUBE_SEARCH_DAILY_CAP,
    genreSearches: count('search:genre'),
    songSearches: count('search:song'),
    units: count(UNITS),
    unitsCap: YOUTUBE_UNITS_DAILY_CAP,
    searchBlocked: activeBlock(searchBlockedAt, now),
    unitsBlocked: activeBlock(unitsBlockedAt, now),
    searchBlockedAt,
    unitsBlockedAt,
    resetsAt: nextYouTubeQuotaReset(now),
  };
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Searches already made today under the previous rate-limit counters, so switching counters in
 * the middle of a quota day never hands out a fresh daily pool (it happened once: the switch to
 * per-day keys restarted the count at zero and the real YouTube quota ran out).
 */
const LEGACY_COUNTERS: Record<string, { action: string; identities: (day: string) => string[] }> = {
  [SEARCH]: { action: 'youtube.search.global', identities: (day) => [`global|${day}`, 'global'] },
  'search:song': { action: 'music.resolve_song.global', identities: () => ['global'] },
};

async function legacyCount(db: QuotaDb, bucket: string, day: string): Promise<number> {
  const legacy = LEGACY_COUNTERS[bucket];
  if (!legacy) return 0;
  const start = youtubeQuotaDayStart(day).getTime();
  // A read error is not hidden: today's row is then not created (seeded at zero it would hand
  // out a fresh pool for the whole day), the search is refused and the next one tries again.
  const rows = await db.actionRateLimit.findMany({
    where: { action: legacy.action, identityHash: { in: legacy.identities(day).map(sha256) } },
    select: { timestamps: true },
  });
  let total = 0;
  for (const row of rows) {
    if (!Array.isArray(row.timestamps)) continue;
    for (const timestamp of row.timestamps) {
      if (typeof timestamp === 'number' && timestamp >= start) total += 1;
    }
  }
  return total;
}

/** Adds `amount` to a counter only if it stays within `cap`. One atomic UPDATE on the hot path. */
async function take(db: QuotaDb, day: string, bucket: string, cap: number, amount = 1) {
  const where = { day, bucket, count: { lte: cap - amount } };
  const data = { count: { increment: amount } };
  if ((await db.youTubeQuotaUsage.updateMany({ where, data })).count > 0) return true;
  // Nothing updated: either the counter is full, or today's row does not exist yet.
  const existing = await db.youTubeQuotaUsage.findUnique({
    where: { day_bucket: { day, bucket } },
    select: { count: true },
  });
  if (existing) return false;
  const seed = Math.min(cap, await legacyCount(db, bucket, day));
  await db.youTubeQuotaUsage.createMany({
    data: [{ day, bucket, count: seed }],
    skipDuplicates: true,
  });
  return (await db.youTubeQuotaUsage.updateMany({ where, data })).count > 0;
}

async function refund(db: QuotaDb, day: string, bucket: string, amount = 1) {
  await db.youTubeQuotaUsage
    .updateMany({
      where: { day, bucket, count: { gte: amount } },
      data: { count: { decrement: amount } },
    })
    .catch(() => undefined);
}

/**
 * The person's own share (20 a day, see 'music.search.youtube'). The app-wide pool is the hard
 * stop and fails closed, so only an explicit "limit reached" blocks here: a hiccup of the
 * per-person limiter does not take search away from everyone.
 */
async function personalShareAllowed(identity: string, day: string, consume: Consume) {
  const decision = await Promise.resolve()
    .then(() => consume('music.search.youtube', `${identity}|${day}`))
    .catch(() => null);
  return !decision || decision.allowed || decision.error !== 'rate_limited';
}

export type YouTubeBudgetOptions = {
  /** Rate-limit identity of the listener (their personal share); null for app searches. */
  identity?: string | null;
  purpose?: YouTubeSearchPurpose;
  now?: Date;
  db?: QuotaDb;
  consume?: Consume;
};

/** `probe`: the search is the one try allowed after a "quota exceeded" block expired. */
export type YouTubeBudgetDecision = { ok: true; probe?: true } | { ok: false; reason: Denial };

/**
 * After a block expired, only one request may try YouTube again: the one that atomically moves
 * the block's time forward (everyone else sees a fresh block and waits).
 */
async function claimProbe(
  db: Pick<QuotaDb, 'youTubeQuotaUsage'>,
  day: string,
  bucket: string,
  now: Date,
) {
  const claimed = await db.youTubeQuotaUsage
    .updateMany({
      where: {
        day,
        bucket,
        updatedAt: { lte: new Date(now.getTime() - YOUTUBE_BLOCK_RETRY_MS) },
      },
      data: { count: { increment: 1 }, updatedAt: now },
    })
    .catch(() => ({ count: 0 }));
  return claimed.count > 0;
}

/** Gives the single try back (its search did not run), unless a newer refusal was written. */
async function releaseProbe(
  db: Pick<QuotaDb, 'youTubeQuotaUsage'>,
  day: string,
  claimedAt: Date,
  previous: Date,
) {
  await db.youTubeQuotaUsage
    .updateMany({
      where: { day, bucket: BLOCKED_SEARCH, updatedAt: claimedAt },
      data: { count: { decrement: 1 }, updatedAt: previous },
    })
    .catch(() => undefined);
}

/**
 * Takes one YouTube search from today's budget. Order: YouTube's own block and the shared pool
 * are only read first (no writes when the pool is already empty); then the purpose share and the
 * shared pool are taken atomically and, after a block, the single new try is claimed; only then
 * the person's share is spent, so a person never loses a search that would not reach YouTube.
 * If the person's share is used up, everything taken is given back.
 */
export async function takeYouTubeSearch(
  options: YouTubeBudgetOptions = {},
): Promise<YouTubeBudgetDecision> {
  const now = options.now ?? new Date();
  const db = options.db ?? prisma;
  const purpose = options.purpose ?? 'listener';
  const day = youtubeQuotaDay(now);
  const purposeBucket = purpose === 'listener' ? null : `search:${purpose}`;
  const purposeCap = purpose === 'listener' ? null : YOUTUBE_SEARCH_PURPOSE_CAPS[purpose];

  let usage: YouTubeQuotaUsage;
  try {
    usage = await readYouTubeQuotaUsage(now, db);
  } catch {
    // Without a readable counter nobody can tell how much quota is left: do not search.
    return { ok: false, reason: 'api_error' };
  }
  if (usage.searchBlocked) return { ok: false, reason: 'quota_exceeded' };
  const purposeUsed =
    purpose === 'genre' ? usage.genreSearches : purpose === 'song' ? usage.songSearches : 0;
  if (usage.searches >= usage.searchCap || (purposeCap !== null && purposeUsed >= purposeCap)) {
    return { ok: false, reason: 'budget_exhausted' };
  }
  // Only what was really taken is given back (a failed take added nothing).
  let purposeTaken = false;
  let poolTaken = false;
  const giveBack = async () => {
    if (purposeTaken && purposeBucket) await refund(db, day, purposeBucket);
    if (poolTaken) await refund(db, day, SEARCH);
  };
  try {
    if (purposeBucket && purposeCap !== null) {
      purposeTaken = await take(db, day, purposeBucket, purposeCap);
      if (!purposeTaken) return { ok: false, reason: 'budget_exhausted' };
    }
    poolTaken = await take(db, day, SEARCH, YOUTUBE_SEARCH_DAILY_CAP);
    if (!poolTaken) {
      await giveBack();
      return { ok: false, reason: 'budget_exhausted' };
    }
  } catch {
    await giveBack();
    return { ok: false, reason: 'api_error' };
  }
  const blockedAt = usage.searchBlockedAt;
  // The block has expired: this search is the single new try, unless another one got there.
  if (blockedAt && !(await claimProbe(db, day, BLOCKED_SEARCH, now))) {
    await giveBack();
    return { ok: false, reason: 'quota_exceeded' };
  }
  if (
    options.identity &&
    !(await personalShareAllowed(options.identity, day, options.consume ?? consumeRateLimit))
  ) {
    await giveBack();
    if (blockedAt) await releaseProbe(db, day, now, blockedAt);
    return { ok: false, reason: 'personal_limit' };
  }
  return blockedAt ? { ok: true, probe: true } : { ok: true };
}

/**
 * Remembers that YouTube refused for quota, so no call of that kind is attempted for the next
 * 30 minutes (each would fail and waste a budget slot and the listener's time). The time is
 * moved forward on every new refusal.
 */
export async function noteYouTubeQuotaExceeded(
  kind: 'search' | 'units',
  now: Date = new Date(),
  db: Pick<QuotaDb, 'youTubeQuotaUsage'> = prisma,
) {
  const day = youtubeQuotaDay(now);
  const bucket = kind === 'search' ? BLOCKED_SEARCH : BLOCKED_UNITS;
  await db.youTubeQuotaUsage
    .upsert({
      where: { day_bucket: { day, bucket } },
      create: { day, bucket, count: 1, updatedAt: now },
      update: { count: { increment: 1 }, updatedAt: now },
    })
    .catch(() => undefined);
}

/** A try after the block answered normally: YouTube searches work again for everyone. */
async function liftYouTubeSearchBlock(now: Date, db: Pick<QuotaDb, 'youTubeQuotaUsage'>) {
  await db.youTubeQuotaUsage
    .deleteMany({
      // Not a block written after this try started (a newer refusal from another instance).
      where: { day: youtubeQuotaDay(now), bucket: BLOCKED_SEARCH, updatedAt: { lte: now } },
    })
    .catch(() => undefined);
}

/** Wraps a YouTube search (called only when no saved result can be used) with the budget. */
export function withYouTubeSearchBudget(
  load: YouTubeSearchLoader,
  options: YouTubeBudgetOptions = {},
): YouTubeSearchLoader {
  return async (term, maxResults) => {
    const now = options.now ?? new Date();
    const decision = await takeYouTubeSearch({ ...options, now });
    if (!decision.ok) return denied(decision.reason);
    const result = await load(term, maxResults);
    const db = options.db ?? prisma;
    if (result.outcome === 'unavailable' && result.unavailableReason === 'quota_exceeded') {
      await noteYouTubeQuotaExceeded('search', now, db);
    } else if (decision.probe && result.outcome !== 'unavailable') {
      await liftYouTubeSearchBlock(now, db);
    }
    return result;
  };
}

/**
 * Takes `amount` 1-unit calls (videos.list and similar) from today's budget; false = do not call.
 * Calls other than re-checks first take from their own share (YOUTUBE_UNITS_PURPOSE_CAPS).
 * A "quota exceeded" block lasts 30 minutes; the next refusal (noteYouTubeQuotaExceeded) renews it.
 */
export async function takeYouTubeUnits(
  amount: number,
  options: { purpose: YouTubeUnitsPurpose; now?: Date; db?: QuotaDb },
): Promise<boolean> {
  const now = options.now ?? new Date();
  const db = options.db ?? prisma;
  const day = youtubeQuotaDay(now);
  const { purpose } = options;
  const share =
    purpose === 'recheck'
      ? null
      : { bucket: `units:${purpose}`, cap: YOUTUBE_UNITS_PURPOSE_CAPS[purpose] };
  let shareTaken = false;
  try {
    const usage = await readYouTubeQuotaUsage(now, db);
    if (usage.unitsBlocked || usage.units + amount > usage.unitsCap) return false;
    if (share) {
      shareTaken = await take(db, day, share.bucket, share.cap, amount);
      if (!shareTaken) return false;
    }
    if (await take(db, day, UNITS, YOUTUBE_UNITS_DAILY_CAP, amount)) return true;
  } catch {
    // Not readable or not writable: do not call (the share taken, if any, is given back).
  }
  if (share && shareTaken) await refund(db, day, share.bucket, amount);
  return false;
}

/** Daily cleanup: counters of past quota days are no longer needed. */
export function deleteOldYouTubeQuotaUsage(
  now: Date = new Date(),
  db: Pick<QuotaDb, 'youTubeQuotaUsage'> = prisma,
) {
  return db.youTubeQuotaUsage.deleteMany({
    where: { updatedAt: { lt: new Date(now.getTime() - YOUTUBE_QUOTA_USAGE_KEEP_MS) } },
  });
}
