// @polsia:user-owned — importa in Solco le playlist YouTube scelte dall'utente: una playlist di
// Solco per ogni sorgente, con titolo, canale, copertina e link al video. Nessun audio da YouTube:
// i video si riproducono on-demand.
import 'server-only';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  YOUTUBE_IMPORT_MAX_SOURCES,
  YouTubeAccountImportRequestSchema,
  YouTubeAccountImportResponseSchema,
} from '@/lib/contracts/youtube-account';
import { prisma } from '@/lib/db';
import { MAX_PLAYLISTS_PER_USER } from '@/lib/music/collections.server';
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
import { runYouTubeImport, youtubeSourceDb } from '@/lib/youtube-account/import.server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const IMPORT_BUDGET_MS = 45_000;
const MAX_BODY_BYTES = 2 * 1024;

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
      { error: 'unauthorized', message: 'Accedi a Solco per importare le tue playlist.' },
      401,
    );
  }

  const payload = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!payload.ok) return withPrivateHeaders(limitedJsonError(payload));
  const body = YouTubeAccountImportRequestSchema.safeParse(payload.value);
  if (!body.success) {
    return youtubeJson(
      {
        error: 'invalid_request',
        message:
          body.error.issues[0]?.code === 'custom'
            ? body.error.issues[0].message
            : `Scegli da 1 a ${YOUTUBE_IMPORT_MAX_SOURCES} playlist YouTube da importare.`,
      },
      400,
    );
  }

  const limited = await enforceRateLimit('library.import', `user:${user.id}`);
  if (limited) return withPrivateHeaders(limited);

  const playlistIds = body.data.playlistIds;
  // Le playlist già importate si AGGIORNANO in loco: non contano verso il tetto, solo le nuove.
  const alreadyImported = new Set(
    (
      await prisma.userMusicCollection.findMany({
        where: { userId: user.id, youtubeSource: { in: playlistIds.map(youtubeSourceDb) } },
        select: { youtubeSource: true },
      })
    ).map((collection) => collection.youtubeSource),
  );
  const newSources = playlistIds.filter((id) => !alreadyImported.has(youtubeSourceDb(id))).length;

  const playlists = await prisma.userMusicCollection.count({
    where: { userId: user.id, kind: 'playlist' },
  });
  const room = MAX_PLAYLISTS_PER_USER - playlists;
  if (room < newSources) {
    return youtubeJson(
      {
        error: 'limit_reached',
        message:
          room <= 0
            ? `Hai raggiunto il massimo di ${MAX_PLAYLISTS_PER_USER} playlist. Eliminane qualcuna per importarne altre.`
            : `Puoi aggiungere ancora ${room} playlist (massimo ${MAX_PLAYLISTS_PER_USER}). Scegline di meno o eliminane qualcuna.`,
      },
      409,
    );
  }

  const deadline = Date.now() + IMPORT_BUDGET_MS;
  try {
    const auth = await youtubeAuthFor(user.id, config, { deadline });
    if (!auth) {
      return youtubeJson(
        { error: 'youtube_reauth', message: 'Collega il tuo account YouTube per continuare.' },
        401,
      );
    }
    const result = await runYouTubeImport(user.id, playlistIds, auth, { deadline });
    if (result.failed.some((failure) => failure.error === 'youtube_reauth')) {
      await deleteConnection(user.id);
    }
    return youtubeJson(YouTubeAccountImportResponseSchema.parse(result));
  } catch (error) {
    if (error instanceof YouTubeError && error.reason === 'reauth') {
      await deleteConnection(user.id);
    }
    return youtubeErrorResponse(error);
  }
}
