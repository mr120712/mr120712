// @polsia:user-owned — pulsante-menu del bot Telegram (apre Solco come Mini App) per l'admin:
// stato (GET) e impostazione via setChatMenuButton (POST, stessa origine). Solo admin verificati.
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { setTelegramMenuButton, telegramMenuStatus } from '@/lib/business/telegram-bot.server';
import {
  TelegramMenuSetResultSchema,
  TelegramMenuStatusSchema,
} from '@/lib/contracts/telegram-menu';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

function failure(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: privateHeaders });
}

type AdminAccess = { allowed: true } | { allowed: false; response: Response };

async function requireAdmin(request: Request): Promise<AdminAccess> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return { allowed: false, response: failure('unauthorized', 401) };
    if (session.user.role !== 'admin' || session.user.emailVerified !== true) {
      return { allowed: false, response: failure('forbidden', 403) };
    }
    return { allowed: true };
  } catch {
    return { allowed: false, response: failure('session_unavailable', 503) };
  }
}

export async function GET(request: Request) {
  const access = await requireAdmin(request);
  if (!access.allowed) return access.response;
  try {
    const status = TelegramMenuStatusSchema.parse(await telegramMenuStatus());
    return NextResponse.json(status, { headers: privateHeaders });
  } catch {
    return failure('status_unavailable', 503);
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return failure('forbidden_origin', 403);
  const access = await requireAdmin(request);
  if (!access.allowed) return access.response;
  try {
    const result = await setTelegramMenuButton();
    const status = await telegramMenuStatus();
    const body = TelegramMenuSetResultSchema.parse({ ...result, status });
    return NextResponse.json(body, { status: result.ok ? 200 : 502, headers: privateHeaders });
  } catch {
    return failure('set_failed', 500);
  }
}
