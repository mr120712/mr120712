// @polsia:user-owned — pubblica sul canale Telegram un annuncio per ogni nuova build, UNA sola volta
// (deduplicato per commit, resistente a riavvii e più istanze). Pubblica solo la riga di sintesi del
// commit e la versione breve: niente corpo del commit (trailer, link di sessione), niente env/segreti.
import 'server-only';
import { isTelegramBotConfigured, sendTelegramMessage } from '@/lib/business/telegram-bot.server';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';

/** Rimuove dalla stringa qualcosa che somigli a un segreto (difesa-in-profondità). */
export function redactSecrets(text: string): string {
  return (
    text
      // chiave: valore / chiave=valore con nomi sensibili
      .replace(
        /\b(token|secret|key|password|passwd|bearer|api[_-]?key|auth)\b\s*[:=]\s*\S+/gi,
        '$1: •••',
      )
      // credenziali in un URL (user:pass@host)
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1•••@')
      // blob lunghi tipo token/hash (base64url o hex, ≥ 24 caratteri)
      .replace(/\b[A-Za-z0-9_-]{24,}\b/g, (match) =>
        /^[0-9a-f]+$/i.test(match) || /[_-]/.test(match) ? '•••' : match,
      )
  );
}

/** Compone il testo dell'annuncio: solo la PRIMA riga del messaggio di commit + versione breve. */
export function buildAnnouncementText(commitSha: string, commitMessage: string): string {
  const subjectRaw = (commitMessage.split('\n', 1)[0] ?? '').trim();
  const subject = redactSecrets(subjectRaw).slice(0, 200).trim() || 'Nuovo aggiornamento';
  const shortSha = commitSha.slice(0, 7);
  return `🚀 Solco si è aggiornato\n${subject}\n(versione ${shortSha})`;
}

/** True se gli annunci build sono configurati (bot + canale). */
export function isBuildAnnouncementConfigured(): boolean {
  return isTelegramBotConfigured() && Boolean(env.TELEGRAM_CHANNEL_CHAT_ID);
}

/**
 * Pubblica l'annuncio della build corrente sul canale, una sola volta. Richiede l'id del commit
 * (VERCEL_GIT_COMMIT_SHA) per deduplicare: la create con commitSha @unique fa da "claim" atomico —
 * solo la prima istanza che lo registra pubblica; le altre falliscono la create e saltano. Non lancia
 * mai (best-effort): un problema non deve impedire l'avvio del server.
 */
export async function announceBuildIfNew(): Promise<void> {
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (!commitSha) return; // fuori da Vercel (o build senza git): niente annuncio
  if (!isBuildAnnouncementConfigured()) return;
  const channel = env.TELEGRAM_CHANNEL_CHAT_ID;
  if (!channel) return;

  try {
    // Claim atomico: se esiste già (unique), un'altra istanza ha già annunciato → esci.
    await prisma.buildAnnouncement.create({ data: { commitSha } });
  } catch {
    return;
  }

  try {
    const text = buildAnnouncementText(commitSha, process.env.VERCEL_GIT_COMMIT_MESSAGE ?? '');
    await sendTelegramMessage(channel, text);
  } catch {
    // L'annuncio è best-effort: se l'invio fallisce non si ritenta (il claim resta registrato).
  }
}
