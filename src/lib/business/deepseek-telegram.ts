// @polsia:user-owned — /deepseek nel bot Telegram (owner-only): comando, animazione e testi di risposta.
// Puro (niente rete), così è testabile. La chiamata vera è askDeepseek (deepseek-chat.server.ts).
import type { DeepseekFailure, DeepseekOutcome } from '@/lib/business/deepseek-chat.server';

/** /deepseek <messaggio> oppure /ds <messaggio> (anche /deepseek@NomeBot). */
export const DEEPSEEK_COMMAND = /^\/(?:deepseek|ds)(?:@\w+)?(?:\s+([\s\S]+))?$/i;

/** Lunghezza massima del messaggio inoltrato (come la chat admin). */
export const DEEPSEEK_TELEGRAM_MAX_INPUT = 8000;

/** Il webhook ha maxDuration 60 s: si lascia margine per inviare la risposta. */
export const DEEPSEEK_TELEGRAM_TIMEOUT_MS = 50_000;

/** Risposte più corte nel bot: finiscono prima del limite di 60 s (e Telegram le spezza comunque). */
export const DEEPSEEK_TELEGRAM_MAX_TOKENS = 1024;

/** sendMessage accetta al più 4096 caratteri: si spezza sotto, con margine per l'HTML. */
const CHUNK = 3800;

export const DEEPSEEK_USAGE =
  'Uso: <b>/deepseek messaggio</b> (o <b>/ds</b>)\nEs. <i>/ds spiegami il routing MoE</i>\n\nOgni messaggio è a sé: nessuna memoria della conversazione.';

const FAILURES: Record<DeepseekFailure | 'not_configured', string> = {
  not_configured:
    'nessun backend IA configurato (imposta MWAPI_API_KEY su Vercel, o DEEPSEEK_SOLCO_PROVIDERS)',
  worker_unauthorized: 'il worker rifiuta la chiave (WORKER_API_KEY su Render ≠ YTDLP_SERVICE_KEY)',
  chat_not_configured: 'sul worker manca DEEPSEEK_ENDPOINT_URL',
  busy: 'il worker è occupato, riprova fra qualche secondo',
  model_unreachable: 'il server DeepSeek non risponde',
  timeout: 'il modello non ha risposto in tempo: riprova, o chiedi una risposta più breve',
  model_error: 'il server DeepSeek ha restituito un errore',
  bad_response: 'risposta non valida dal server DeepSeek',
  provider_auth: 'il provider rifiuta la chiave (es. OPENROUTER_API_KEY su Vercel non valida)',
  provider_credit:
    'credito esaurito sul provider (es. ricarica OpenRouter, o usa un modello :free)',
  model_not_found:
    'modello non disponibile su quel provider: controlla DEEPSEEK_SOLCO_MODEL e DEEPSEEK_SOLCO_PROVIDERS',
  provider_rate_limited: 'il provider ha raggiunto il limite di richieste: riprova fra poco',
};

const DOTS = ['', '.', '..', '...'];

/** Fotogramma dell'attesa (HTML). */
export function deepseekFrame(elapsedMs: number, tick: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  const dots = DOTS[((tick % DOTS.length) + DOTS.length) % DOTS.length];
  return `<b>🐋 DeepSeek</b> sta pensando${dots}\n<i>${seconds} s</i>`;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Spezza il testo in pezzi ≤ CHUNK, preferendo andare a capo su righe vuote / a capo / spazi. */
export function splitForTelegram(text: string, size: number = CHUNK): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    const window = rest.slice(0, size);
    // Il primo separatore (nell'ordine) che cade nella seconda metà del pezzo; se nessuno, taglio netto.
    const cut = ['\n\n', '\n', ' ']
      .map((separator) => window.lastIndexOf(separator))
      .find((index) => index > size * 0.5);
    const at = cut ?? size;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** I messaggi HTML da inviare per un esito: il primo sostituisce l'animazione, gli altri seguono. */
export function deepseekTelegramMessages(outcome: DeepseekOutcome): string[] {
  if (outcome.status !== 'ok') {
    const key = outcome.status === 'not_configured' ? 'not_configured' : outcome.error;
    const detail = outcome.status === 'failed' && outcome.detail ? outcome.detail : '';
    return [
      `❌ DeepSeek: ${escapeHtml(FAILURES[key])}.${detail ? `\n<code>${escapeHtml(detail)}</code>` : ''}`,
    ];
  }
  // Si spezza PRIMA di fare l'escape, così un'entità HTML non resta tagliata a metà.
  return splitForTelegram(outcome.reply).map(escapeHtml);
}
