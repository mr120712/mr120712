// @polsia:user-owned — segnala un acquisto in-app sospetto. Due canali, entrambi senza segreti:
//   1. log strutturato `[iap-fraud]` (sempre) — mai purchaseToken né chiavi, solo ciò che serve ad
//      agire (motivo, piattaforma, prodotto, id utente). Lo raccoglie il log di Vercel.
//   2. avviso Telegram agli amministratori (se configurato), sulle stesse chat di Skynet
//      (SKYNET_TELEGRAM_CHAT_IDS). Best-effort: un errore di invio non interrompe nulla.
import 'server-only';

type Env = Record<string, string | undefined>;

export type IapFraudReason =
  | 'account_mismatch' // il token dello store non è legato a questo utente
  | 'duplicate_account' // l'abbonamento è già legato a un altro account Solco
  | 'integrity_failed' // Play Integrity: app o dispositivo non attendibili
  | 'sandbox_in_production'; // ricevuta sandbox/test arrivata in produzione

const LABELS: Record<IapFraudReason, string> = {
  account_mismatch: 'token non legato a questo account',
  duplicate_account: 'abbonamento già su un altro account',
  integrity_failed: 'Play Integrity negativo (app/dispositivo)',
  sandbox_in_production: 'ricevuta di test in produzione',
};

/** Chat Telegram degli amministratori (le stesse di Skynet). Al massimo 5, solo id numerici. */
function adminChatIds(env: Env): string[] {
  return (env.SKYNET_TELEGRAM_CHAT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^-?\d{3,20}$/.test(id))
    .slice(0, 5);
}

export type IapFraudSignal = {
  reason: IapFraudReason;
  platform: 'apple' | 'google';
  userId: string;
  productId?: string;
  /** Dettaglio non sensibile (es. il motivo tecnico del verdetto Integrity o l'ambiente). */
  detail?: string;
};

/** Registra (sempre) e avvisa (se configurato) un segnale di frode IAP. Best-effort: non lancia mai. */
export async function reportIapFraudSignal(
  signal: IapFraudSignal,
  env: Env = process.env,
): Promise<void> {
  try {
    // biome-ignore lint/suspicious/noConsole: log del server per il monitoraggio (mai token né segreti).
    console.warn(
      '[iap-fraud]',
      JSON.stringify({
        reason: signal.reason,
        platform: signal.platform,
        productId: signal.productId ?? null,
        userId: signal.userId,
        detail: signal.detail ?? null,
        at: new Date().toISOString(),
      }),
    );
  } catch {
    // il log non deve mai propagare
  }

  const ids = adminChatIds(env);
  if (ids.length === 0) return;
  const lines = [
    '🛡️ <b>Solco · acquisto sospetto</b>',
    `Piattaforma: ${signal.platform}`,
    `Motivo: ${LABELS[signal.reason]}`,
    signal.productId ? `Prodotto: ${signal.productId}` : null,
    `Utente: <code>${signal.userId}</code>`,
    signal.detail ? `Dettaglio: ${signal.detail}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
  // Import pigro: il percorso degli acquisti non tira dentro Telegram/env se non c'è nessuno da avvisare.
  const { sendTelegramMessage } = await import('@/lib/business/telegram-bot.server');
  await Promise.all(
    ids.map((id) =>
      sendTelegramMessage(id, lines, { parseMode: 'HTML', disableWebPagePreview: true }).catch(
        () => undefined,
      ),
    ),
  );
}
