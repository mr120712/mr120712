// @polsia:user-owned
import 'server-only';
import { type AudiusPlaybackReason, normalizeAudiusTracks } from '@/lib/music/audius';
import {
  AudiusApiError,
  createAudiusApiClient,
  readAudiusApiKey,
} from '@/lib/music/audius-api.server';

export type AudiusPlaybackVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason: AudiusPlaybackReason | 'source_inactive';
      retryAfterSeconds?: number;
    };

type AudiusPlaybackService = {
  configured: boolean;
  check(trackId: string): Promise<AudiusPlaybackVerdict>;
  streamTrack(trackId: string, range?: string | null): Promise<Response>;
};

export function createAudiusPlaybackService(apiKey = readAudiusApiKey()): AudiusPlaybackService {
  const key = apiKey.trim();
  if (!key) {
    return {
      async check(_trackId: string): Promise<AudiusPlaybackVerdict> {
        return { allowed: false, reason: 'source_inactive' };
      },
      async streamTrack(_trackId: string): Promise<Response> {
        throw new AudiusApiError('unavailable', 'Audius non è configurata.');
      },
      configured: false,
    };
  }

  const client = createAudiusApiClient({ apiKey: key });
  return {
    async check(trackId: string): Promise<AudiusPlaybackVerdict> {
      try {
        const payload = await client.getTrack(trackId);
        const track = normalizeAudiusTracks(payload, true).find((item) => item.id === trackId);
        if (!track) return { allowed: false, reason: 'state_unknown' };
        return track.playbackEligible
          ? { allowed: true }
          : { allowed: false, reason: track.playbackReason };
      } catch (error) {
        if (error instanceof AudiusApiError && error.kind === 'rate_limited') {
          return {
            allowed: false,
            reason: 'rate_limited',
            retryAfterSeconds: error.retryAfterSeconds ?? undefined,
          };
        }
        return { allowed: false, reason: 'state_unknown' };
      }
    },
    async streamTrack(trackId: string, range: string | null = null) {
      return client.streamTrack(trackId, range);
    },
    configured: true,
  };
}

export function playbackFailureStatus(reason: AudiusPlaybackReason | 'source_inactive') {
  if (reason === 'rate_limited') return 429;
  if (reason === 'access_denied' || reason === 'gated' || reason === 'not_streamable') return 403;
  return 503;
}
