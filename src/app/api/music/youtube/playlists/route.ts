// @polsia:user-owned — le playlist dell'account YouTube collegato (anche private), lette dal vivo a
// ogni richiesta e mai salvate (solo i metadati scelti vengono importati).
import 'server-only';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { YouTubePlaylistsResponseSchema } from '@/lib/contracts/youtube-account';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { YouTubeError, youtubeErrorResponse } from '@/lib/youtube-account/client.server';
import {
  notConfiguredResponse,
  withPrivateHeaders,
  youtubeAccountConfig,
  youtubeJson,
} from '@/lib/youtube-account/config.server';
import { deleteConnection, youtubeAuthFor } from '@/lib/youtube-account/connection.server';
import { listMyPlaylists } from '@/lib/youtube-account/import.server';

export const dynamic = 'force-dynamic';

const READ_BUDGET_MS = 25_000;
const PAGE_TOKEN_PATTERN = /^[A-Za-z0-9_\-=]{1,2048}$/;

export async function GET(request: Request) {
  const config = youtubeAccountConfig();
  if (!config) return notConfiguredResponse();
  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch {
    return youtubeJson(
      { error: 'unauthorized', message: 'Accedi a Solco per vedere le tue playlist YouTube.' },
      401,
    );
  }

  const rawToken = new URL(request.url).searchParams.get('pageToken');
  if (rawToken !== null && !PAGE_TOKEN_PATTERN.test(rawToken)) {
    return youtubeJson(
      { error: 'invalid_request', message: 'La pagina di playlist richiesta non è valida.' },
      400,
    );
  }

  const limited = await enforceRateLimit('youtube.account.read', `user:${user.id}`);
  if (limited) return withPrivateHeaders(limited);

  const deadline = Date.now() + READ_BUDGET_MS;
  try {
    const auth = await youtubeAuthFor(user.id, config, { deadline });
    if (!auth) {
      return youtubeJson(
        { error: 'youtube_reauth', message: 'Collega il tuo account YouTube per continuare.' },
        401,
      );
    }
    const page = await listMyPlaylists(auth, rawToken ?? undefined, { deadline });
    return youtubeJson(YouTubePlaylistsResponseSchema.parse(page));
  } catch (error) {
    if (error instanceof YouTubeError && error.reason === 'reauth') {
      await deleteConnection(user.id);
    }
    return youtubeErrorResponse(error);
  }
}
