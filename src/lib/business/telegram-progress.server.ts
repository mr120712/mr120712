// @polsia:user-owned — l'effetto di download del bot Telegram: mentre il worker prepara il video, un
// solo messaggio si aggiorna con una barra animata e le fasi («Cerco», «Mi collego», «Scarico»,
// «Preparo»), e l'intestazione della chat mostra «sta inviando un video…». A fine lavoro lo stesso
// messaggio diventa ✅ (o ❌) e il video arriva con l'effetto 🎉 di Telegram.
// Il worker non manda l'avanzamento reale: la barra segue il TEMPO (cresce veloce all'inizio e rallenta,
// senza mai toccare il 100% finché il file non è pronto), quindi non promette nulla di falso.
// Ogni chiamata a Telegram è «best effort»: se una fallisce, il download continua e i messaggi finali
// partono come messaggi nuovi.
import 'server-only';
import {
  editTelegramMessage,
  type SendMessageOptions,
  sendTelegramChatAction,
  sendTelegramMessage,
  sendTelegramMessageId,
} from '@/lib/business/telegram-bot.server';

const BAR_CELLS = 10;
const SPINNER = ['◐', '◓', '◑', '◒'];
/** Ogni quanto si aggiorna la barra: Telegram tollera circa una modifica al secondo per chat. */
export const PROGRESS_INTERVAL_MS = 2000;

const STAGES: ReadonlyArray<{ untilMs: number; label: string }> = [
  { untilMs: 3000, label: '🔎 Cerco il video' },
  { untilMs: 8000, label: '📡 Mi collego alla fonte' },
  { untilMs: 22_000, label: '⬇️ Scarico' },
  { untilMs: Number.POSITIVE_INFINITY, label: '🎞️ Preparo il file' },
];

/** La barra ▰▱ di `percent` (0–100) su 10 celle. */
export function progressBar(percent: number): string {
  const full = Math.max(0, Math.min(BAR_CELLS, Math.round((percent / 100) * BAR_CELLS)));
  return '▰'.repeat(full) + '▱'.repeat(BAR_CELLS - full);
}

/**
 * Percentuale mostrata dopo `elapsedMs`: 1 − e^(−t/12 s), al massimo 92% finché il file non è pronto
 * (≈ 22% a 3 s, 49% a 8 s, 84% a 22 s).
 */
export function progressPercent(elapsedMs: number): number {
  const value = 100 * (1 - Math.exp(-Math.max(0, elapsedMs) / 12_000));
  return Math.min(92, Math.round(value));
}

/** Il testo di un fotogramma: fase, barra, percentuale e uno spinner che gira a ogni aggiornamento. */
export function progressFrame(elapsedMs: number, tick: number): string {
  const stage = STAGES.find((s) => elapsedMs < s.untilMs) ?? STAGES[STAGES.length - 1];
  const percent = progressPercent(elapsedMs);
  const spin = SPINNER[((tick % SPINNER.length) + SPINNER.length) % SPINNER.length];
  return `${stage?.label ?? ''}… ${spin}\n${progressBar(percent)} ${percent}%`;
}

/** Il fotogramma finale: barra piena e tempo impiegato. */
export function doneFrame(elapsedMs: number): string {
  return `✅ Pronto in ${Math.max(1, Math.round(elapsedMs / 1000))} s\n${progressBar(100)} 100%`;
}

/** Ogni chiamata a Telegram qui è facoltativa: un errore (anche di import, nei test) non blocca. */
async function attempt<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export type ProgressRun<T> = { value: T; messageId: number | null; elapsedMs: number };

/**
 * Esegue `task` mostrando l'animazione di download nella chat. Restituisce il risultato di `task`, il
 * message_id del messaggio di avanzamento (null se Telegram non l'ha dato) e il tempo impiegato.
 * Se `task` lancia, l'animazione si ferma e l'errore risale.
 */
export async function withDownloadProgress<T>(
  chatId: string,
  task: () => Promise<T>,
  { intervalMs = PROGRESS_INTERVAL_MS, now = () => Date.now() } = {},
): Promise<ProgressRun<T>> {
  const started = now();
  const messageId = await attempt(() => sendTelegramMessageId(chatId, progressFrame(0, 0)), null);
  if (messageId === null) {
    // Senza message_id niente animazione: almeno un messaggio di attesa.
    await attempt(() => sendTelegramMessage(chatId, '⏳ Cerco e preparo il video…'), false);
  }
  void attempt(() => sendTelegramChatAction(chatId, 'upload_video'), undefined);

  let tick = 0;
  let pending: Promise<unknown> = Promise.resolve();
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return; // un aggiornamento ancora in volo: si salta questo giro
    tick += 1;
    busy = true;
    const elapsed = now() - started;
    const jobs: Promise<unknown>[] = [];
    if (messageId !== null) {
      jobs.push(
        attempt(() => editTelegramMessage(chatId, messageId, progressFrame(elapsed, tick)), false),
      );
    }
    // L'azione «sta inviando un video…» dura ~5 s: rinnovata ogni due giri (≈ 4 s).
    if (tick % 2 === 0)
      jobs.push(attempt(() => sendTelegramChatAction(chatId, 'upload_video'), undefined));
    pending = Promise.all(jobs).finally(() => {
      busy = false;
    });
  }, intervalMs);

  try {
    const value = await task();
    return { value, messageId, elapsedMs: now() - started };
  } finally {
    clearInterval(timer);
    await pending; // niente modifica «vecchia» che arrivi dopo il messaggio finale
  }
}

/**
 * Chiude l'animazione: trasforma il messaggio di avanzamento in `text`; se non si può (nessun
 * message_id o modifica rifiutata), invia `text` come messaggio nuovo.
 */
export async function finishProgress(
  chatId: string,
  messageId: number | null,
  text: string,
  options: Pick<SendMessageOptions, 'parseMode' | 'disableWebPagePreview'> = {},
): Promise<boolean> {
  if (messageId !== null) {
    const edited = await attempt(
      () => editTelegramMessage(chatId, messageId, text, options),
      false,
    );
    if (edited) return true;
  }
  return attempt(() => sendTelegramMessage(chatId, text, options), false);
}
