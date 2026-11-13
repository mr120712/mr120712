// @polsia:user-owned — webhook del bot Telegram. Telegram POSTa qui gli aggiornamenti; si autentica
// con il secret header impostato in setWebhook (niente cookie/same-origin). Comandi:
//   /start <token>  → collega l'account Solco (dal deep-link) e consegna il codice di invito
//   /start | /codice | /invito → se già collegato, rimanda il codice; altrimenti spiega come collegare
import 'server-only';
import { NextResponse } from 'next/server';
import { readJsonLimited } from '@/lib/business/request-body.server';
import { ensureReferralCode } from '@/lib/business/rewards.server';
import {
  inviteLinkForCode,
  isTelegramBotConfigured,
  sendTelegramMessage,
} from '@/lib/business/telegram-bot.server';
import { verifyTelegramLinkToken } from '@/lib/business/telegram-link';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

const CONNECT_HINT =
  'Per ricevere il tuo codice di invito, collega il tuo account: apri Solco → Premi → «Ricevi il codice su Telegram».';

async function sendCode(chatId: string, userId: string, prefix: string): Promise<void> {
  const code = await ensureReferralCode(userId);
  await sendTelegramMessage(
    chatId,
    `${prefix}Il tuo codice di invito è: ${code}\nCondividilo con questo link: ${inviteLinkForCode(code)}\nPer ogni amico che si abbona, Premium gratis per entrambi.`,
  );
}

async function handleUpdate(chatId: string, text: string, username: string | null): Promise<void> {
  // /start <token> → collega l'account al deep-link.
  const start = /^\/start(?:@\w+)?\s+(\S+)/.exec(text);
  if (start?.[1]) {
    const userId = verifyTelegramLinkToken(start[1]);
    if (!userId) {
      await sendTelegramMessage(
        chatId,
        'Link scaduto o non valido. Riprova da Solco → Premi → «Ricevi il codice su Telegram».',
      );
      return;
    }
    // Una chat può essere collegata a un solo utente: libera un eventuale collegamento precedente.
    await prisma.telegramAccountLink.deleteMany({
      where: { telegramChatId: chatId, NOT: { userId } },
    });
    await prisma.telegramAccountLink.upsert({
      where: { userId },
      create: { userId, telegramChatId: chatId, telegramUsername: username },
      update: { telegramChatId: chatId, telegramUsername: username },
    });
    await sendCode(chatId, userId, 'Account collegato! ');
    return;
  }

  // /start (senza token), /codice, /invito, o testo vuoto → rimanda il codice se già collegato.
  if (text === '' || /^\/(start|codice|invito|invita)(@\w+)?$/.test(text)) {
    const link = await prisma.telegramAccountLink.findUnique({
      where: { telegramChatId: chatId },
    });
    if (link) {
      await sendCode(chatId, link.userId, '');
      return;
    }
    await sendTelegramMessage(chatId, CONNECT_HINT);
    return;
  }

  await sendTelegramMessage(chatId, 'Scrivi /codice per ricevere il tuo codice di invito.');
}

export async function POST(request: Request) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  // Senza bot/secret configurati il webhook non esiste; con secret sbagliato è non autorizzato.
  if (!isTelegramBotConfigured() || !secret) return new NextResponse(null, { status: 404 });
  if (request.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return new NextResponse(null, { status: 401 });
  }

  const body = await readJsonLimited(request, 64 * 1024);
  // Telegram si aspetta sempre 200: qualsiasi problema non deve far ritentare all'infinito.
  if (!body.ok) return NextResponse.json({ ok: true });

  const update = body.value as {
    message?: { text?: unknown; chat?: { id?: unknown }; from?: { username?: unknown } };
  } | null;
  const message = update?.message;
  const rawChatId = message?.chat?.id;
  if (typeof rawChatId !== 'number' && typeof rawChatId !== 'string') {
    return NextResponse.json({ ok: true });
  }
  const chatId = String(rawChatId);
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const username = typeof message?.from?.username === 'string' ? message.from.username : null;

  try {
    await handleUpdate(chatId, text, username);
  } catch {
    // Mai propagare verso Telegram.
  }
  return NextResponse.json({ ok: true });
}
