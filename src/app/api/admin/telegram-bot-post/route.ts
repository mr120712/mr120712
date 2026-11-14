// @polsia:user-owned — post dedicato sul canale Telegram che invita ad aprire il bot (POST on-demand
// dell'amministratore). Solo admin verificati, stessa origine, limitato ('telegram.announce.admin').
// Niente dati sensibili: il testo è statico e contiene solo il link pubblico del bot.
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { publishBotInviteNow } from '@/lib/business/build-announcement.server';
import { consumeRateLimit } from '@/lib/business/rate-limit.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

function failure(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status, headers: privateHeaders });
}

function waitText(seconds: number) {
  if (seconds < 60) return seconds === 1 ? '1 secondo' : `${seconds} secondi`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? '1 minuto' : `${minutes} minuti`;
}

type AdminAccess = { allowed: true; userId: string } | { allowed: false; response: Response };

async function requireAdmin(request: Request): Promise<AdminAccess> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return { allowed: false, response: failure('unauthorized', 401) };
    if (session.user.role !== 'admin' || session.user.emailVerified !== true) {
      return { allowed: false, response: failure('forbidden', 403) };
    }
    return { allowed: true, userId: session.user.id };
  } catch {
    return { allowed: false, response: failure('session_unavailable', 503) };
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return failure('forbidden_origin', 403);
  const access = await requireAdmin(request);
  if (!access.allowed) return access.response;

  const decision = await consumeRateLimit('telegram.announce.admin', `user:${access.userId}`);
  if (!decision.allowed) {
    const message =
      decision.status === 429
        ? `Hai pubblicato diversi post di recente. Riprova tra ${waitText(decision.retryAfterSeconds)}.`
        : decision.message;
    return NextResponse.json(
      { error: decision.error, message, retryAfterSeconds: decision.retryAfterSeconds },
      {
        status: decision.status,
        headers: { ...privateHeaders, 'Retry-After': String(decision.retryAfterSeconds) },
      },
    );
  }

  try {
    const result = await publishBotInviteNow();
    return NextResponse.json(result, { headers: privateHeaders });
  } catch {
    return failure('post_failed', 500, {
      message: 'La pubblicazione non è riuscita. Riprova tra qualche minuto.',
    });
  }
}
