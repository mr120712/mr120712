// @polsia:user-owned — le playlist Spotify dell'utente (20 per pagina) e il totale dei brani
// salvati, letti dal vivo da Spotify a ogni richiesta e mai salvati (Spotify Developer Terms).
import 'server-only';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { SpotifyPlaylistsResponseSchema } from '@/lib/contracts/spotify';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { SpotifyError, spotifyErrorResponse } from '@/lib/spotify/client.server';
import {
  notConfiguredResponse,
  spotifyConfig,
  spotifyJson,
  withPrivateHeaders,
} from '@/lib/spotify/config.server';
import { deleteConnection, spotifyAuthFor } from '@/lib/spotify/connection.server';
import { listSpotifyPlaylists, SPOTIFY_MAX_PLAYLIST_OFFSET } from '@/lib/spotify/import.server';

export const dynamic = 'force-dynamic';

const READ_BUDGET_MS = 25_000;

export async function GET(request: Request) {
  const config = spotifyConfig();
  if (!config) return notConfiguredResponse();
  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch {
    return spotifyJson(
      { error: 'unauthorized', message: 'Accedi a Solco per vedere le tue playlist Spotify.' },
      401,
    );
  }

  const rawOffset = new URL(request.url).searchParams.get('offset') ?? '0';
  const offset = /^\d{1,6}$/.test(rawOffset) ? Number(rawOffset) : Number.NaN;
  if (!Number.isInteger(offset) || offset > SPOTIFY_MAX_PLAYLIST_OFFSET) {
    return spotifyJson(
      { error: 'invalid_request', message: 'La pagina di playlist richiesta non è valida.' },
      400,
    );
  }

  const limited = await enforceRateLimit('spotify.read', `user:${user.id}`);
  if (limited) return withPrivateHeaders(limited);

  const deadline = Date.now() + READ_BUDGET_MS;
  try {
    const auth = await spotifyAuthFor(user.id, config, { deadline });
    if (!auth) {
      return spotifyJson(
        { error: 'spotify_reauth', message: 'Collega il tuo account Spotify per continuare.' },
        401,
      );
    }
    const page = await listSpotifyPlaylists(auth, offset, { deadline });
    return spotifyJson(SpotifyPlaylistsResponseSchema.parse(page));
  } catch (error) {
    // Tokens Spotify no longer accepts are useless: forget them so the UI offers to reconnect.
    if (error instanceof SpotifyError && error.reason === 'reauth') {
      await deleteConnection(user.id);
    }
    return spotifyErrorResponse(error);
  }
}
