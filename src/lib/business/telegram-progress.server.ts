// @polsia:user-owned — gli effetti «dal vivo» del bot Telegram: mentre un lavoro lungo gira, un solo
// messaggio si aggiorna da sé e l'intestazione della chat mostra l'azione in corso.
//  - /video: barra animata e fasi («Cerco», «Mi collego», «Scarico», «Preparo»), «sta inviando un
//    video…»; a fine lavoro lo stesso messaggio diventa ✅ (o ❌) e il video arriva con l'effetto 🎉.
//  - /skynet: scansione radar con le fasi di Skynet, «sta scrivendo…»; poi il messaggio diventa la
//    risposta.
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

// --- Skynet: scansione radar (nessuna percentuale: non si sa quanto durerà la ricerca) ---

const SKYNET_STAGES: ReadonlyArray<{ untilMs: number; label: string }> = [
  { untilMs: 2500, label: '🛰️ Mi collego alle sentinelle' },
  { untilMs: 6000, label: '📡 Leggo monitoraggio, log e sicurezza' },
  { untilMs: 12_000, label: '🧠 Incrocio le fonti' },
  { untilMs: Number.POSITIVE_INFINITY, label: '✍️ Scrivo la risposta' },
];
const RADAR = ['◜', '◝', '◞', '◟'];
const SCAN_CELLS = 8;

/** Un punto luminoso che va avanti e indietro sulla linea (▱▱▰▱▱…), come un radar che spazza. */
export function scanLine(tick: number): string {
  const span = SCAN_CELLS - 1;
  const step = ((tick % (2 * span)) + 2 * span) % (2 * span);
  const at = step <= span ? step : 2 * span - step;
  return Array.from({ length: SCAN_CELLS }, (_, i) => (i === at ? '▰' : '▱')).join('');
}

/** Un fotogramma della scansione di Skynet dopo `elapsedMs` (HTML). */
export function skynetFrame(elapsedMs: number, tick: number): string {
  const stage =
    SKYNET_STAGES.find((s) => elapsedMs < s.untilMs) ?? SKYNET_STAGES[SKYNET_STAGES.length - 1];
  const radar = RADAR[((tick % RADAR.length) + RADAR.length) % RADAR.length];
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  return `<b>🛰️ Skynet</b> ${radar} scansione in corso\n${stage?.label ?? ''}…\n<code>${scanLine(tick)}</code> ${seconds} s`;
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

type LiveStatus = {
  /** Il testo del fotogramma dopo `elapsedMs`, al giro `tick`. */
  frame: (elapsedMs: number, tick: number) => string;
  /** Il messaggio di attesa se Telegram non dà il message_id (niente animazione). */
  waitingText: string;
  /** L'azione mostrata nell'intestazione della chat. */
  action: 'typing' | 'upload_video';
  parseMode?: 'HTML';
  intervalMs?: number;
  now?: () => number;
};

/**
 * Esegue `task` mostrando un messaggio che si anima da sé. Restituisce il risultato di `task`, il
 * message_id del messaggio animato (null se Telegram non l'ha dato) e il tempo impiegato. Se `task`
 * lancia, l'animazione si ferma e l'errore risale.
 */
export async function withLiveStatus<T>(
  chatId: string,
  task: () => Promise<T>,
  {
    frame,
    waitingText,
    action,
    parseMode,
    intervalMs = PROGRESS_INTERVAL_MS,
    now = () => Date.now(),
  }: LiveStatus,
): Promise<ProgressRun<T>> {
  const started = now();
  const format = parseMode ? { parseMode } : {};
  const messageId = await attempt(() => sendTelegramMessageId(chatId, frame(0, 0), format), null);
  if (messageId === null) {
    // Senza message_id niente animazione: almeno un messaggio di attesa.
    await attempt(() => sendTelegramMessage(chatId, waitingText), false);
  }
  void attempt(() => sendTelegramChatAction(chatId, action), undefined);

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
      const text = frame(elapsed, tick);
      jobs.push(attempt(() => editTelegramMessage(chatId, messageId, text, format), false));
    }
    // L'azione nell'intestazione dura ~5 s: rinnovata ogni due giri (≈ 4 s).
    if (tick % 2 === 0) jobs.push(attempt(() => sendTelegramChatAction(chatId, action), undefined));
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

/** /video: barra di download, «sta inviando un video…». */
export function withDownloadProgress<T>(
  chatId: string,
  task: () => Promise<T>,
  options: Pick<LiveStatus, 'intervalMs' | 'now'> = {},
): Promise<ProgressRun<T>> {
  return withLiveStatus(chatId, task, {
    frame: progressFrame,
    waitingText: '⏳ Cerco e preparo il video…',
    action: 'upload_video',
    ...options,
  });
}

/** /skynet: scansione radar, «sta scrivendo…». */
export function withSkynetScan<T>(
  chatId: string,
  task: () => Promise<T>,
  options: Pick<LiveStatus, 'intervalMs' | 'now'> = {},
): Promise<ProgressRun<T>> {
  return withLiveStatus(chatId, task, {
    frame: skynetFrame,
    waitingText: '🛰️ Cerco in tutte le fonti…',
    action: 'typing',
    parseMode: 'HTML',
    ...options,
  });
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
