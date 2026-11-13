// @polsia:user-owned — client minimale del bot Telegram (invio messaggi) e utilità del link invito.
import 'server-only';
import { env } from '@/lib/env';
import { siteUrl } from '@/lib/site';

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

  const out: TelegramDiagnostics = {
    configured: true,
    channel: { configured: Boolean(channelId) },
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
  }

  return out;
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
