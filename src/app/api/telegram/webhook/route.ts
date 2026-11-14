// @polsia:user-owned — webhook del bot Telegram. Telegram POSTa qui gli aggiornamenti; si autentica
// con il secret header impostato in setWebhook (niente cookie/same-origin). Risposte moderne: testo
// in HTML e tastiere inline (Apri Solco come Mini App, condividi l'invito, premi). Comandi:
//   /start <token>  → collega l'account Solco (dal deep-link) e consegna il codice di invito
//   /start | /codice | /invito → se già collegato, rimanda il codice; altrimenti spiega come collegare
//   /help → cosa fa il bot
import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { readJsonLimited } from '@/lib/business/request-body.server';
import { ensureReferralCode } from '@/lib/business/rewards.server';
import {
  escapeTelegramHtml,
  inviteKeyboard,
  inviteLinkForCode,
  isTelegramBotConfigured,
  miniAppKeyboard,
  searchKeyboard,
  sendTelegramMessage,
} from '@/lib/business/telegram-bot.server';
import { verifyTelegramLinkToken } from '@/lib/business/telegram-link';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { botSearch } from '@/lib/music/bot-search.server';

export const dynamic = 'force-dynamic';
/** /cerca interroga più fonti: lascia margine oltre la fonte più lenta (tempo massimo in botSearch). */
export const maxDuration = 20;

const CONNECT_HINT =
  'Per ricevere il tuo codice di invito, collega il tuo account: apri Solco → Premi → «Ricevi il codice su Telegram».';

const HELP_TEXT =
  '<b>Solco Music</b> 🎧\n\nEcco cosa posso fare:\n• /cerca parole — trova musica Creative Commons\n• /codice — il tuo codice di invito\n• /invito — il tuo link di invito\n• /app — apri Solco (Mini App)\n\nTocca <b>Apri Solco</b> per aprire l’app qui dentro, come Mini App.';

/** Titolo/artista troncati: i campi Audius non hanno limite di lunghezza nello schema, e 5 righe
 *  intere potrebbero sforare il tetto di 4096 caratteri di sendMessage (→ 400, risposta persa). */
function clip(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Risultati del bot formattati per Telegram (HTML). Tutti Creative Commons, riproducibili su Solco. */
function formatSearchResults(
  query: string,
  results: Awaited<ReturnType<typeof botSearch>>,
): string {
  const lines = results.slice(0, 5).map((result, index) => {
    const n = index + 1;
    if (result.kind === 'audius') {
      return `${n}. 🎵 <b>${escapeTelegramHtml(clip(result.track.title))}</b> — ${escapeTelegramHtml(clip(result.track.artistName))}`;
    }
    if (result.kind === 'radio') {
      return `${n}. 📻 <b>${escapeTelegramHtml(clip(result.station.name))}</b> · radio`;
    }
    if (result.kind === 'podcast') {
      return `${n}. 🎙️ <b>${escapeTelegramHtml(clip(result.podcast.title))}</b> · podcast`;
    }
    return `${n}. …`;
  });
  return `🔎 <b>${escapeTelegramHtml(query)}</b>\n\n${lines.join('\n')}\n\nTutti con licenza Creative Commons. Tocca <b>Ascolta su Solco</b> per riprodurli. 🎧`;
}

async function sendCode(
  chatId: string,
  userId: string,
  prefix: string,
  chatType: string | null,
): Promise<void> {
  const code = await ensureReferralCode(userId);
  const link = inviteLinkForCode(code);
  await sendTelegramMessage(
    chatId,
    `${prefix}Il tuo codice di invito è <b>${escapeTelegramHtml(code)}</b>\nCondividilo con questo link:\n${escapeTelegramHtml(link)}\n\nPer ogni amico che si abbona, Premium gratis per entrambi. 💜`,
    { parseMode: 'HTML', disableWebPagePreview: true, replyMarkup: inviteKeyboard(link, chatType) },
  );
}

async function handleUpdate(
  chatId: string,
  text: string,
  username: string | null,
  chatType: string | null,
): Promise<void> {
  // /start <token> → collega l'account al deep-link.
  const start = /^\/start(?:@\w+)?\s+(\S+)/.exec(text);
  if (start?.[1]) {
    const userId = verifyTelegramLinkToken(start[1]);
    if (!userId) {
      await sendTelegramMessage(
        chatId,
        'Link scaduto o non valido. Riprova da Solco → Premi → «Ricevi il codice su Telegram».',
        { replyMarkup: miniAppKeyboard(chatType) },
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
    await sendCode(chatId, userId, 'Account collegato! ', chatType);
    return;
  }

  // /help → cosa fa il bot.
  if (/^\/help(@\w+)?$/.test(text)) {
    await sendTelegramMessage(chatId, HELP_TEXT, {
      parseMode: 'HTML',
      replyMarkup: miniAppKeyboard(chatType),
    });
    return;
  }

  // /cerca <parole> → musica Creative Commons (Audius + radio + podcast), riproducibile su Solco.
  const search = /^\/(?:cerca|search|trova)(?:@\w+)?(?:\s+([\s\S]+))?$/.exec(text);
  if (search) {
    const query = (search[1] ?? '').trim().slice(0, 80);
    if (!query) {
      await sendTelegramMessage(
        chatId,
        'Uso: <b>/cerca parole</b>\nEs. <i>/cerca lofi per studiare</i>',
        { parseMode: 'HTML', replyMarkup: miniAppKeyboard(chatType) },
      );
      return;
    }
    const results = await botSearch(query);
    if (results.length === 0) {
      await sendTelegramMessage(
        chatId,
        `Nessun brano Creative Commons per «${escapeTelegramHtml(query)}». Prova altre parole.`,
        { parseMode: 'HTML' },
      );
      return;
    }
    await sendTelegramMessage(chatId, formatSearchResults(query, results), {
      parseMode: 'HTML',
      disableWebPagePreview: true,
      replyMarkup: searchKeyboard(query, chatType),
    });
    return;
  }

  // /app → apri Solco come Mini App.
  if (/^\/(?:app|apri|solco)(@\w+)?$/.test(text)) {
    await sendTelegramMessage(chatId, 'Apri Solco qui dentro, come Mini App 👇', {
      replyMarkup: miniAppKeyboard(chatType),
    });
    return;
  }

  // /start (senza token), /codice, /invito, o testo vuoto → rimanda il codice se già collegato.
  if (text === '' || /^\/(start|codice|invito|invita)(@\w+)?$/.test(text)) {
    const link = await prisma.telegramAccountLink.findUnique({
      where: { telegramChatId: chatId },
    });
    if (link) {
      await sendCode(chatId, link.userId, '', chatType);
      return;
    }
    await sendTelegramMessage(chatId, CONNECT_HINT, { replyMarkup: miniAppKeyboard(chatType) });
    return;
  }

  await sendTelegramMessage(
    chatId,
    'Prova <b>/cerca lofi</b> per trovare musica, <b>/codice</b> per il tuo codice di invito, o <b>/help</b>.',
    { parseMode: 'HTML', replyMarkup: miniAppKeyboard(chatType) },
  );
}

/** Confronto del secret in tempo COSTANTE (niente timing leak sul segreto del webhook). */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  // Senza bot/secret configurati il webhook non esiste; con secret sbagliato è non autorizzato.
  if (!isTelegramBotConfigured() || !secret) return new NextResponse(null, { status: 404 });
  if (!secretMatches(request.headers.get('x-telegram-bot-api-secret-token'), secret)) {
    return new NextResponse(null, { status: 401 });
  }

  const body = await readJsonLimited(request, 64 * 1024);
  // Telegram si aspetta sempre 200: qualsiasi problema non deve far ritentare all'infinito.
  if (!body.ok) return NextResponse.json({ ok: true });

  const update = body.value as {
    message?: {
      text?: unknown;
      chat?: { id?: unknown; type?: unknown };
      from?: { username?: unknown };
    };
  } | null;
  const message = update?.message;
  const rawChatId = message?.chat?.id;
  if (typeof rawChatId !== 'number' && typeof rawChatId !== 'string') {
    return NextResponse.json({ ok: true });
  }
  const chatId = String(rawChatId);
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const username = typeof message?.from?.username === 'string' ? message.from.username : null;
  const chatType = typeof message?.chat?.type === 'string' ? message.chat.type : null;

  try {
    // Anti-spam per chat: oltre la soglia si scarta in silenzio (200, nessun retry di Telegram,
    // niente scritture DB né invii). Fail-open su errore del limiter.
    const limited = await enforceRateLimit('telegram.webhook', `tg:${chatId}`);
    if (!limited) await handleUpdate(chatId, text, username, chatType);
  } catch {
    // Mai propagare verso Telegram.
  }
  return NextResponse.json({ ok: true });
}
