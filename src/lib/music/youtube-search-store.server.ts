// @polsia:user-owned — cache delle ricerche YouTube nel database, condivisa da tutte le istanze.
// Una ricerca nuova è la chiamata più scarsa dell'API: la stessa ricerca (nella forma canonica di
// youtube-query.ts) si fa al massimo una volta ogni 24 ore, sempre con 25 risultati, così chi ne
// chiede meno (10) usa lo stesso risultato. Con l'opzione `reuse` una ricerca salvata da 1 a 7
// giorni risponde subito come attuale (video ricontrollati una volta al giorno) e la ricerca
// nuova, se il chiamante la prevede e c'è quota, parte DOPO la risposta, una prova per riga ogni
// 6 ore: chi cerca non aspetta YouTube e la stessa ricerca non costa 100 unità ogni giorno.
// Se YouTube non si può interrogare (quota o budget finiti, errore) si mostra l'ultimo risultato
// salvato, dichiarato come "salvato" con la sua data, solo se i suoi dati sono recenti: fino a 7
// giorni da quando YouTube li ha inviati o ricontrollati. Una volta al giorno i video salvati vengono ricontrollati con videos.list
// (1 unità): quelli eliminati, privati, non incorporabili o bloccati in Italia spariscono e
// titoli e canali tornano aggiornati. Un ricontrollo fallito non si ripete prima di un'ora.
// Leggere un risultato non ne allunga mai la vita: la riga si cancella 28 giorni dopo che
// YouTube ha inviato la ricerca (norme API: < 30).
import 'server-only';
import type { Prisma, PrismaClient } from '@prisma/client';
import { after } from 'next/server';
import type { YouTubeVideoSearchResult } from '@/lib/contracts/music';
import { prisma } from '@/lib/db';
import {
  noteYouTubeQuotaExceeded,
  takeYouTubeUnits,
  type YouTubeSearchLoader,
} from '@/lib/music/youtube-budget.server';
import { normalizeYouTubeQuery, youtubeSearchText } from '@/lib/music/youtube-query';
import {
  checkYouTubeVideos,
  type YouTubeSearchResult,
  type YouTubeUnavailableReason,
} from '@/lib/music/youtube-search.server';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Every stored search asks YouTube for this many results: a search costs the same at 10 or 25. */
export const YOUTUBE_SEARCH_FETCH_SIZE = 25;
/** A saved search is reused as current for 24 h. */
export const YOUTUBE_STORE_FRESH_MS = DAY_MS;
/** After that it is shown only when YouTube cannot be searched, labelled as saved, for 28 days. */
export const YOUTUBE_STORE_STALE_MS = 28 * DAY_MS;
/**
 * …and only while its video data is recent: at most 7 days since YouTube sent it or since the
 * last successful re-check. Older saved results whose re-check fails are not shown.
 */
export const YOUTUBE_STORE_UNVERIFIED_MS = 7 * DAY_MS;
/**
 * Saved searches are deleted at this age (daily cleanup and housekeeping on writes): with a
 * daily cleanup nothing is kept longer than about 29 days, under the 30-day API limit.
 */
export const YOUTUBE_STORE_MAX_AGE_MS = 28 * DAY_MS;
/** Saved videos shown again after 24 h are re-checked with YouTube at most once a day. */
export const YOUTUBE_STORE_RECHECK_MS = DAY_MS;
/** After a re-check that could not run (no units, YouTube error), the next try waits 1 h. */
export const YOUTUBE_STORE_RECHECK_BACKOFF_MS = 60 * 60 * 1000;
/**
 * With `reuse`, a saved search up to this old answers at once as current (its videos re-checked
 * once a day) instead of a new search: the same 7 days as saved data shown in general.
 */
export const YOUTUBE_STORE_REUSE_MS = 7 * DAY_MS;
/**
 * A new search after the response is tried at most once per saved search in this time, across
 * instances: the row's expiresAt (unused after the first 24 h) is moved forward as a lease.
 */
export const YOUTUBE_STORE_REFRESH_LEASE_MS = 6 * 60 * 60 * 1000;

/** Runs a task after the response has been sent. */
export type YouTubeBackgroundScheduler = (task: () => Promise<void>) => void;

/**
 * Reuse of saved searches 24 h to 7 days old. `refresh`: the new search run after the response
 * (it applies its own share of the budget), or null to only reuse the saved result.
 */
export type YouTubeSearchReuse = {
  refresh: YouTubeSearchLoader | null;
  schedule?: YouTubeBackgroundScheduler;
};

/** next/server after(): on Vercel the function stays alive until the task ends (waitUntil). */
const afterResponse: YouTubeBackgroundScheduler = (task) => {
  try {
    after(task);
  } catch {
    // Outside a request (a script): start it now, without making anyone wait for it.
    void task().catch(() => undefined);
  }
};

/** Key of a saved search: the canonical query, whatever the number of results asked for. */
export function youtubeStoreKey(query: string) {
  return `q:${normalizeYouTubeQuery(query)}`;
}

/**
 * Keys written before the canonical form (size prefix + NFKC/lowercase only). Read so the saved
 * results of the last weeks still cover searches; they expire with the 28-day limit.
 */
function legacyStoreKeys(query: string) {
  const legacy = query.normalize('NFKC').trim().toLocaleLowerCase('it-IT');
  return [`10:${legacy}`.slice(0, 200), `25:${legacy}`.slice(0, 200)];
}

type SavedSearch = {
  outcome: 'results' | 'no_results';
  videos: YouTubeVideoSearchResult[];
  /** How many results YouTube was asked for. */
  size?: number;
  /** Last time the saved videos were re-checked with videos.list (ISO). */
  checkedAt?: string;
  /** Last re-check that could not run (ISO): no new try before YOUTUBE_STORE_RECHECK_BACKOFF_MS. */
  checkFailedAt?: string;
};

/**
 * A re-checked video takes the current title, channel, thumbnail and date; the saved (short)
 * description stays, since videos.list returns the full text (up to 5,000 characters).
 */
function mergeRecheck(
  saved: YouTubeVideoSearchResult,
  update: YouTubeVideoSearchResult,
): YouTubeVideoSearchResult {
  return {
    ...saved,
    title: update.title,
    channelTitle: update.channelTitle,
    channelId: update.channelId ?? saved.channelId,
    thumbnailUrl: update.thumbnailUrl,
    publishedAt: update.publishedAt ?? saved.publishedAt,
  };
}

function isoTime(value: string | undefined) {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? time : null;
}

function readPayload(value: Prisma.JsonValue): SavedSearch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { outcome?: unknown; videos?: unknown };
  if (
    (record.outcome !== 'results' && record.outcome !== 'no_results') ||
    !Array.isArray(record.videos) ||
    !record.videos.every(
      (video) =>
        typeof video === 'object' &&
        video !== null &&
        typeof (video as { videoId?: unknown }).videoId === 'string',
    )
  ) {
    return null;
  }
  return value as unknown as SavedSearch;
}

/** Current data for saved videos (only those still playable), or null when it cannot be asked. */
export type YouTubeRecheck = (
  videos: YouTubeVideoSearchResult[],
  now: Date,
) => Promise<Map<string, YouTubeVideoSearchResult> | null>;

/** videos.list for the saved IDs: 1 quota unit, counted in the daily 1-unit budget. */
export const recheckSavedYouTubeVideos: YouTubeRecheck = async (videos, now) => {
  const apiKey = process.env.YOUTUBE_DATA_API_KEY?.trim();
  if (!apiKey || videos.length === 0) return null;
  if (!(await takeYouTubeUnits(1, { purpose: 'recheck', now }))) return null;
  const checked = await checkYouTubeVideos(
    videos.map((video) => video.videoId),
    apiKey,
  );
  if (checked.outcome === 'quota_exceeded') await noteYouTubeQuotaExceeded('units', now);
  return checked.outcome === 'checked' ? checked.videos : null;
};

type Store = Pick<PrismaClient, 'youTubeSearchCache'>;
type Options = {
  now?: Date;
  db?: Store;
  recheck?: YouTubeRecheck | null;
  /** Answer with a saved search 24 h to 7 days old instead of waiting for a new one. */
  reuse?: YouTubeSearchReuse;
};

export type StoredYouTubeSearch = {
  result: YouTubeSearchResult;
  /** When YouTube sent these results. */
  fetchedAt: Date;
  /** True when an older saved result is shown because YouTube could not be searched now. */
  stale: boolean;
  /** A saved search 24 h to 7 days old answered as current (option `reuse`). */
  reused?: true;
  /** Why YouTube could not be searched now (set when the search did not reach YouTube). */
  blockedBy?: YouTubeUnavailableReason;
};

type SavedEntry = { key: string; createdAt: Date; payload: SavedSearch; size: number };

/** Saves what YouTube answered (results or none) under the canonical key, for 24 h as current. */
async function saveSearch(
  db: Store,
  key: string,
  outcome: SavedSearch['outcome'],
  videos: YouTubeVideoSearchResult[],
  now: Date,
) {
  const payload: SavedSearch = { outcome, videos, size: YOUTUBE_SEARCH_FETCH_SIZE };
  const data = {
    payload: payload as unknown as Prisma.InputJsonValue,
    createdAt: now,
    expiresAt: new Date(now.getTime() + YOUTUBE_STORE_FRESH_MS),
  };
  await Promise.resolve()
    .then(() =>
      db.youTubeSearchCache.upsert({ where: { key }, create: { key, ...data }, update: data }),
    )
    .catch(() => undefined);
  // Housekeeping now and then (the daily cleanup does the same).
  if (Math.random() < 0.05) {
    await db.youTubeSearchCache
      .deleteMany({
        where: { createdAt: { lt: new Date(now.getTime() - YOUTUBE_STORE_MAX_AGE_MS) } },
      })
      .catch(() => undefined);
  }
}

/**
 * The saved videos, re-checked with YouTube when the last check is a day old (after a failed
 * try, not again for an hour). The new data goes only to the row that was read (if another
 * instance saved a new search under this key meanwhile, older videos must not replace it) and
 * to `entry`, so the same request does not check it twice.
 */
async function recheckedVideos(
  entry: SavedEntry,
  now: Date,
  db: Store,
  recheck: YouTubeRecheck | null,
): Promise<{ videos: YouTubeVideoSearchResult[]; checkedAt: number | null }> {
  let videos = entry.payload.videos;
  let checkedAt = isoTime(entry.payload.checkedAt);
  const failedAt = isoTime(entry.payload.checkFailedAt);
  const lastCheck = checkedAt ?? entry.createdAt.getTime();
  if (
    !recheck ||
    now.getTime() - lastCheck < YOUTUBE_STORE_RECHECK_MS ||
    (failedAt !== null && now.getTime() - failedAt < YOUTUBE_STORE_RECHECK_BACKOFF_MS)
  ) {
    return { videos, checkedAt };
  }
  const playable = await recheck(videos, now).catch(() => null);
  let payload: SavedSearch;
  if (playable) {
    videos = videos.flatMap((video) => {
      const update = playable.get(video.videoId);
      return update ? [mergeRecheck(video, update)] : [];
    });
    checkedAt = now.getTime();
    payload = {
      outcome: videos.length > 0 ? 'results' : 'no_results',
      videos,
      ...(entry.payload.size !== undefined ? { size: entry.payload.size } : {}),
      checkedAt: now.toISOString(),
    };
  } else {
    // Not checked (no key, no units, YouTube error): do not try again on every request.
    payload = { ...entry.payload, checkFailedAt: now.toISOString() };
  }
  entry.payload = payload;
  // Only the video data is refreshed: the row keeps its creation time and its 28-day limit.
  await Promise.resolve()
    .then(() =>
      db.youTubeSearchCache.updateMany({
        where: { key: entry.key, createdAt: entry.createdAt },
        data: { payload: payload as unknown as Prisma.InputJsonValue },
      }),
    )
    .catch(() => undefined);
  return { videos, checkedAt };
}

/**
 * After the response, a new search in place of a reused one. The loader applies its own share of
 * the budget (and may refuse); one try per saved row every YOUTUBE_STORE_REFRESH_LEASE_MS, claimed
 * atomically on the row read, so instances serving the same search do not each spend a search.
 */
function scheduleRefresh(
  reuse: YouTubeSearchReuse,
  entry: SavedEntry,
  key: string,
  text: string,
  now: Date,
  db: Store,
) {
  const refresh = reuse.refresh;
  if (!refresh) return;
  (reuse.schedule ?? afterResponse)(async () => {
    const claimed = await Promise.resolve()
      .then(() =>
        db.youTubeSearchCache.updateMany({
          where: { key: entry.key, createdAt: entry.createdAt, expiresAt: { lte: now } },
          data: { expiresAt: new Date(now.getTime() + YOUTUBE_STORE_REFRESH_LEASE_MS) },
        }),
      )
      .catch(() => ({ count: 0 }));
    if (claimed.count === 0) return;
    const fresh = await refresh(text, YOUTUBE_SEARCH_FETCH_SIZE).catch(() => null);
    if (!fresh || fresh.outcome === 'unavailable') return;
    await saveSearch(db, key, fresh.outcome, fresh.videos, now);
  });
}

export async function storedYouTubeSearch(
  query: string,
  maxResults: number,
  load: YouTubeSearchLoader,
  options: Options = {},
): Promise<YouTubeSearchResult> {
  return (await storedYouTubeSearchWithTime(query, maxResults, load, options)).result;
}

/**
 * Saved result first (24 h); with `reuse`, a saved result up to 7 days old (re-checked once a
 * day, new search scheduled after the response); then YouTube through `load` (which applies the
 * daily budget); then, when YouTube cannot answer, an older saved result marked `stale` (only
 * with recent video data, see YOUTUBE_STORE_UNVERIFIED_MS). `load` receives the listener's text
 * (youtubeSearchText) and YOUTUBE_SEARCH_FETCH_SIZE; the result is saved under the canonical
 * key; callers get at most `maxResults` videos.
 */
export async function storedYouTubeSearchWithTime(
  query: string,
  maxResults: number,
  load: YouTubeSearchLoader,
  options: Options = {},
): Promise<StoredYouTubeSearch> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const recheck = options.recheck === undefined ? recheckSavedYouTubeVideos : options.recheck;
  const term = normalizeYouTubeQuery(query);
  if (!term) return { result: { outcome: 'no_results', videos: [] }, fetchedAt: now, stale: false };
  const key = youtubeStoreKey(query);

  const rows = await Promise.resolve()
    .then(() =>
      db.youTubeSearchCache.findMany({ where: { key: { in: [key, ...legacyStoreKeys(query)] } } }),
    )
    .catch(() => []);
  const saved = rows
    .map((row) => {
      const payload = readPayload(row.payload);
      if (!payload) return null;
      const size = payload.size ?? (Number.parseInt(row.key, 10) || payload.videos.length);
      return { key: row.key, createdAt: row.createdAt, payload, size };
    })
    .filter((entry) => entry !== null)
    .filter((entry) => now.getTime() - entry.createdAt.getTime() < YOUTUBE_STORE_STALE_MS)
    .sort(
      (left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime() ||
        Number(right.key === key) - Number(left.key === key),
    );

  const current = saved.find(
    (entry) =>
      now.getTime() - entry.createdAt.getTime() < YOUTUBE_STORE_FRESH_MS &&
      (entry.payload.outcome === 'no_results' ||
        entry.size >= maxResults ||
        entry.payload.videos.length >= maxResults),
  );
  if (current) {
    return {
      result: {
        outcome: current.payload.outcome,
        videos: current.payload.videos.slice(0, maxResults),
      },
      fetchedAt: current.createdAt,
      stale: false,
    };
  }

  const text = youtubeSearchText(query) || term;
  if (options.reuse) {
    // Saved 24 h to 7 days ago: shown at once, the new search (if any) runs after the response.
    const reusable = saved.find(
      (entry) =>
        now.getTime() - entry.createdAt.getTime() < YOUTUBE_STORE_REUSE_MS &&
        (entry.payload.outcome === 'no_results' ||
          entry.size >= maxResults ||
          entry.payload.videos.length >= maxResults),
    );
    if (reusable) {
      const none = reusable.payload.outcome === 'no_results';
      const { videos } = none ? { videos: [] } : await recheckedVideos(reusable, now, db, recheck);
      // If every saved video is gone, a new search decides (below), as for an older result.
      if (none || videos.length > 0) {
        scheduleRefresh(options.reuse, reusable, key, text, now, db);
        return {
          result: none
            ? { outcome: 'no_results', videos: [] }
            : { outcome: 'results', videos: videos.slice(0, maxResults) },
          fetchedAt: reusable.createdAt,
          stale: false,
          reused: true,
        };
      }
    }
  }

  const fresh = await load(text, YOUTUBE_SEARCH_FETCH_SIZE);
  if (fresh.outcome !== 'unavailable') {
    await saveSearch(db, key, fresh.outcome, fresh.videos, now);
    return {
      result: { outcome: fresh.outcome, videos: fresh.videos.slice(0, maxResults) },
      fetchedAt: now,
      stale: false,
    };
  }

  // YouTube cannot be searched now: the newest saved result with videos, labelled as saved.
  const fallback = saved.find((entry) => entry.payload.videos.length > 0);
  if (!fallback) {
    return { result: fresh, fetchedAt: now, stale: false, blockedBy: fresh.unavailableReason };
  }
  const { videos, checkedAt } = await recheckedVideos(fallback, now, db, recheck);
  // Shown only with recent data: sent by YouTube, or re-checked, within the last 7 days.
  const dataTime = Math.max(fallback.createdAt.getTime(), checkedAt ?? 0);
  if (now.getTime() - dataTime >= YOUTUBE_STORE_UNVERIFIED_MS || videos.length === 0) {
    return { result: fresh, fetchedAt: now, stale: false, blockedBy: fresh.unavailableReason };
  }
  return {
    result: { outcome: 'results', videos: videos.slice(0, maxResults) },
    fetchedAt: fallback.createdAt,
    stale: true,
    blockedBy: fresh.unavailableReason,
  };
}
