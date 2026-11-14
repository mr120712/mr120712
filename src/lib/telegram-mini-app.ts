// @polsia:user-owned — link diretto alla Mini App del bot Telegram (client-safe, nessun segreto).
// Apre Solco come Mini App a tutto schermo DENTRO Telegram, senza passare dal pulsante-menu del bot.
// Usa lo username pubblico del bot (NEXT_PUBLIC_TELEGRAM_BOT_USERNAME). Perché il link funzioni, la
// "Main Mini App" del bot va abilitata una volta in @BotFather (Bot Settings → Configure Mini App).

/** Username del bot, senza @ e ripulito. Letto a ogni chiamata così è testabile e client-safe. */
function botUsername(): string {
  return (process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? '').trim().replace(/^@/, '');
}

const USERNAME_RE = /^[A-Za-z0-9_]{3,64}$/;
/** start_param della Mini App: solo caratteri sicuri (Telegram ammette A–Z a–z 0–9 _ -). */
const START_PARAM_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** true quando il bot è configurato e quindi un link diretto è costruibile. */
export function isTelegramMiniAppConfigured(): boolean {
  return USERNAME_RE.test(botUsername());
}

/**
 * Link diretto alla Mini App: `https://t.me/<bot>?startapp[=<param>]`, oppure null se il bot non è
 * configurato. `startParam` (facoltativo) arriva nella Mini App come start_param/tgWebAppStartParam;
 * se contiene caratteri non ammessi viene ignorato.
 */
export function telegramMiniAppLink(startParam?: string): string | null {
  const bot = botUsername();
  if (!USERNAME_RE.test(bot)) return null;
  const param = startParam && START_PARAM_RE.test(startParam) ? `=${startParam}` : '';
  return `https://t.me/${bot}?startapp${param}`;
}
