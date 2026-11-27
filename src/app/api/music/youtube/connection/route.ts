// @polsia:user-owned — stato del collegamento YouTube (GET) e "Disconnetti YouTube" (DELETE).
// Disconnettere elimina subito i token salvati; l'utente può revocare l'accesso anche da
// https://myaccount.google.com/permissions. Disconnettere funziona anche a funzione spenta.
import 'server-only';
import { YouTubeConnectionStatusSchema } from '@/lib/contracts/youtube-account';
import { getSessionUser, requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';
import { youtubeAccountConfig, youtubeJson } from '@/lib/youtube-account/config.server';
import { connectionState, deleteConnection } from '@/lib/youtube-account/connection.server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const configured = youtubeAccountConfig() !== null;
  let user: SessionUser | null = null;
  try {
    user = await getSessionUser();
  } catch {
    user = null;
  }
  const state = configured && user !== null ? await connectionState(user.id) : 'none';
  return youtubeJson(
    YouTubeConnectionStatusSchema.parse({ configured, connected: state !== 'none' }),
  );
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) {
    return youtubeJson(
      { error: 'forbidden_origin', message: 'Richiesta non consentita da questa origine.' },
      403,
    );
  }
  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch {
    return youtubeJson(
      { error: 'unauthorized', message: 'Accedi a Solco per gestire il collegamento con YouTube.' },
      401,
    );
  }
  await deleteConnection(user.id);
  return youtubeJson(
    YouTubeConnectionStatusSchema.parse({
      configured: youtubeAccountConfig() !== null,
      connected: false,
    }),
  );
}
