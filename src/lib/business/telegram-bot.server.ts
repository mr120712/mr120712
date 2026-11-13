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
