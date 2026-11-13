// @polsia:user-owned — gestione del webhook del bot Telegram interattivo per l'amministratore:
// stato del webhook (GET) e registrazione su Telegram via setWebhook (POST, stessa origine).
// Solo admin verificati. Il token non è mai esposto.
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { registerTelegramWebhook, telegramWebhookStatus } from '@/lib/business/telegram-bot.server';
import {
  TelegramWebhookRegisterResultSchema,
  TelegramWebhookStatusSchema,
} from '@/lib/contracts/telegram-webhook';
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
    const status = TelegramWebhookStatusSchema.parse(await telegramWebhookStatus());
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
    const result = await registerTelegramWebhook();
    const status = await telegramWebhookStatus();
    const body = TelegramWebhookRegisterResultSchema.parse({ ...result, status });
    return NextResponse.json(body, { status: result.ok ? 200 : 502, headers: privateHeaders });
  } catch {
    return failure('register_failed', 500);
  }
}
