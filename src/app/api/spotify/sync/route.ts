// @polsia:user-owned — "Aggiorna da Spotify": risincronizza in loco TUTTE le sorgenti già importate
// dall'utente (brani salvati + ogni playlist importata) nelle rispettive playlist Solco, a specchio
// esatto. Nessun corpo: le sorgenti si ricavano da ciò che l'utente ha già importato. Nessun audio
// da Spotify: i brani si risolvono su YouTube all'ascolto, come per l'importazione.
import 'server-only';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { SpotifySyncResponseSchema } from '@/lib/contracts/spotify';
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
import { runSpotifySync } from '@/lib/spotify/import.server';

export const dynamic = 'force-dynamic';
/** Stesso tetto dell'importazione: molte sorgenti × più pagine Spotify, ben sotto i 60 s. */
export const maxDuration = 60;

const SYNC_BUDGET_MS = 45_000;

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
      { error: 'unauthorized', message: 'Accedi a Solco per aggiornare da Spotify.' },
      401,
    );
  }

  // Stesso limite dell'importazione: leggere l'intera libreria è costoso (chiamate a consumo).
  const limited = await enforceRateLimit('library.import', `user:${user.id}`);
  if (limited) return withPrivateHeaders(limited);

  const deadline = Date.now() + SYNC_BUDGET_MS;
  try {
    const auth = await spotifyAuthFor(user.id, config, { deadline });
    if (!auth) {
      return spotifyJson(
        { error: 'spotify_reauth', message: 'Collega il tuo account Spotify per continuare.' },
        401,
      );
    }
    const result = await runSpotifySync(user.id, auth, { deadline });
    // Revocato durante la sincronizzazione: dimentica i token morti.
    if (result.failed.some((failure) => failure.error === 'spotify_reauth')) {
      await deleteConnection(user.id);
    }
    return spotifyJson(SpotifySyncResponseSchema.parse(result));
  } catch (error) {
    if (error instanceof SpotifyError && error.reason === 'reauth') {
      await deleteConnection(user.id);
    }
    return spotifyErrorResponse(error);
  }
}
