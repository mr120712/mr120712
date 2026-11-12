// @polsia:user-owned — forma canonica delle ricerche YouTube e giorno della quota.
// Una ricerca (search.list) è la risorsa più scarsa dell'API: query uguali scritte in modo
// diverso ("Perché", "perche", "l’amore", "l'amore", spazi doppi) devono usare lo stesso
// risultato salvato invece di pagare una nuova ricerca. La forma canonica serve solo come
// chiave: a YouTube va il testo scritto dall'ascoltatore ("P!nk", "M¥SS KETA", "C++" restano
// tali). Usabile anche nel browser.

/** Longest query kept in a cache key and sent to YouTube. */
export const YOUTUBE_QUERY_MAX = 200;

// Latin, Greek and Cyrillic accents only: marks of other scripts (Devanagari vowel signs, …)
// are part of the word and stay.
const ACCENTS = /[̀-ͯ]/g;
// Everything that is not a letter, a mark, a digit or "&" (R&B) separates words: quotes,
// apostrophes (’ and '), punctuation, emoji and YouTube's search operators (-, |, ").
const SEPARATORS = /[^\p{L}\p{M}\p{N}&]+/gu;

/**
 * Canonical search text: compatibility forms folded (full-width, ligatures), accents removed,
 * lowercase, punctuation and emoji turned into spaces, spaces collapsed. Only the cache key:
 * folding loses symbols inside words, so YouTube gets youtubeSearchText instead.
 */
export function normalizeYouTubeQuery(query: string): string {
  return query
    .normalize('NFKD')
    .replace(ACCENTS, '')
    .normalize('NFC')
    .toLocaleLowerCase('it-IT')
    .replace(SEPARATORS, ' ')
    .trim()
    .slice(0, YOUTUBE_QUERY_MAX)
    .trim();
}

/**
 * The text sent to YouTube for a search that misses the cache: what the listener typed, with
 * spaces collapsed and the same length limit. The result is saved under the canonical key.
 */
export function youtubeSearchText(query: string): string {
  return query.replace(/\s+/g, ' ').trim().slice(0, YOUTUBE_QUERY_MAX).trim();
}

/** Plain link to YouTube's own search page (opened by the listener: no API data, no quota). */
export function youtubeResultsUrl(query: string): string {
  const url = new URL('https://www.youtube.com/results');
  url.searchParams.set('search_query', query.trim());
  return url.toString();
}

const pacificDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The YouTube Data API quota resets at midnight Pacific time (9:00 in Italy, 8:00 for a few
 * weeks around the daylight-saving changes). Every daily budget is keyed by this day.
 */
export function youtubeQuotaDay(now: Date = new Date()): string {
  return pacificDay.format(now);
}

/** The instant a Pacific day (YYYY-MM-DD) starts: 07:00 UTC in summer time, 08:00 UTC in winter. */
export function youtubeQuotaDayStart(day: string): Date {
  const [year = 1970, month = 1, date = 1] = day.split('-').map(Number);
  for (const hour of [7, 8]) {
    const candidate = new Date(Date.UTC(year, month - 1, date, hour));
    if (
      youtubeQuotaDay(candidate) === day &&
      youtubeQuotaDay(new Date(candidate.getTime() - 1)) !== day
    ) {
      return candidate;
    }
  }
  return new Date(Date.UTC(year, month - 1, date, 8));
}

/** When the quota (and every Solco budget keyed by quota day) starts again. */
export function nextYouTubeQuotaReset(now: Date = new Date()): Date {
  const start = youtubeQuotaDayStart(youtubeQuotaDay(now));
  // 25 h after the start is always inside the next day, even on a 23 h or 25 h DST day.
  return youtubeQuotaDayStart(youtubeQuotaDay(new Date(start.getTime() + 25 * 60 * 60 * 1000)));
}

const romeTime = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  hour: 'numeric',
  minute: '2-digit',
});
const romeDate = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  day: 'numeric',
  month: 'long',
});

/** "9:00" (Italian time) for a reset instant; "8:00" in the DST weeks. */
export function formatItalianTime(value: Date | string): string {
  return romeTime.format(new Date(value));
}

/** "10 novembre" (Italian date) for when a saved result came from YouTube. */
export function formatItalianDate(value: Date | string): string {
  return romeDate.format(new Date(value));
}

/**
 * The same date with its article: "il 10 novembre", "l’8 novembre", "l’11 novembre" (elision
 * before otto and undici), "il 1º novembre" (the first of the month is an ordinal).
 */
export function formatItalianDateWithArticle(value: Date | string): string {
  const parts = romeDate.formatToParts(new Date(value));
  const day = parts.find((part) => part.type === 'day')?.value;
  const date = parts
    .map((part) => (part.type === 'day' && day === '1' ? '1º' : part.value))
    .join('');
  return day === '8' || day === '11' ? `l’${date}` : `il ${date}`;
}
