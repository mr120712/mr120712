// @polsia:user-owned — stato della ricerca YouTube che accompagna i risultati: in tempo reale o
// salvati (con la data in cui YouTube li ha inviati), e quale limite blocca una ricerca nuova.
import { z } from 'zod';
import { MusicSearchResponseSchema } from '@/lib/contracts/music';

export const YouTubeSearchNoticeSchema = z.object({
  /** live: YouTube answered now (or within the last 24 h); saved: an older saved result. */
  freshness: z.enum(['live', 'saved']),
  /** When YouTube sent the results shown (only for saved results). */
  savedAt: z.string().datetime().nullable(),
  /**
   * Why a new YouTube search could not run: the signed-in listener's own daily searches are used
   * up ('personal'), those of this connection (IP address, possibly shared by many people) are
   * used up for a listener not signed in ('connection'), the searches for everyone are used up
   * or YouTube's quota is out ('everyone'), or YouTube is briefly throttling ('busy'). Null when
   * nothing blocked it.
   */
  limit: z.enum(['personal', 'connection', 'everyone', 'busy']).nullable(),
  /** Next reset of YouTube's daily quota (midnight Pacific time). */
  resetsAt: z.string().datetime(),
});

/** /api/music/search and /api/music/genres/[slug]: the usual response plus the YouTube notice. */
export const YouTubeMusicSearchResponseSchema = MusicSearchResponseSchema.extend({
  youtube: YouTubeSearchNoticeSchema.optional(),
});

export type YouTubeSearchNotice = z.infer<typeof YouTubeSearchNoticeSchema>;
export type YouTubeMusicSearchResponse = z.infer<typeof YouTubeMusicSearchResponseSchema>;
