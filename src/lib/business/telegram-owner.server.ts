// @polsia:user-owned — «chi è l'owner del bot?» deciso con un gate sicuro. Una chat è owner se:
//   1) il suo ID numerico è in SKYNET_TELEGRAM_CHAT_IDS (configurazione esplicita), OPPURE
//   2) è collegata a un account AMMINISTRATORE con email verificata. Il collegamento nasce solo dal
//      codice monouso che il sito genera a utente loggato (Impostazioni → «Collega account Telegram»):
//      prova che chi scrive al bot controlla quell'account, senza ID o username dichiarati a mano.
// Secondo fattore opzionale: SKYNET_TELEGRAM_OWNER_USERNAMES. Se impostata, sulla strada (2) anche lo
// username Telegram di chi scrive deve essere fra quelli elencati, così un account admin collegato a un
// ALTRO Telegram non ottiene i comandi riservati. Da solo lo username non basta MAI: può cambiare di
// mano, e un refuso darebbe accesso a un estraneo.
import 'server-only';
import { resolveAdminAccess } from '@/lib/business/admin-account-policy';
import { ownerTelegramChatIds } from '@/lib/business/telegram-owner-chats';
import { prisma } from '@/lib/db';

type Env = Record<string, string | undefined>;

export type TelegramOwnerCheck =
  | { owner: true; via: 'chat-id' | 'admin-link' }
  | { owner: false; reason: 'not-linked' | 'not-admin' | 'username-mismatch' | 'unavailable' };

/** Username Telegram autorizzati (senza @, minuscoli). Lista vuota = nessun vincolo sullo username. */
export function ownerTelegramUsernames(env: Env = process.env): string[] {
  return (env.SKYNET_TELEGRAM_OWNER_USERNAMES ?? '')
    .split(/[\s,;]+/)
    .map((name) => name.replace(/^["'`@]+|["'`]+$/g, '').toLowerCase())
    .filter((name) => /^[a-z0-9_]{4,32}$/.test(name));
}

/**
 * Decide se la chat è dell'owner (vedi l'intestazione). `username` è quello di chi ha scritto il
 * messaggio, così come lo certifica Telegram nell'update. Fail-closed: un errore del database non
 * concede mai l'accesso.
 */
export async function checkTelegramOwner(
  chatId: string,
  username: string | null,
  env: Env = process.env,
): Promise<TelegramOwnerCheck> {
  if (ownerTelegramChatIds(env).includes(chatId)) return { owner: true, via: 'chat-id' };

  try {
    const link = await prisma.telegramAccountLink.findUnique({
      where: { telegramChatId: chatId },
      select: { userId: true },
    });
    if (!link) return { owner: false, reason: 'not-linked' };
    const user = await prisma.user.findUnique({
      where: { id: link.userId },
      select: { role: true, email: true, emailVerified: true },
    });
    if (resolveAdminAccess(false, user) !== 'authorized') {
      return { owner: false, reason: 'not-admin' };
    }
  } catch {
    return { owner: false, reason: 'unavailable' };
  }

  const allowed = ownerTelegramUsernames(env);
  if (allowed.length > 0 && !allowed.includes((username ?? '').toLowerCase())) {
    return { owner: false, reason: 'username-mismatch' };
  }
  return { owner: true, via: 'admin-link' };
}
