// @polsia:user-owned — stato del collegamento Spotify (GET) e "Disconnetti Spotify" (DELETE).
// Disconnettere elimina subito i token salvati; l'utente può revocare l'accesso anche da
// https://www.spotify.com/account/apps/. Disconnettere funziona anche a funzione spenta.
import 'server-only';
import { ConnectionStatusSchema } from '@/lib/contracts/spotify';
import { getSessionUser, requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';
import { spotifyConfig, spotifyJson } from '@/lib/spotify/config.server';
import { connectionState, deleteConnection } from '@/lib/spotify/connection.server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const configured = spotifyConfig() !== null;
  let user: SessionUser | null = null;
  try {
    user = await getSessionUser();
  } catch {
    user = null;
  }
  // Guests see the feature and are sent to sign in by /api/spotify/login.
  const state = configured && user !== null ? await connectionState(user.id) : 'none';
  return spotifyJson(
    ConnectionStatusSchema.parse({
      configured,
      connected: state !== 'none',
      needsReconnect: state === 'outdated',
    }),
  );
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) {
    return spotifyJson(
      { error: 'forbidden_origin', message: 'Richiesta non consentita da questa origine.' },
      403,
    );
  }
  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch {
    return spotifyJson(
      { error: 'unauthorized', message: 'Accedi a Solco per gestire il collegamento con Spotify.' },
      401,
    );
  }
  await deleteConnection(user.id);
  return spotifyJson(
    ConnectionStatusSchema.parse({ configured: spotifyConfig() !== null, connected: false }),
  );
}
