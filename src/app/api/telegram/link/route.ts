// @polsia:user-owned — genera un token di collegamento per l'utente loggato: il client costruisce
// il deep-link t.me/<bot>?start=<token> e lo apre. Il bot, ricevendo il token, collega l'account.
import 'server-only';
import { NextResponse } from 'next/server';
import { isTelegramBotConfigured } from '@/lib/business/telegram-bot.server';
import { createTelegramLinkToken } from '@/lib/business/telegram-link';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }
  if (!isTelegramBotConfigured()) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }

  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (response) {
    return response as Response;
  }

  return NextResponse.json(
    { token: createTelegramLinkToken(user.id) },
    { headers: { 'Cache-Control': 'private, no-store, no-cache, must-revalidate' } },
  );
}
