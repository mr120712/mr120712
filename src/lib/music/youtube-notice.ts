// @polsia:user-owned — dallo stato interno di una ricerca YouTube (salvata o no, cosa l'ha
// bloccata, di chi è la quota finita) all'avviso mostrato all'ascoltatore e ai tre motivi del
// contratto condiviso.
import type { MusicSearchSource } from '@/lib/contracts/music';
import type { YouTubeSearchNotice } from '@/lib/contracts/youtube-search';
import { nextYouTubeQuotaReset } from '@/lib/music/youtube-query';
import type { YouTubeUnavailableReason } from '@/lib/music/youtube-search.server';

/**
 * Whose daily share a listener search counts against: a signed-in user's own ('user'), or the
 * connection's for a listener not signed in ('ip': shared behind CGNAT, school or office Wi-Fi).
 */
export type YouTubeShareOwner = 'user' | 'ip';

/** From a rate-limit identity ('user:…' or 'ip:…'). */
export function youtubeShareOwner(identity: string | null | undefined): YouTubeShareOwner {
  return identity?.startsWith('ip:') ? 'ip' : 'user';
}

export function youtubeSearchLimit(
  reason: YouTubeUnavailableReason | undefined,
  owner: YouTubeShareOwner = 'user',
): YouTubeSearchNotice['limit'] {
  switch (reason) {
    case 'personal_limit':
      return owner === 'ip' ? 'connection' : 'personal';
    case 'budget_exhausted':
    case 'quota_exceeded':
      return 'everyone';
    case 'rate_limited':
      return 'busy';
    default:
      return null;
  }
}

export function youtubeSearchNotice(
  stored: { stale: boolean; fetchedAt: Date; blockedBy?: YouTubeUnavailableReason },
  now: Date = new Date(),
  owner: YouTubeShareOwner = 'user',
): YouTubeSearchNotice {
  return {
    freshness: stored.stale ? 'saved' : 'live',
    savedAt: stored.stale ? stored.fetchedAt.toISOString() : null,
    limit: youtubeSearchLimit(stored.blockedBy, owner),
    resetsAt: nextYouTubeQuotaReset(now).toISOString(),
  };
}

/** The shared contract knows three reasons: every "searches are used up" case is a quota. */
export function contractUnavailableReason(
  reason: YouTubeUnavailableReason | undefined,
): MusicSearchSource['unavailableReason'] {
  switch (reason) {
    case undefined:
      return undefined;
    case 'not_configured':
      return 'not_configured';
    case 'quota_exceeded':
    case 'budget_exhausted':
    case 'personal_limit':
      return 'quota_exceeded';
    default:
      return 'api_error';
  }
}
