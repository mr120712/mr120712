// @polsia:user-owned — "Aggiorna da YouTube": risincronizza in loco TUTTE le playlist già importate
// dall'utente nelle rispettive playlist Solco, a specchio esatto. Nessun corpo: le sorgenti si
// ricavano da ciò che l'utente ha già importato. Nessun audio da YouTube: solo riferimenti.
import 'server-only';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { YouTubeSyncResponseSchema } from '@/lib/contracts/youtube-account';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';
import { YouTubeError, youtubeErrorResponse } from '@/lib/youtube-account/client.server';
import {
  notConfiguredResponse,
  withPrivateHeaders,
  youtubeAccountConfig,
  youtubeJson,
} from '@/lib/youtube-account/config.server';
import { deleteConnection, youtubeAuthFor } from '@/lib/youtube-account/connection.server';
import { runYouTubeSync } from '@/lib/youtube-account/import.server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SYNC_BUDGET_MS = 45_000;

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return youtubeJson(
      { error: 'forbidden_origin', message: 'Richiesta non consentita da questa origine.' },
      403,
    );
  }
  const config = youtubeAccountConfig();
  if (!config) return notConfiguredResponse();
  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch {
    return youtubeJson(
      { error: 'unauthorized', message: 'Accedi a Solco per aggiornare da YouTube.' },
      401,
    );
  }

  const limited = await enforceRateLimit('library.import', `user:${user.id}`);
  if (limited) return withPrivateHeaders(limited);

  const deadline = Date.now() + SYNC_BUDGET_MS;
  try {
    const auth = await youtubeAuthFor(user.id, config, { deadline });
    if (!auth) {
      return youtubeJson(
        { error: 'youtube_reauth', message: 'Collega il tuo account YouTube per continuare.' },
        401,
      );
    }
    const result = await runYouTubeSync(user.id, auth, { deadline });
    if (result.failed.some((failure) => failure.error === 'youtube_reauth')) {
      await deleteConnection(user.id);
    }
    return youtubeJson(YouTubeSyncResponseSchema.parse(result));
  } catch (error) {
    if (error instanceof YouTubeError && error.reason === 'reauth') {
      await deleteConnection(user.id);
    }
    return youtubeErrorResponse(error);
  }
}
