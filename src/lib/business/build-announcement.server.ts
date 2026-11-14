// @polsia:user-owned — pubblica sul canale Telegram un annuncio per ogni nuova build, UNA sola volta
// (deduplicato per commit, resistente a riavvii e più istanze). Pubblica solo la riga di sintesi del
// commit e la versione breve: niente corpo del commit (trailer, link di sessione), niente env/segreti.
import 'server-only';
import { Prisma } from '@prisma/client';
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
      // Blob lunghi (≥ 24) tipo chiave/token/hash — base62, base64, base64url o hex, con eventuale
      // padding "=". In un titolo di commit un blob così lungo e contiguo non è testo naturale (le
      // frasi hanno spazi): si oscura SEMPRE. Meglio oscurare di troppo (un path lungo) che lasciar
      // passare un segreto puramente alfanumerico (che le varianti precedenti non coprivano).
      .replace(/[A-Za-z0-9+/_-]{24,}={0,2}/g, '•••')
  );
}

/** Compone il testo dell'annuncio: solo la PRIMA riga del messaggio di commit + versione breve. */
export function buildAnnouncementText(commitSha: string, commitMessage: string): string {
  const subjectRaw = (commitMessage.split('\n', 1)[0] ?? '').trim();
  const subject = redactSecrets(subjectRaw).slice(0, 200).trim() || 'Nuovo aggiornamento';
  const shortSha = commitSha.slice(0, 7);
  const version = shortSha ? `\n(versione ${shortSha})` : '';
  return `🚀 Solco si è aggiornato\n${subject}${version}`;
}

/** True se gli annunci build sono configurati (bot + canale). */
export function isBuildAnnouncementConfigured(): boolean {
  return isTelegramBotConfigured() && Boolean(env.TELEGRAM_CHANNEL_CHAT_ID);
}

/** Dati della build corrente (su Vercel) o stringhe vuote altrove. */
function currentBuild(): { commitSha: string; commitMessage: string } {
  return {
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? '',
    commitMessage: process.env.VERCEL_GIT_COMMIT_MESSAGE ?? '',
  };
}

export type AnnouncementPreview = {
  botConfigured: boolean;
  channelConfigured: boolean;
  commitShort: string;
  preview: string;
  alreadyAnnounced: boolean;
};

/**
 * Anteprima per il pannello admin: cosa verrebbe pubblicato e se è già stato annunciato. Di sola
 * lettura; non invia nulla. Non lancia: in caso di problemi col DB riporta alreadyAnnounced=false.
 */
export async function announcementPreview(): Promise<AnnouncementPreview> {
  const { commitSha, commitMessage } = currentBuild();
  let alreadyAnnounced = false;
  if (commitSha) {
    try {
      alreadyAnnounced = Boolean(
        await prisma.buildAnnouncement.findUnique({ where: { commitSha }, select: { id: true } }),
      );
    } catch {
      alreadyAnnounced = false;
    }
  }
  return {
    botConfigured: isTelegramBotConfigured(),
    channelConfigured: Boolean(env.TELEGRAM_CHANNEL_CHAT_ID),
    commitShort: commitSha.slice(0, 7),
    preview: buildAnnouncementText(commitSha, commitMessage),
    alreadyAnnounced,
  };
}

export type AnnounceReason =
  | 'ok'
  | 'telegram_failed'
  | 'bot_not_configured'
  | 'channel_not_configured';

export type AnnounceResult = { posted: boolean; text: string; reason: AnnounceReason };

/** Link diretto al bot (t.me/<username>), o null se lo username non è configurato/valido. */
export function botInviteLink(): string | null {
  const username = env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '');
  if (!username || !/^[A-Za-z0-9_]{3,64}$/.test(username)) return null;
  return `https://t.me/${username}`;
}

/** Testo del post d'invito al bot sul canale (HTML). Contenuto statico: nessun dato sensibile. */
export function botInviteText(link: string): string {
  return (
    '🎧 <b>Continua su Solco nel bot</b>\n' +
    'Cerca musica Creative Commons, ricevi il tuo codice invito e apri la Mini App — tutto dentro Telegram.\n\n' +
    `👉 Apri il bot: ${link}`
  );
}

export type BotPostReason = AnnounceReason | 'username_not_configured';
export type BotPostResult = { posted: boolean; text: string; reason: BotPostReason };

/**
 * Pubblica SUBITO sul canale un post dedicato che invita ad aprire il bot (azione admin on-demand),
 * con un pulsante inline "Apri il bot". Non deduplica (è una richiesta esplicita, ripetibile).
 */
export async function publishBotInviteNow(): Promise<BotPostResult> {
  if (!isTelegramBotConfigured()) return { posted: false, text: '', reason: 'bot_not_configured' };
  const channel = env.TELEGRAM_CHANNEL_CHAT_ID;
  if (!channel) return { posted: false, text: '', reason: 'channel_not_configured' };
  const link = botInviteLink();
  if (!link) return { posted: false, text: '', reason: 'username_not_configured' };
  const text = botInviteText(link);
  const posted = await sendTelegramMessage(channel, text, {
    parseMode: 'HTML',
    replyMarkup: { inline_keyboard: [[{ text: '▶️ Apri il bot', url: link }]] },
  });
  return { posted, text, reason: posted ? 'ok' : 'telegram_failed' };
}

/**
 * Pubblica SUBITO l'annuncio della build corrente sul canale (azione admin on-demand). A differenza
 * di announceBuildIfNew(), pubblica anche se il commit è già registrato (è una richiesta esplicita);
 * registra comunque il commit (upsert) così l'annuncio automatico al boot non lo ripubblica.
 */
export async function publishAnnouncementNow(): Promise<AnnounceResult> {
  if (!isTelegramBotConfigured()) {
    return { posted: false, text: '', reason: 'bot_not_configured' };
  }
  const channel = env.TELEGRAM_CHANNEL_CHAT_ID;
  if (!channel) return { posted: false, text: '', reason: 'channel_not_configured' };

  const { commitSha, commitMessage } = currentBuild();
  const text = buildAnnouncementText(commitSha, commitMessage);
  const posted = await sendTelegramMessage(channel, text);
  if (posted && commitSha) {
    try {
      // Segna il commit come annunciato così seed() non lo ripubblica al prossimo boot.
      await prisma.buildAnnouncement.upsert({
        where: { commitSha },
        create: { commitSha },
        update: {},
      });
    } catch {
      // La registrazione è solo anti-doppione: se fallisce, il post è comunque andato.
    }
  }
  return { posted, text, reason: posted ? 'ok' : 'telegram_failed' };
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
    // Claim atomico: la create con commitSha @unique registra questa build.
    await prisma.buildAnnouncement.create({ data: { commitSha } });
  } catch (error) {
    // Solo la violazione di unicità (P2002) significa "già annunciato da un'altra istanza" → esci.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
    // Errore transitorio (es. P2024 pool timeout al boot su stack scale-to-zero): nessuna riga
    // scritta, quindi NON è un dedup-hit. Rilancia invece di fingere "già annunciato": seed.ts
    // (.catch) e instrumentation.ts lo ingoiano, così il boot non si blocca e un cold boot ritenta.
    throw error;
  }

  // Invio DOPO il claim. sendTelegramMessage non lancia: ritorna false su errore/timeout/non-2xx.
  // Se NON è andato a buon fine, rilascia il claim così un boot futuro potrà ritentare (altrimenti
  // il claim resterebbe e l'annuncio non partirebbe mai — es. bot non ancora admin del canale).
  let sent = false;
  try {
    const text = buildAnnouncementText(commitSha, process.env.VERCEL_GIT_COMMIT_MESSAGE ?? '');
    sent = await sendTelegramMessage(channel, text);
  } catch {
    sent = false;
  }
  if (!sent) {
    await prisma.buildAnnouncement.delete({ where: { commitSha } }).catch(() => undefined);
  }
}
