// @polsia:user-owned — client minimale del bot Telegram (invio messaggi, diagnostica, webhook) e
// utilità del link invito.
import 'server-only';
import { ownerTelegramChatIds } from '@/lib/business/telegram-owner-chats';
import { env } from '@/lib/env';
import { inviteUrlForCode, publicRewardsUrl } from '@/lib/public-links';

/**
 * Dominio a cui è COLLEGATO il bot: webhook, Mini App e pulsanti di ascolto usano QUESTO, non il
 * canonical del sito (siteUrl / NEXT_PUBLIC_APP_URL). Override con TELEGRAM_PUBLIC_URL.
 * Default www.solcomusic.online: il dominio nudo solcomusic.online risponde 308 → www e Telegram NON
 * segue i redirect sul webhook. I link d'INVITO invece usano sempre il sito pubblico
 * (src/lib/public-links.ts), qualunque sia questo valore.
 */
const BOT_PUBLIC_URL = (process.env.TELEGRAM_PUBLIC_URL ?? 'https://www.solcomusic.online').replace(
  /\/+$/,
  '',
);

/** Chiamata all'API Bot di Telegram (POST JSON, timeout 8s). Non lancia: ritorna la risposta o null. */
async function telegramApi(
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok?: boolean; result?: Record<string, unknown>; description?: string } | null> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(8000)
      : undefined;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });
    return (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: Record<string, unknown>;
      description?: string;
    } | null;
  } catch {
    return null;
  }
}

/** Il bot è attivo solo se è configurato il token di BotFather. */
export function isTelegramBotConfigured(): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN);
}

/**
 * Link di invito pubblico per un codice referral (imposta il cookie e porta alla registrazione).
 * Sempre sul sito ufficiale (www.solcomusic.online), indipendente dall'host del webhook.
 */
export function inviteLinkForCode(code: string): string {
  return inviteUrlForCode(code);
}

/** Esito della diagnostica del bot: nessun dato sensibile (mai il token). */
export type TelegramDiagnostics = {
  configured: boolean;
  bot?: { id: number; username: string | null; name: string };
  channel: { configured: boolean; id?: string; title?: string; type?: string };
  membership?: { status: string; canPost: boolean | null };
  /** Avvisi di configurazione in italiano (non errori di comunicazione): cosa sistemare e come. */
  warnings: string[];
  errors: string[];
};

/** Toglie il token da un eventuale messaggio d'errore (per sicurezza). */
function redactToken(text: string, token: string): string {
  return token ? text.split(token).join('•••') : text;
}

/**
 * Verifica lo stato del bot senza esporre il token: getMe (identità del bot), getChat (il canale
 * degli annunci) e getChatMember (il bot è amministratore e può pubblicare?). Non lancia mai;
 * raccoglie le descrizioni d'errore di Telegram (che non contengono il token, comunque redatte).
 */
export async function telegramBotDiagnostics(): Promise<TelegramDiagnostics> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const channelId = env.TELEGRAM_CHANNEL_CHAT_ID;
  if (!token) {
    return {
      configured: false,
      channel: { configured: Boolean(channelId) },
      warnings: [],
      errors: ['TELEGRAM_BOT_TOKEN non impostato: il bot è disattivato.'],
    };
  }

  const errors: string[] = [];
  const call = async (method: string, params: Record<string, unknown>) => {
    const signal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(8000)
        : undefined;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal,
      });
      return (await res.json().catch(() => null)) as {
        ok?: boolean;
        result?: Record<string, unknown>;
        description?: string;
      } | null;
    } catch {
      return null;
    }
  };

  const warnings: string[] = [];
  const out: TelegramDiagnostics = {
    configured: true,
    channel: { configured: Boolean(channelId) },
    warnings,
    errors,
  };

  const me = await call('getMe', {});
  if (me?.ok && me.result) {
    out.bot = {
      id: Number(me.result.id),
      username: (me.result.username as string) ?? null,
      name: (me.result.first_name as string) ?? '',
    };
  } else {
    errors.push(`getMe: ${redactToken(me?.description ?? 'nessuna risposta/timeout', token)}`);
  }

  if (channelId) {
    const chat = await call('getChat', { chat_id: channelId });
    if (chat?.ok && chat.result) {
      out.channel.id = String(chat.result.id);
      out.channel.title = (chat.result.title as string) ?? undefined;
      out.channel.type = (chat.result.type as string) ?? undefined;
    } else {
      errors.push(`getChat: ${redactToken(chat?.description ?? 'nessuna risposta', token)}`);
    }

    if (out.bot) {
      const mem = await call('getChatMember', { chat_id: channelId, user_id: out.bot.id });
      if (mem?.ok && mem.result) {
        const status = String(mem.result.status);
        const canPost =
          typeof mem.result.can_post_messages === 'boolean'
            ? (mem.result.can_post_messages as boolean)
            : status === 'administrator' || status === 'creator'
              ? true
              : null;
        out.membership = { status, canPost };
      } else {
        errors.push(`getChatMember: ${redactToken(mem?.description ?? 'nessuna risposta', token)}`);
      }
    }

    // Avvisi di configurazione, a parole: i casi tipici di canale impostato male, così non si devono
    // dedurre dagli id.
    if (out.bot && out.channel.id && out.channel.id === String(out.bot.id)) {
      warnings.push(
        'TELEGRAM_CHANNEL_CHAT_ID coincide con l’id del bot: punta al bot stesso, non a un canale. Impostalo sull’id del canale degli annunci (di solito inizia con -100…).',
      );
    } else if (
      out.channel.type &&
      out.channel.type !== 'channel' &&
      out.channel.type !== 'supergroup'
    ) {
      warnings.push(
        `TELEGRAM_CHANNEL_CHAT_ID non è un canale (tipo rilevato: ${out.channel.type}). Gli annunci richiedono un canale Telegram.`,
      );
    }
    if (out.membership && out.membership.canPost !== true) {
      warnings.push(
        `Il bot non può pubblicare nel canale (stato: ${out.membership.status}). Rendilo amministratore del canale con il permesso di pubblicare messaggi.`,
      );
    }
  }

  return out;
}

/** URL su cui Telegram deve inviare gli aggiornamenti del bot (webhook). */
export function telegramWebhookUrl(): string {
  return `${BOT_PUBLIC_URL}/api/telegram/webhook`;
}

export type TelegramWebhookStatus = {
  /** Bot + secret configurati E webhook registrato sull'URL atteso. */
  ready: boolean;
  botConfigured: boolean;
  secretConfigured: boolean;
  expectedUrl: string;
  currentUrl: string | null;
  matches: boolean;
  pendingUpdates: number;
  lastError: string | null;
};

/**
 * Update che il bot DEVE ricevere: i messaggi E i tap sui pulsanti del menu (callback_query). Senza
 * 'callback_query' nel setWebhook, Telegram non consegna i tap e il menu inline resta muto.
 */
export const WEBHOOK_ALLOWED_UPDATES = ['message', 'callback_query'] as const;

/**
 * Gli update registrati su Telegram coprono quelli che il bot gestisce? Un `allowed_updates` assente
 * significa «tutti gli update» (callback_query incluso), quindi va bene; se è una lista, deve
 * contenerli tutti. Serve all'auto-riparazione del webhook (il cron ri-registra se manca qualcosa).
 */
export function webhookUpdatesOk(registered: unknown): boolean {
  if (!Array.isArray(registered)) return true;
  return WEBHOOK_ALLOWED_UPDATES.every((update) => registered.includes(update));
}

/** Stato del webhook interattivo: bot/secret configurati e registrato sull'URL atteso? */
export async function telegramWebhookStatus(): Promise<TelegramWebhookStatus> {
  const botConfigured = isTelegramBotConfigured();
  const secretConfigured = Boolean(env.TELEGRAM_WEBHOOK_SECRET);
  const expectedUrl = telegramWebhookUrl();
  const base: TelegramWebhookStatus = {
    ready: false,
    botConfigured,
    secretConfigured,
    expectedUrl,
    currentUrl: null,
    matches: false,
    pendingUpdates: 0,
    lastError: null,
  };
  if (!botConfigured) return base;

  const info = await telegramApi('getWebhookInfo', {});
  if (!info?.ok || !info.result) {
    const desc = info?.description
      ? redactToken(info.description, env.TELEGRAM_BOT_TOKEN ?? '')
      : 'getWebhookInfo non riuscito';
    return { ...base, lastError: desc };
  }
  const currentUrl =
    typeof info.result.url === 'string' && info.result.url ? info.result.url : null;
  const matches = currentUrl === expectedUrl;
  const updatesOk = webhookUpdatesOk(info.result.allowed_updates);
  return {
    ...base,
    currentUrl,
    matches,
    pendingUpdates: Number(info.result.pending_update_count ?? 0),
    lastError:
      typeof info.result.last_error_message === 'string' ? info.result.last_error_message : null,
    ready: botConfigured && secretConfigured && matches && updatesOk,
  };
}

/** Registra il webhook su Telegram (setWebhook) con l'URL atteso e il secret di verifica. */
export async function registerTelegramWebhook(): Promise<{ ok: boolean; message: string }> {
  if (!isTelegramBotConfigured()) {
    return { ok: false, message: 'TELEGRAM_BOT_TOKEN non impostato: imposta il token su Vercel.' };
  }
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    return {
      ok: false,
      message:
        'TELEGRAM_WEBHOOK_SECRET non impostato: aggiungilo su Vercel e ridistribuisci, poi riprova.',
    };
  }
  const res = await telegramApi('setWebhook', {
    url: telegramWebhookUrl(),
    secret_token: secret,
    allowed_updates: [...WEBHOOK_ALLOWED_UPDATES],
  });
  if (res?.ok) return { ok: true, message: 'Webhook registrato con successo.' };
  return {
    ok: false,
    message: res?.description
      ? redactToken(res.description, env.TELEGRAM_BOT_TOKEN ?? '')
      : 'setWebhook non riuscito (nessuna risposta da Telegram).',
  };
}

/** Testo del pulsante del bot che apre Solco come Mini App. */
export const TELEGRAM_MENU_BUTTON_TEXT = 'Apri Solco';

/** URL che il pulsante del bot (Mini App) apre. */
export function telegramMenuUrl(): string {
  return BOT_PUBLIC_URL;
}

export type TelegramMenuStatus = {
  botConfigured: boolean;
  /** Tipo attuale del pulsante: 'web_app' quando apre Solco, 'default'/'commands' altrimenti. */
  type: string | null;
  text: string | null;
  url: string | null;
  expectedUrl: string;
  /** true quando il pulsante è un web_app che apre l'URL atteso. */
  matches: boolean;
  lastError: string | null;
};

/** Stato del pulsante-menu del bot: apre già Solco come Mini App? */
export async function telegramMenuStatus(): Promise<TelegramMenuStatus> {
  const botConfigured = isTelegramBotConfigured();
  const expectedUrl = telegramMenuUrl();
  const base: TelegramMenuStatus = {
    botConfigured,
    type: null,
    text: null,
    url: null,
    expectedUrl,
    matches: false,
    lastError: null,
  };
  if (!botConfigured) return base;

  const info = await telegramApi('getChatMenuButton', {});
  if (!info?.ok || !info.result) {
    return {
      ...base,
      lastError: info?.description
        ? redactToken(info.description, env.TELEGRAM_BOT_TOKEN ?? '')
        : 'getChatMenuButton non riuscito',
    };
  }
  const result = info.result as { type?: string; text?: string; web_app?: { url?: string } };
  const type = typeof result.type === 'string' ? result.type : null;
  const url = typeof result.web_app?.url === 'string' ? result.web_app.url : null;
  return {
    ...base,
    type,
    text: typeof result.text === 'string' ? result.text : null,
    url,
    matches: type === 'web_app' && url === expectedUrl,
  };
}

/**
 * Prepara l'aspetto moderno del bot: pulsante-menu Mini App che apre Solco + comandi nel menu "/"
 * + descrizione del bot. Il risultato segue il pulsante (il resto è best-effort e non lo blocca).
 */
export async function setTelegramMenuButton(): Promise<{ ok: boolean; message: string }> {
  if (!isTelegramBotConfigured()) {
    return { ok: false, message: 'TELEGRAM_BOT_TOKEN non impostato: imposta il token su Vercel.' };
  }
  const res = await telegramApi('setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: TELEGRAM_MENU_BUTTON_TEXT,
      web_app: { url: telegramMenuUrl() },
    },
  });
  // Comandi + descrizione: migliorano la presentazione ma non devono far fallire l'operazione.
  const commandsOk = await setTelegramCommands();
  const descriptionsOk = await setTelegramDescriptions();
  if (res?.ok) {
    const extras = [commandsOk ? 'comandi' : null, descriptionsOk ? 'descrizione' : null].filter(
      Boolean,
    );
    const suffix = extras.length ? ` (impostati anche ${extras.join(' e ')})` : '';
    return { ok: true, message: `Pulsante «${TELEGRAM_MENU_BUTTON_TEXT}» impostato${suffix}.` };
  }
  return {
    ok: false,
    message: res?.description
      ? redactToken(res.description, env.TELEGRAM_BOT_TOKEN ?? '')
      : 'setChatMenuButton non riuscito (nessuna risposta da Telegram).',
  };
}

export type SendMessageOptions = {
  /** Formattazione del testo (HTML consigliato: ricordati di escapare il contenuto dinamico). */
  parseMode?: 'HTML' | 'MarkdownV2';
  /** reply_markup di Telegram (es. una tastiera inline da buildInlineKeyboard). */
  replyMarkup?: unknown;
  /** Nasconde l'anteprima del link (utile quando il messaggio contiene un URL). */
  disableWebPagePreview?: boolean;
  /**
   * Effetto animato di Telegram sul messaggio (message_effect_id, es. TELEGRAM_EFFECT_PARTY). Vale solo
   * nelle chat PRIVATE: se Telegram lo rifiuta, il messaggio parte di nuovo senza effetto.
   */
  effectId?: string;
};

/** Effetti animati di Telegram (message_effect_id), solo chat private: 🎉 festa, 👍 fatto. */
export const TELEGRAM_EFFECT_PARTY = '5046509860389126442';
export const TELEGRAM_EFFECT_THUMBS_UP = '5107584321108051014';

/**
 * Una chiamata alla Bot API: il JSON di risposta, o null se la rete o il token mancano. Non lancia mai
 * e non scrive mai il token da nessuna parte (sta solo nell'URL della richiesta).
 */
async function telegramCall(
  method: string,
  body: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<{ ok?: boolean; result?: unknown; description?: string } | null> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return ((await res.json().catch(() => null)) as { ok?: boolean } | null) ?? { ok: res.ok };
  } catch {
    return null;
  }
}

function messageBody(chatId: string, text: string, options: SendMessageOptions) {
  return {
    chat_id: chatId,
    text,
    disable_web_page_preview: options.disableWebPagePreview ?? false,
    ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
    ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
  };
}

/**
 * Invia un messaggio e restituisce il suo message_id (per modificarlo dopo, es. una barra di
 * avanzamento), oppure null. Con `effectId` rifiutato riprova senza effetto. Non lancia mai.
 */
export async function sendTelegramMessageId(
  chatId: string,
  text: string,
  options: SendMessageOptions = {},
): Promise<number | null> {
  const body = messageBody(chatId, text, options);
  let data = await telegramCall(
    'sendMessage',
    options.effectId ? { ...body, message_effect_id: options.effectId } : body,
  );
  if (!data?.ok && options.effectId) data = await telegramCall('sendMessage', body);
  const id = (data?.result as { message_id?: unknown } | undefined)?.message_id;
  return data?.ok && typeof id === 'number' ? id : null;
}

/** Invia un messaggio a una chat, con formattazione e tastiera opzionali. Non lancia mai. */
export async function sendTelegramMessage(
  chatId: string,
  text: string,
  options: SendMessageOptions = {},
): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  if (options.effectId) return (await sendTelegramMessageId(chatId, text, options)) !== null;
  return Boolean((await telegramCall('sendMessage', messageBody(chatId, text, options)))?.ok);
}

/**
 * Modifica il testo di un messaggio già inviato dal bot. «Message is not modified» (stesso testo)
 * conta come riuscito. Non lancia mai.
 */
export async function editTelegramMessage(
  chatId: string,
  messageId: number,
  text: string,
  options: Pick<SendMessageOptions, 'parseMode' | 'disableWebPagePreview'> = {},
): Promise<boolean> {
  const data = await telegramCall('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: options.disableWebPagePreview ?? true,
    ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
  });
  return Boolean(data?.ok) || /not modified/i.test(data?.description ?? '');
}

/** «Sta inviando un video…» nell'intestazione della chat (dura ~5 s, va ripetuto). Non lancia mai. */
export async function sendTelegramChatAction(
  chatId: string,
  action: 'typing' | 'upload_video' | 'upload_document',
): Promise<void> {
  await telegramCall('sendChatAction', { chat_id: chatId, action }, 4000);
}

/**
 * Invia un file audio da un URL pubblico: Telegram lo scarica dall'URL e lo consegna in chat (nessun
 * download lato nostro). Limite di Telegram per l'invio da URL: ~20 MB. Ritorna true solo se Telegram
 * conferma `ok:true`; su file troppo grande o URL non raggiungibile ritorna false (il chiamante fa
 * da fallback con un link). Non lancia mai.
 */
export async function sendTelegramAudio(
  chatId: string,
  audioUrl: string,
  options: { title?: string; caption?: string } = {},
): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(45000)
      : undefined;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendAudio`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        audio: audioUrl,
        ...(options.title ? { title: options.title } : {}),
        ...(options.caption ? { caption: options.caption, parse_mode: 'HTML' } : {}),
      }),
      signal,
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return Boolean(data?.ok);
  } catch {
    return false;
  }
}

/**
 * Invia un VIDEO da un URL pubblico: Telegram lo scarica dall'URL e lo consegna in chat (nessun
 * download lato nostro). Limite di Telegram per l'invio da URL: ~20 MB. Ritorna true solo se Telegram
 * conferma `ok:true`; su file troppo grande o URL non raggiungibile ritorna false (il chiamante fa da
 * fallback con un link). Non lancia mai.
 */
export async function sendTelegramVideo(
  chatId: string,
  videoUrl: string,
  options: { caption?: string; effectId?: string } = {},
): Promise<boolean> {
  const body = {
    chat_id: chatId,
    video: videoUrl,
    supports_streaming: true,
    ...(options.caption ? { caption: options.caption, parse_mode: 'HTML' } : {}),
  };
  const withEffect = options.effectId ? { ...body, message_effect_id: options.effectId } : body;
  const data = await telegramCall('sendVideo', withEffect, 45_000);
  if (data?.ok) return true;
  // Effetto rifiutato (es. chat non privata): riprova senza, ma solo se Telegram ha risposto con un
  // errore sull'effetto, per non scaricare due volte un video che non passa per altri motivi.
  if (options.effectId && /effect/i.test(data?.description ?? '')) {
    return Boolean((await telegramCall('sendVideo', body, 45_000))?.ok);
  }
  return false;
}

/** Escapa il testo per parse_mode HTML (solo & < >, come da documentazione Telegram). */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Pulsante "Apri Solco": Mini App (web_app) in chat privata, link normale altrove (dove web_app
 *  non è ammesso nelle tastiere inline). */
function openSolcoButton(chatType: string | null) {
  return chatType === 'private'
    ? { text: '🎧 Apri Solco', web_app: { url: telegramMenuUrl() } }
    : { text: '🎧 Apri Solco', url: BOT_PUBLIC_URL };
}

/** Link Telegram del bot (t.me/<username>) per la condivisione nativa; ripiega sul sito se manca lo username. */
function botTelegramLink(): string {
  const username = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '');
  return username ? `https://t.me/${username}` : BOT_PUBLIC_URL;
}

/** Costruisce il deep-link di condivisione nativa di Telegram (apre «scegli una chat» con testo precompilato). */
function telegramShareUrl(url: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}

/** Condivisione «brand» del bot: porta nuovi utenti dentro il bot (loop virale nativo di Telegram). */
function shareSolcoUrl(): string {
  return telegramShareUrl(
    botTelegramLink(),
    'Ho scoperto Solco 🎧 musica gratis, radio e podcast. Provalo qui 👇',
  );
}

/** Tastiera inline per il messaggio con il codice: condividi l'invito (il gancio virale), apri l'app, premi. */
export function inviteKeyboard(inviteLink: string, chatType: string | null) {
  const shareUrl = telegramShareUrl(
    inviteLink,
    '🎧 Ascolta musica gratis su Solco! Col mio invito, 1 mese di Premium gratis per entrambi 💜',
  );
  return {
    inline_keyboard: [
      [{ text: '📣 Invita amici · Premium per entrambi', url: shareUrl }],
      [openSolcoButton(chatType), { text: '🎁 I tuoi premi', url: publicRewardsUrl() }],
    ],
  };
}

/** Tastiera inline essenziale: solo "Apri Solco" (benvenuto / help / fallback). */
export function miniAppKeyboard(chatType: string | null) {
  return { inline_keyboard: [[openSolcoButton(chatType)]] };
}

/** Tastiera "Ascolta su Solco": apre la ricerca per quelle parole (Mini App in privato, link altrove). */
export function searchKeyboard(query: string, chatType: string | null) {
  const url = `${BOT_PUBLIC_URL}/search?q=${encodeURIComponent(query)}`;
  const open =
    chatType === 'private'
      ? { text: '▶️ Ascolta su Solco', web_app: { url } }
      : { text: '▶️ Ascolta su Solco', url };
  // «Condividi» sposta la ricerca in un'altra chat: la scoperta musicale si propaga (loop virale).
  const share = {
    text: '📲 Condividi',
    url: telegramShareUrl(url, 'Senti cosa ho trovato su Solco 🎧'),
  };
  return { inline_keyboard: [[open, share]] };
}

/**
 * Menu in chat (/menu): tastiera inline con i pulsanti principali. "Apri Solco" apre la Mini App;
 * gli altri sono pulsanti callback che il webhook traduce nel comando testuale corrispondente
 * (TELEGRAM_MENU_CALLBACKS), così riusano la stessa logica (compresa la guardia chat-privata di /scarica).
 */
export function menuKeyboard(chatType: string | null) {
  return {
    inline_keyboard: [
      [openSolcoButton(chatType)],
      // Il gancio virale, in primo piano: il referral (Premium per entrambi).
      [{ text: '🎁 Invita amici · Premium per entrambi', callback_data: 'menu:codice' }],
      [
        { text: '🔎 Cerca musica', callback_data: 'menu:cerca' },
        { text: '⬇️ I miei brani', callback_data: 'menu:scarica' },
      ],
      // Condivisione nativa del bot: un tap porta Solco in un'altra chat.
      [{ text: '📣 Condividi Solco', url: shareSolcoUrl() }],
    ],
  };
}

/** callback_data del menu → comando testuale equivalente (il webhook lo passa a handleUpdate). */
export const TELEGRAM_MENU_CALLBACKS: Record<string, string> = {
  'menu:cerca': '/cerca',
  'menu:scarica': '/scarica',
  'menu:codice': '/codice',
};

/** Chiude lo spinner di un pulsante inline (answerCallbackQuery). Best-effort, non lancia mai. */
export async function answerTelegramCallback(callbackQueryId: string): Promise<void> {
  await telegramApi('answerCallbackQuery', { callback_query_id: callbackQueryId });
}

/** Comandi del bot mostrati nel menu "/" di Telegram (setMyCommands). */
export const TELEGRAM_BOT_COMMANDS = [
  { command: 'menu', description: 'Apri il menu di Solco' },
  { command: 'invita', description: 'Invita amici · Premium gratis per entrambi 🎁' },
  { command: 'cerca', description: 'Cerca musica Creative Commons' },
  { command: 'scarica', description: 'Scarica i tuoi brani caricati su Solco' },
  { command: 'codice', description: 'Il tuo codice di invito' },
  { command: 'app', description: 'Apri Solco (Mini App)' },
  { command: 'help', description: 'Cosa può fare questo bot' },
] as const;

/** Comando owner-only: /video (sperimentale). Mostrato SOLO alle chat admin, via scope per-chat. */
const VIDEO_COMMAND = {
  command: 'video',
  description: '🎬 Scarica un video da un link (sperimentale)',
} as const;

/** Comando owner-only: /skynet, la chat della sentinella di sicurezza. Stesso scope per-chat. */
const SKYNET_COMMAND = {
  command: 'skynet',
  description: '🛰️ Chiedi a Skynet: sicurezza del sito',
} as const;

/** Comando owner-only: /deepseek, chat con DeepSeek sul server dell'owner. Stesso scope per-chat. */
const DEEPSEEK_COMMAND = {
  command: 'deepseek',
  description: '🐋 Chatta con DeepSeek',
} as const;

/** Comandi mostrati agli owner (le chat in SKYNET_TELEGRAM_CHAT_IDS): i pubblici + /video, /skynet, /deepseek. */
export const TELEGRAM_OWNER_COMMANDS = [
  ...TELEGRAM_BOT_COMMANDS,
  VIDEO_COMMAND,
  SKYNET_COMMAND,
  DEEPSEEK_COMMAND,
] as const;

/**
 * Registra i comandi del bot (menu "/"). Best-effort.
 * - Pubblici (scope default) per TUTTI gli utenti.
 * - Owner (con /video e /skynet) SOLO nelle chat admin, con scope per-chat → invisibile agli altri.
 */
export async function setTelegramCommands(): Promise<boolean> {
  const base = await telegramApi('setMyCommands', { commands: TELEGRAM_BOT_COMMANDS });
  let scopedOk = true;
  for (const chat_id of ownerTelegramChatIds().map(Number)) {
    const res = await telegramApi('setMyCommands', {
      commands: TELEGRAM_OWNER_COMMANDS,
      scope: { type: 'chat', chat_id },
    });
    scopedOk = scopedOk && Boolean(res?.ok);
  }
  return Boolean(base?.ok) && scopedOk;
}

/** Imposta descrizione breve (schermata chat vuota) e lunga (profilo) del bot. Best-effort. */
export async function setTelegramDescriptions(): Promise<boolean> {
  const short = await telegramApi('setMyShortDescription', {
    short_description: 'Solco Music — la musica lascia il segno. 🎧',
  });
  const long = await telegramApi('setMyDescription', {
    description:
      'Apri Solco come Mini App 🎧, ricevi il tuo codice di invito e scopri i premi. Scrivi /codice o tocca il pulsante qui sotto.',
  });
  return Boolean(short?.ok && long?.ok);
}
