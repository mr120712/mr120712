// @polsia:user-owned — POST /api/admin/skynet/chat: una domanda a «Skynet» dal pannello in
// Amministrazione → Monitoraggio. Skynet cerca in tutte le sue fonti e risponde
// (src/lib/skynet/chat.server.ts). La chat si protegge così: stessa origine (CSRF), solo
// amministratori con email verificata (controllo prima di qualsiasi lettura), corpo limitato,
// conversazione validata, limite di frequenza per utente; mai segreti né indirizzi IP interi nella
// risposta. Le uniche azioni sono i due comandi dell'autodifesa, riconosciuti dal codice ed eseguiti
// solo per il proprietario (POLSIA_OWNER_EMAIL): gli altri amministratori possono solo chiedere.
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { SkynetChatRequestSchema, SkynetChatResponseSchema } from '@/lib/contracts/skynet-chat';
import { env } from '@/lib/env';
import { sameOrigin } from '@/lib/same-origin';
import { isPanelOwner } from '@/lib/skynet/chat';
import { askSkynet } from '@/lib/skynet/chat.server';

export const dynamic = 'force-dynamic';
/** Le letture (fino a 10 s) e la risposta del modello (26 s, più 12 s della riserva). */
export const maxDuration = 60;

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

function failure(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: privateHeaders });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return failure('forbidden_origin', 403);

  let userId: string;
  let owner: boolean;
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return failure('unauthorized', 401);
    if (session.user.role !== 'admin' || session.user.emailVerified !== true) {
      return failure('forbidden', 403);
    }
    userId = session.user.id;
    owner = isPanelOwner(session.user, env.POLSIA_OWNER_EMAIL);
  } catch {
    return failure('session_unavailable', 503);
  }

  const body = await readJsonLimited(request, 64 * 1024);
  if (!body.ok) return limitedJsonError(body);
  const parsed = SkynetChatRequestSchema.safeParse(body.value);
  if (!parsed.success) return failure('invalid_request', 400);

  const limited = await enforceRateLimit('skynet.chat', `user:${userId}`);
  if (limited) {
    for (const [name, value] of Object.entries(privateHeaders)) limited.headers.set(name, value);
    return limited;
  }

  try {
    const answer = await askSkynet({ messages: parsed.data.messages, source: 'pannello', owner });
    return NextResponse.json(SkynetChatResponseSchema.parse(answer), { headers: privateHeaders });
  } catch {
    return failure('skynet_chat_unavailable', 503);
  }
}
