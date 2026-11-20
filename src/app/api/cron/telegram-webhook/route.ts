// @polsia:user-owned — ri-registra il webhook del bot Telegram con un solo comando (ops), senza
// aprire il pannello admin. Protetta da CRON_SECRET (Bearer), NON dalla sessione: così la può
// chiamare sia Vercel Cron (auto-riparazione) sia un curl una-tantum. Comportamento:
//   • di default (Vercel Cron): legge lo stato e ri-registra SOLO se il webhook non è «ready»
//     (bot+secret configurati e registrato sull'URL atteso) — nessun rumore quando è già a posto;
//   • con ?force=1 (comando manuale): ri-registra sempre.
// Non espone mai il token (registerTelegramWebhook lo redige).
import 'server-only';
import { NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/business/cron-auth.server';
import { registerTelegramWebhook, telegramWebhookStatus } from '@/lib/business/telegram-bot.server';

export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const noStore = { 'Cache-Control': 'no-store' };

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export async function GET(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: noStore });
  }

  const force = TRUTHY.has(
    (new URL(request.url).searchParams.get('force') ?? '').trim().toLowerCase(),
  );

  try {
    const before = await telegramWebhookStatus();

    // Auto-riparazione: se è già registrato e attivo e non è forzato, non tocco nulla.
    if (!force && before.ready) {
      return NextResponse.json(
        {
          action: 'skipped',
          ok: true,
          message: 'Webhook già registrato e attivo.',
          status: before,
        },
        { headers: noStore },
      );
    }

    const result = await registerTelegramWebhook();
    const status = await telegramWebhookStatus();
    return NextResponse.json(
      {
        action: result.ok ? 'registered' : 'failed',
        ok: result.ok,
        message: result.message,
        status,
      },
      { status: result.ok ? 200 : 502, headers: noStore },
    );
  } catch {
    return NextResponse.json({ error: 'register_failed' }, { status: 500, headers: noStore });
  }
}
