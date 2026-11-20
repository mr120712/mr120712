// @polsia:user-owned — webhook del bot Telegram. Telegram POSTa qui gli aggiornamenti; si autentica
// con il secret header impostato in setWebhook (niente cookie/same-origin). Risposte moderne: testo
// in HTML e tastiere inline (Apri Solco come Mini App, condividi l'invito, premi). Comandi:
//   /start <token>  → collega l'account Solco (dal deep-link) e consegna il codice di invito
//   /start | /codice | /invito → se già collegato, rimanda il codice; altrimenti spiega come collegare
//   /help → cosa fa il bot
//   /skynet <domanda> → la chat di Skynet (sicurezza del sito): solo il proprietario, solo in privato
import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  botVideoExperimentalEnabled,
  requestBotVideo,
  videoCommandRegex,
} from '@/lib/business/bot-video.server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { readJsonLimited } from '@/lib/business/request-body.server';
import { ensureReferralCode } from '@/lib/business/rewards.server';
import {
  answerTelegramCallback,
  escapeTelegramHtml,
  inviteKeyboard,
  inviteLinkForCode,
  isTelegramBotConfigured,
  menuKeyboard,
  miniAppKeyboard,
  searchKeyboard,
  sendTelegramAudio,
  sendTelegramMessage,
  sendTelegramVideo,
  TELEGRAM_MENU_CALLBACKS,
} from '@/lib/business/telegram-bot.server';
import { consumeTelegramLinkChallenge } from '@/lib/business/telegram-link';
import { checkTelegramOwner } from '@/lib/business/telegram-owner.server';
import { SKYNET_CHAT_MAX_QUESTION, SKYNET_CHAT_SUGGESTIONS } from '@/lib/contracts/skynet-chat';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { publicUploadsEnabled } from '@/lib/features';
import { botSearch } from '@/lib/music/bot-search.server';
import { getOwnUploadForDownload, listMyPublicUploads } from '@/lib/music/public-uploads.server';
import {
  parseOwnerCommand,
  SKYNET_COMMAND,
  telegramChatText,
  telegramChatUsage,
} from '@/lib/skynet/chat';
import { askSkynet } from '@/lib/skynet/chat.server';

export const dynamic = 'force-dynamic';
/** /cerca, /scarica, /video, /skynet fanno lavoro di rete (ricerca, file, worker, AI): margine ampio. */
export const maxDuration = 60;

const CONNECT_HINT = 'Apri Solco per collegare il tuo account 👇';

const HELP_TEXT =
  '<b>Solco Music</b> 🎧\n\nEcco cosa posso fare:\n• /menu — il menu con i pulsanti\n• /invita — invita amici: Premium gratis per entrambi 🎁\n• /cerca parole — trova musica Creative Commons\n• /scarica — scarica i TUOI brani caricati su Solco\n• /codice — il tuo codice di invito\n• /app — apri Solco (Mini App)\n\nTocca <b>Apri Solco</b> per aprire l’app qui dentro, come Mini App.';

const MENU_TEXT =
  '<b>Menu Solco</b> 🎧\nMusica gratis, radio e podcast.\n\n🎁 <b>Invita un amico</b>: quando si abbona, un mese di Premium gratis per <b>entrambi</b>.';

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
    // Collega SOLO in chat privata: in un gruppo la chat (telegramChatId) finirebbe legata
    // all'account e poi /scarica mostrerebbe i brani del titolare a tutto il gruppo. Rifiuta.
    if (chatType !== 'private') {
      await sendTelegramMessage(
        chatId,
        'Per collegare il tuo account scrivimi in privato (apri la chat col bot), non in un gruppo.',
        { replyMarkup: miniAppKeyboard(chatType) },
      );
      return;
    }
    const userId = await consumeTelegramLinkChallenge(prisma, start[1]);
    if (!userId) {
      await sendTelegramMessage(
        chatId,
        'Codice scaduto o già usato. Rigeneralo da Solco → Impostazioni → «Collega account Telegram».',
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

  // /menu → il menu in chat (tastiera inline con i pulsanti principali).
  if (/^\/menu(@\w+)?$/.test(text)) {
    await sendTelegramMessage(chatId, MENU_TEXT, {
      parseMode: 'HTML',
      replyMarkup: menuKeyboard(chatType),
    });
    return;
  }

  // /id → l'ID numerico di QUESTA chat e, solo in privato, l'esito del gate owner (telegram-owner.server).
  // Non elencato nel menu e non rivela nulla dei comandi riservati: chi non è owner vede solo il proprio
  // ID. L'avviso sullo username compare soltanto a chi ha GIÀ provato di essere un amministratore
  // (account admin collegato col codice monouso), quindi non dà indizi a un estraneo.
  if (/^\/id(@\w+)?$/.test(text)) {
    const check = chatType === 'private' ? await checkTelegramOwner(chatId, username) : null;
    const note = check?.owner
      ? '\n✅ Chat riconosciuta come owner.'
      : check?.reason === 'username-mismatch'
        ? '\n⚠️ Account amministratore collegato, ma questo username Telegram non è fra quelli autorizzati.'
        : '';
    await sendTelegramMessage(
      chatId,
      `ID di questa chat: <code>${escapeTelegramHtml(chatId)}</code>${note}`,
      { parseMode: 'HTML' },
    );
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

  // /scarica → i TUOI brani caricati su Solco (solo per l'utente collegato). /scarica <n> ne invia uno.
  // Niente contenuti di terzi: solo materiale dell'utente, filtrato per proprietario lato server.
  const download = /^\/(?:scarica|download)(?:@\w+)?(?:\s+(\d+))?$/.exec(text);
  if (download) {
    // SOLO in chat privata: i brani e i link dell'oggetto su Blob sono materiale privato del titolare.
    // In un gruppo (anche se la chat risultasse collegata) non si espongono a terzi. Una chat privata
    // è 1:1 con l'utente Telegram, quindi basta questo controllo.
    if (chatType !== 'private') {
      await sendTelegramMessage(
        chatId,
        'Scrivimi in privato per scaricare i tuoi brani: /scarica funziona solo nella chat col bot.',
        { replyMarkup: miniAppKeyboard(chatType) },
      );
      return;
    }
    const account = await prisma.telegramAccountLink.findUnique({
      where: { telegramChatId: chatId },
    });
    if (!account) {
      await sendTelegramMessage(chatId, CONNECT_HINT, { replyMarkup: miniAppKeyboard(chatType) });
      return;
    }
    const uploads = await listMyPublicUploads(account.userId);
    if (uploads.length === 0) {
      // Con la libreria pubblica spenta (src/lib/features.ts) non si invita a caricare nuovi brani:
      // /scarica resta solo per riprendere quelli già caricati.
      await sendTelegramMessage(
        chatId,
        publicUploadsEnabled()
          ? 'Non hai ancora caricato brani su Solco. Caricali da Solco → Pubblica, poi torna con /scarica.'
          : 'Non hai brani caricati su Solco da scaricare.',
        { replyMarkup: miniAppKeyboard(chatType) },
      );
      return;
    }
    const index = download[1] ? Number(download[1]) : 0;
    if (index === 0) {
      const lines = uploads
        .slice(0, 20)
        .map((upload, i) => `${i + 1}. ${escapeTelegramHtml(upload.title)}`);
      await sendTelegramMessage(
        chatId,
        `I tuoi brani su Solco:\n\n${lines.join('\n')}\n\nScrivi <b>/scarica numero</b> per riceverlo (es. /scarica 1).`,
        { parseMode: 'HTML' },
      );
      return;
    }
    const chosen = uploads[index - 1];
    if (!chosen) {
      await sendTelegramMessage(
        chatId,
        `Numero fuori elenco (1–${uploads.length}). Scrivi /scarica per rivedere i tuoi brani.`,
      );
      return;
    }
    const file = await getOwnUploadForDownload(account.userId, chosen.id);
    if (!file) {
      await sendTelegramMessage(chatId, 'Brano non disponibile.');
      return;
    }
    const sent = await sendTelegramAudio(chatId, file.blobUrl, {
      title: file.title,
      caption: `🎵 <b>${escapeTelegramHtml(file.title)}</b> · il tuo upload su Solco`,
    });
    if (!sent) {
      // Telegram non ha potuto prendere il file dall'URL (oltre ~20MB o non raggiungibile): link diretto.
      await sendTelegramMessage(
        chatId,
        `Non riesco a inviarlo qui (forse oltre 20MB). Scaricalo da questo link:\n${escapeTelegramHtml(file.blobUrl)}`,
        { disableWebPagePreview: true },
      );
    }
    return;
  }

  // /video <url|descrizione> → SPERIMENTALE, owner-only (chat admin, in privato): l'AI interpreta la
  // richiesta e un worker yt-dlp ESTERNO risolve il media; il bot risponde col link. Gestito solo quando
  // la funzione è accesa (BOT_VIDEO_EXPERIMENTAL) E la chat è dell'owner (gate di telegram-owner.server:
  // ID esplicito, oppure account amministratore collegato col codice monouso): altrimenti SILENZIO
  // totale (obscuration): nessuna risposta, come se il comando non esistesse.
  const video = videoCommandRegex().exec(text);
  if (video) {
    // Obscuration: la funzione yt-dlp + AI è INVISIBILE a chi non è owner. Se non ricorrono TUTTE le
    // condizioni (feature accesa + chat privata + chat owner) → SILENZIO, nessun messaggio: non se ne
    // rivela l'esistenza né a estranei né nei gruppi (dove una risposta sarebbe visibile a tutti).
    if (!botVideoExperimentalEnabled() || chatType !== 'private') return;
    if (!(await checkTelegramOwner(chatId, username)).owner) return;
    const input = (video[1] ?? '').trim().slice(0, 500);
    if (!input) {
      await sendTelegramMessage(
        chatId,
        'Uso: <b>/video url o descrizione</b> (sperimentale)\nEs. <i>/video https://…</i>',
        { parseMode: 'HTML' },
      );
      return;
    }
    const limited = await enforceRateLimit('bot.video', `tg:${chatId}`);
    if (limited) {
      await sendTelegramMessage(chatId, 'Troppi download di fila: riprova tra poco.');
      return;
    }
    await sendTelegramMessage(chatId, '⏳ Cerco e preparo il video… (sperimentale)');
    const outcome = await requestBotVideo(input);
    if (outcome.status === 'not_configured') {
      await sendTelegramMessage(
        chatId,
        'Funzione sperimentale non configurata: manca il worker yt-dlp (imposta <code>YTDLP_SERVICE_URL</code>).',
        { parseMode: 'HTML' },
      );
      return;
    }
    if (outcome.status === 'failed') {
      await sendTelegramMessage(
        chatId,
        `Non sono riuscito a prendere il video: ${escapeTelegramHtml(outcome.detail)}.`,
        { parseMode: 'HTML' },
      );
      return;
    }
    const { title, mediaUrl, ext, filesize } = outcome.result;
    // Con il worker in modalità "serve" il file è ospitato dal worker e ha una dimensione nota: se è un
    // video piccolo (≤ ~20MB, il limite di Telegram per l'invio da URL) prova a mandarlo DENTRO la chat;
    // altrimenti (o se l'invio fallisce) manda il link. In modalità "extract" (filesize assente) → link.
    const videoExts = new Set(['mp4', 'mov', 'm4v', 'webm']);
    const smallVideo =
      typeof filesize === 'number' &&
      filesize > 0 &&
      filesize <= 20 * 1024 * 1024 &&
      ext !== null &&
      videoExts.has(ext.toLowerCase());
    const sent = smallVideo
      ? await sendTelegramVideo(chatId, mediaUrl, {
          caption: `🎬 <b>${escapeTelegramHtml(title)}</b>\n<i>Sperimentale</i>`,
        })
      : false;
    if (!sent) {
      await sendTelegramMessage(
        chatId,
        `🎬 <b>${escapeTelegramHtml(title)}</b>\n${escapeTelegramHtml(mediaUrl)}\n\n<i>Sperimentale · link diretto al media.</i>`,
        { parseMode: 'HTML', disableWebPagePreview: false },
      );
    }
    return;
  }

  // /skynet <domanda> → la chat di Skynet, la sentinella di sicurezza: cerca in tutte le sue fonti
  // e risponde (src/lib/skynet/chat.server.ts). Riservata all'owner e solo in chat privata, con lo
  // stesso gate di /video: per chiunque altro SILENZIO totale, come se il comando non esistesse (in
  // un gruppo la risposta sarebbe visibile a tutti). Ogni domanda sta da sola: nessuna memoria.
  const skynet = SKYNET_COMMAND.exec(text);
  if (skynet) {
    if (chatType !== 'private') return;
    if (!(await checkTelegramOwner(chatId, username)).owner) return;
    const question = (skynet[1] ?? '').trim().slice(0, SKYNET_CHAT_MAX_QUESTION);
    if (!question) {
      await sendTelegramMessage(chatId, telegramChatUsage(SKYNET_CHAT_SUGGESTIONS), {
        parseMode: 'HTML',
      });
      return;
    }
    const limited = await enforceRateLimit('skynet.chat', `tg:${chatId}`);
    if (limited) {
      await sendTelegramMessage(chatId, 'Troppe domande di fila: riprovi tra poco.');
      return;
    }
    // Un comando si esegue subito; una domanda richiede qualche secondo di ricerca.
    if (!parseOwnerCommand(question)) {
      await sendTelegramMessage(chatId, '🛰️ Cerco in tutte le fonti…');
    }
    try {
      const answer = await askSkynet({
        messages: [{ role: 'user', content: question }],
        source: 'telegram',
      });
      await sendTelegramMessage(chatId, telegramChatText(answer), {
        parseMode: 'HTML',
        disableWebPagePreview: true,
      });
    } catch {
      await sendTelegramMessage(
        chatId,
        'Skynet non è riuscito a rispondere. Non è stato cambiato nulla: riprovi fra poco.',
      );
    }
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
    callback_query?: {
      id?: unknown;
      data?: unknown;
      from?: { username?: unknown };
      message?: { chat?: { id?: unknown; type?: unknown } };
    };
  } | null;

  // Pulsante del menu toccato (callback_query): lo traduciamo nel comando testuale equivalente e lo
  // facciamo passare dalla STESSA logica (handleUpdate) — così vale anche la guardia chat-privata di
  // /scarica. Il tipo di chat è quello del messaggio del menu, quindi in un gruppo /scarica rifiuta.
  const callback = update?.callback_query;
  if (callback) {
    const rawChatId = callback.message?.chat?.id;
    const callbackId = typeof callback.id === 'string' ? callback.id : null;
    if ((typeof rawChatId !== 'number' && typeof rawChatId !== 'string') || !callbackId) {
      return NextResponse.json({ ok: true });
    }
    const chatId = String(rawChatId);
    const chatType =
      typeof callback.message?.chat?.type === 'string' ? callback.message.chat.type : null;
    const username = typeof callback.from?.username === 'string' ? callback.from.username : null;
    const data = typeof callback.data === 'string' ? callback.data : '';
    try {
      const limited = await enforceRateLimit('telegram.webhook', `tg:${chatId}`);
      if (!limited) {
        await answerTelegramCallback(callbackId);
        const command = TELEGRAM_MENU_CALLBACKS[data];
        if (command) await handleUpdate(chatId, command, username, chatType);
      }
    } catch {
      // Mai propagare verso Telegram.
    }
    return NextResponse.json({ ok: true });
  }

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
