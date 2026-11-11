// @polsia:user-owned — trasferisce in Solco le playlist Spotify scelte dall'utente (e, se chiesto,
// i suoi brani salvati): una playlist di Solco per ogni sorgente, con titolo, artisti, durata e
// link al brano su Spotify. Nessun audio da Spotify: i brani si cercano su YouTube all'ascolto.
import 'server-only';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  SPOTIFY_IMPORT_MAX_SOURCES,
  SpotifyImportRequestSchema,
  SpotifyImportResponseSchema,
} from '@/lib/contracts/spotify';
import { prisma } from '@/lib/db';
import { MAX_PLAYLISTS_PER_USER } from '@/lib/music/collections.server';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';
import { SpotifyError, spotifyErrorResponse } from '@/lib/spotify/client.server';
import {
  notConfiguredResponse,
  spotifyConfig,
  spotifyJson,
  withPrivateHeaders,
} from '@/lib/spotify/config.server';
import { deleteConnection, spotifyAuthFor } from '@/lib/spotify/connection.server';
import { runSpotifyImport, type SpotifyImportSource } from '@/lib/spotify/import.server';

export const dynamic = 'force-dynamic';
/** 5 sources × (1 + 6 pages) Spotify calls at most; the budget below keeps it far from 60 s. */
export const maxDuration = 60;

const IMPORT_BUDGET_MS = 45_000;
const MAX_BODY_BYTES = 2 * 1024;

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return spotifyJson(
      { error: 'forbidden_origin', message: 'Richiesta non consentita da questa origine.' },
      403,
    );
  }
  const config = spotifyConfig();
  if (!config) return notConfiguredResponse();
  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch {
    return spotifyJson(
      { error: 'unauthorized', message: 'Accedi a Solco per importare le tue playlist.' },
      401,
    );
  }

  const payload = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!payload.ok) return withPrivateHeaders(limitedJsonError(payload));
  const body = SpotifyImportRequestSchema.safeParse(payload.value);
  if (!body.success) {
    return spotifyJson(
      {
        error: 'invalid_request',
        message:
          body.error.issues[0]?.code === 'custom'
            ? body.error.issues[0].message
            : `Scegli da 1 a ${SPOTIFY_IMPORT_MAX_SOURCES} playlist Spotify da importare.`,
      },
      400,
    );
  }

  const limited = await enforceRateLimit('library.import', `user:${user.id}`);
  if (limited) return withPrivateHeaders(limited);

  const sources: SpotifyImportSource[] = [
    ...body.data.playlistIds.map((id) => ({ kind: 'playlist' as const, id })),
    ...(body.data.saved ? [{ kind: 'saved' as const }] : []),
  ];

  // Keep each library bounded: the whole library is loaded on every visit.
  const playlists = await prisma.userMusicCollection.count({
    where: { userId: user.id, kind: 'playlist' },
  });
  const room = MAX_PLAYLISTS_PER_USER - playlists;
  if (room < sources.length) {
    return spotifyJson(
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
    const auth = await spotifyAuthFor(user.id, config, { deadline });
    if (!auth) {
      return spotifyJson(
        { error: 'spotify_reauth', message: 'Collega il tuo account Spotify per continuare.' },
        401,
      );
    }
    const result = await runSpotifyImport(user.id, sources, auth, { deadline });
    // Revoked mid-import (after some playlists were created): forget the dead tokens too.
    if (result.failed.some((failure) => failure.error === 'spotify_reauth')) {
      await deleteConnection(user.id);
    }
    return spotifyJson(SpotifyImportResponseSchema.parse(result));
  } catch (error) {
    if (error instanceof SpotifyError && error.reason === 'reauth') {
      await deleteConnection(user.id);
    }
    return spotifyErrorResponse(error);
  }
}
