// @polsia:user-owned — gate di collegamento account ↔ Telegram per l'utente loggato.
//   GET    → stato del collegamento { linked, username }.
//   POST   → genera un codice monouso a scadenza e ritorna il deep-link già pronto da aprire.
//   DELETE → scollega l'account (rimuove il collegamento).
// Tutte richiedono l'accesso; POST/DELETE anche la stessa origine (CSRF). Il bot, ricevendo il
// codice via /start, collega l'account (vedi webhook). Il token del bot non è mai esposto.
import 'server-only';
import { NextResponse } from 'next/server';
import { isTelegramBotConfigured } from '@/lib/business/telegram-bot.server';
import { createTelegramLinkChallenge, LINK_CODE_TTL_MS } from '@/lib/business/telegram-link';
import { prisma } from '@/lib/db';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store, no-cache, must-revalidate' };

function botUsername(): string | null {
  const raw = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME?.trim();
  return raw ? raw.replace(/^@/, '') : null;
}

/** requireAuth che ritorna lo user o la Response di errore (401), senza throw da propagare. */
async function authed(request: Request): Promise<SessionUser | Response> {
  try {
    return await requireAuth(request);
  } catch (response) {
    return response as Response;
  }
}

export async function GET(request: Request) {
  const user = await authed(request);
  if (user instanceof Response) return user;
  const link = await prisma.telegramAccountLink.findUnique({ where: { userId: user.id } });
  return NextResponse.json(
    { linked: Boolean(link), username: link?.telegramUsername ?? null },
    { headers: privateHeaders },
  );
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }
  const username = botUsername();
  if (!isTelegramBotConfigured() || !username) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }
  const user = await authed(request);
  if (user instanceof Response) return user;

  const code = await createTelegramLinkChallenge(prisma, user.id);
  // Il codice è già url-safe (A-Za-z0-9_-): non va ri-codificato, va nel ?start= così com'è.
  const url = `https://t.me/${encodeURIComponent(username)}?start=${code}`;
  return NextResponse.json(
    { url, expiresAt: Date.now() + LINK_CODE_TTL_MS },
    { headers: privateHeaders },
  );
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }
  const user = await authed(request);
  if (user instanceof Response) return user;
  await prisma.telegramAccountLink.deleteMany({ where: { userId: user.id } });
  return NextResponse.json({ linked: false, username: null }, { headers: privateHeaders });
}
