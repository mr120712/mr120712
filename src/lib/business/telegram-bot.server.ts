// @polsia:user-owned — client minimale del bot Telegram (invio messaggi, diagnostica, webhook) e
// utilità del link invito.
import 'server-only';
import { env } from '@/lib/env';
import { siteUrl } from '@/lib/site';

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

/** Link di invito pubblico per un codice referral (imposta il cookie e porta alla registrazione). */
export function inviteLinkForCode(code: string): string {
  return `${siteUrl}/invito/${code}`;
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
  return `${siteUrl}/api/telegram/webhook`;
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
  return {
    ...base,
    currentUrl,
    matches,
    pendingUpdates: Number(info.result.pending_update_count ?? 0),
    lastError:
      typeof info.result.last_error_message === 'string' ? info.result.last_error_message : null,
    ready: botConfigured && secretConfigured && matches,
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
    allowed_updates: ['message'],
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
  return siteUrl;
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

/** Imposta il pulsante-menu del bot su una Mini App che apre Solco. */
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
  if (res?.ok) {
    return { ok: true, message: `Pulsante «${TELEGRAM_MENU_BUTTON_TEXT}» impostato nel bot.` };
  }
  return {
    ok: false,
    message: res?.description
      ? redactToken(res.description, env.TELEGRAM_BOT_TOKEN ?? '')
      : 'setChatMenuButton non riuscito (nessuna risposta da Telegram).',
  };
}

/** Invia un messaggio di testo a una chat. Non lancia mai: ritorna solo esito. */
export async function sendTelegramMessage(chatId: string, text: string): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  const signal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(8000)
      : undefined;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
      signal,
    });
    return res.ok;
  } catch {
    return false;
  }
}
