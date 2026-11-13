// @polsia:user-owned — diagnostica del bot Telegram (ops). Protetta da CRON_SECRET, NON dalla
// sessione: verifica identità del bot (getMe), il canale degli annunci (getChat) e se il bot ne è
// amministratore e può pubblicare (getChatMember). Non espone mai il token.
import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { telegramBotDiagnostics } from '@/lib/business/telegram-bot.server';

export const dynamic = 'force-dynamic';
export const maxDuration = 20;

/** Autorizza solo con `Authorization: Bearer <CRON_SECRET>`, in tempo costante. */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  // Invisibile a chi non ha il secret: 404, non 401.
  if (!authorized(request)) return new NextResponse(null, { status: 404 });

  const diag = await telegramBotDiagnostics();
  const healthy =
    diag.configured &&
    Boolean(diag.bot) &&
    (!diag.channel.configured || diag.membership?.canPost === true);

  return NextResponse.json(
    { healthy, ...diag },
    { status: healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
