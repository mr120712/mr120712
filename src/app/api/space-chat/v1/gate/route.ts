// @polsia:user-owned — POST /api/space-chat/v1/gate: il cancello dello Space statico privato.
// La pagina presenta UNA volta la chiave lunga (Bearer SPACE_CHAT_API_KEY) dall'origine dello
// Space e riceve un pass di sessione firmato, legato a quell'origine e valido 8 ore: il browser
// conserva solo il pass (sessionStorage), mai la chiave. Origin obbligatorio e ammesso; limite
// 'space.gate' per IP; chiavi sbagliate contano in 'space.auth-fail'. Nessun sameOrigin: chiamata
// cross-origin dallo Space, autenticata dalla chiave (nessun cookie).
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import {
  authorizeSpaceChat,
  issueSpaceChatSession,
  rejectSpaceChat,
  spaceChatClientId,
  spaceChatCors,
} from '@/lib/business/space-chat.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: spaceChatCors(request) });
}

export async function POST(request: Request) {
  const headers = { ...spaceChatCors(request), 'Cache-Control': 'no-store' };
  const auth = authorizeSpaceChat(request, process.env, {
    allowSession: false,
    requireOrigin: true,
  });
  if (!auth.ok) return rejectSpaceChat(request, auth, headers);

  const limited = await enforceRateLimit('space.gate', spaceChatClientId(request));
  if (limited) {
    for (const [name, value] of Object.entries(headers)) limited.headers.set(name, value);
    return limited;
  }

  const session = auth.origin ? issueSpaceChatSession(auth.origin) : null;
  if (!session) {
    return NextResponse.json({ error: { message: 'not_configured' } }, { status: 503, headers });
  }
  return NextResponse.json(
    { token: session.token, expires_at: session.expiresAt, token_type: 'Bearer' },
    { headers },
  );
}
