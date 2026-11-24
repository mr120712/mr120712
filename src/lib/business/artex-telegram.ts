// @polsia:user-owned — /artex command for the Solco Telegram bot.
//
// Scope right now: `/artex status` only. A chat subcommand will land next; keeping
// the parser flexible so adding `ask` later is one match line.
//
// Server-safe: this module is used by the webhook handler (server-only) but
// contains no top-level server imports (easier to test).

import type {
  ArtexChatOutcome,
  ArtexOutcome,
  ArtexStatus,
  ArtexTaskControlOutcome,
} from './artex-client.server';

export const ARTEX_COMMAND = /^\/artex(?:@\w+)?(?:\s+([\s\S]+))?$/i;

/** Max chars in a single Telegram text message (Telegram's own limit is 4096). */
export const ARTEX_TELEGRAM_CHUNK = 3900;

/**
 * Footer tag appended to every /artex ask reply. Lets the user continue the same ARTEX
 * conversation by using Telegram's reply-to on that message: the webhook parses this out of the
 * reply-to text and passes it back to askArtex. Never visible as a link, just data.
 */
export const ARTEX_CONV_TAG = /(?:conversazione|conv\.?)\s*#(\d+)/i;

export type ArtexInput =
  | { kind: 'status' }
  | { kind: 'ask'; question: string }
  | { kind: 'stop'; taskId: string }
  | { kind: 'help' }
  | { kind: 'unknown'; subcommand: string };

export function parseArtexCommand(raw: string): ArtexInput {
  const text = raw.trim();
  if (!text) return { kind: 'help' };
  // Split on first whitespace: subcommand + rest.
  const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(text);
  if (!match) return { kind: 'help' };
  const subcommand = (match[1] ?? '').toLowerCase();
  const rest = (match[2] ?? '').trim();
  if (subcommand === 'status' || subcommand === 'stato') return { kind: 'status' };
  if (subcommand === 'help' || subcommand === 'aiuto' || subcommand === '?')
    return { kind: 'help' };
  // `ask`, `chiedi`, `chat` — all forward the rest as a question. With no rest,
  // nudge back to usage so the user doesn't send an empty question to ARTEX.
  if (subcommand === 'ask' || subcommand === 'chiedi' || subcommand === 'chat') {
    return rest ? { kind: 'ask', question: rest } : { kind: 'help' };
  }
  // `stop <id>` / `ferma <id>` / `pausa <id>` — pause a running task. Only digit ids pass.
  if (subcommand === 'stop' || subcommand === 'ferma' || subcommand === 'pausa') {
    const taskId = rest.match(/^\d+/)?.[0];
    return taskId ? { kind: 'stop', taskId } : { kind: 'help' };
  }
  return { kind: 'unknown', subcommand };
}

/**
 * Pull the ARTEX conversation id out of the text of a Telegram message we replied to earlier (our
 * own /artex ask footer, "conversazione #N"). Returns null when the text isn't one of ours.
 */
export function extractArtexConversationId(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = ARTEX_CONV_TAG.exec(text);
  if (!match) return null;
  const n = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const ARTEX_USAGE =
  '🛡️ <b>ARTEX</b>\n' +
  'Comandi:\n' +
  '• <code>/artex status</code> — attività e findings\n' +
  "• <code>/artex ask &lt;domanda&gt;</code> — chatta con l'agente. " +
  'Rispondi (Telegram reply) a una risposta di ARTEX per continuare la stessa conversazione.\n' +
  '• <code>/artex stop &lt;id&gt;</code> — metti in pausa un task in esecuzione\n' +
  '\n' +
  'Lo <code>scan</code> di nuovi target non è esposto dal bot per sicurezza — crea i task ' +
  'dalla UI ARTEX dove puoi validare lo scope.';

export function artexTelegramMessages(outcome: ArtexOutcome): string[] {
  if (outcome.status === 'not_configured') {
    return [
      '🛡️ ARTEX non è collegato: imposta <code>ARTEX_URL</code> e <code>ARTEX_PASSWORD</code> su Vercel per usare questo comando.',
    ];
  }
  if (outcome.status === 'failed') {
    const why =
      outcome.error === 'unauthorized'
        ? 'Password ARTEX sbagliata o server non raggiungibile.'
        : outcome.error === 'unreachable'
          ? 'Non riesco a raggiungere ARTEX. Verifica che il VPS sia attivo e che Caddy stia servendo HTTPS.'
          : 'Errore sconosciuto.';
    return [`🛡️ ARTEX: ${why}`];
  }
  return [renderStatus(outcome.data)];
}

function renderStatus(data: ArtexStatus): string {
  const severityOrder = ['critical', 'high', 'medium', 'low', 'info'];
  const severityEntries = Object.entries(data.findings.bySeverity).sort(([a], [b]) => {
    const ai = severityOrder.indexOf(a.toLowerCase());
    const bi = severityOrder.indexOf(b.toLowerCase());
    return (ai === -1 ? severityOrder.length : ai) - (bi === -1 ? severityOrder.length : bi);
  });
  const findingsLine =
    data.findings.total === 0
      ? 'Findings: nessuno ancora.'
      : `Findings: <b>${data.findings.total}</b>${
          severityEntries.length > 0
            ? ' · ' + severityEntries.map(([sev, n]) => `${escapeHtml(sev)}: ${n}`).join(', ')
            : ''
        }`;
  const tasksLine =
    data.tasks.running > 0
      ? `Task in esecuzione: <b>${data.tasks.running}</b> (di ${data.tasks.total} totali).`
      : `Task totali: <b>${data.tasks.total}</b> (nessuno in esecuzione).`;
  const tokensLine =
    data.tokensToday != null
      ? `Token LLM oggi: <b>${data.tokensToday.toLocaleString('it-IT')}</b>.`
      : null;
  return ['🛡️ <b>ARTEX</b>', tasksLine, findingsLine, ...(tokensLine ? [tokensLine] : [])].join(
    '\n',
  );
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render an /artex ask reply. The agent's text is treated as untrusted (another
 * machine wrote it): HTML-escape it, split into Telegram-sized chunks on paragraph
 * boundaries where possible, falling back to hard character splits.
 *
 * The first chunk gets a 🛡️ header; subsequent chunks are plain continuation.
 */
export function artexChatMessages(outcome: ArtexChatOutcome): string[] {
  if (outcome.status === 'not_configured') {
    return [
      '🛡️ ARTEX non è collegato: imposta <code>ARTEX_URL</code> e <code>ARTEX_PASSWORD</code> su Vercel per usare questo comando.',
    ];
  }
  if (outcome.status === 'failed') {
    const why =
      outcome.error === 'unauthorized'
        ? 'Password ARTEX sbagliata o server non raggiungibile.'
        : outcome.error === 'unreachable'
          ? 'Non riesco a raggiungere ARTEX. Verifica che il VPS sia attivo e che Caddy stia servendo HTTPS.'
          : outcome.error === 'still_running'
            ? "ARTEX sta ancora pensando. Riprovi fra un attimo — di solito vuol dire che la domanda è lunga o che l'agente sta usando uno strumento."
            : outcome.error === 'empty_reply'
              ? "ARTEX ha chiuso la conversazione senza una risposta. Riprovi riformulando la domanda, o controlli con <code>/artex status</code> se l'agente è configurato."
              : outcome.error === 'empty_question'
                ? 'La domanda è vuota: scrivi <code>/artex ask &lt;domanda&gt;</code>.'
                : 'Errore sconosciuto.';
    const tag = outcome.conversationId ? convTag(outcome.conversationId) : '';
    return [`🛡️ ARTEX: ${why}${tag}`];
  }
  return chunkArtexChat(outcome.reply, outcome.conversationId);
}

/** Pretty-prints the outcome of /artex stop &lt;id&gt;. */
export function artexStopMessages(
  outcome: ArtexTaskControlOutcome,
  taskId: string | number,
): string[] {
  if (outcome.status === 'not_configured') {
    return [
      '🛡️ ARTEX non è collegato: imposta <code>ARTEX_URL</code> e <code>ARTEX_PASSWORD</code> su Vercel.',
    ];
  }
  if (outcome.status === 'ok') {
    return [`🛡️ ARTEX: task <b>#${escapeHtml(String(taskId))}</b> messo in pausa.`];
  }
  const why =
    outcome.error === 'not_found'
      ? `Nessun task con id <b>${escapeHtml(String(taskId))}</b>.`
      : outcome.error === 'bad_id'
        ? "L'id del task deve essere un numero."
        : outcome.error === 'unauthorized'
          ? 'Password ARTEX sbagliata o server non raggiungibile.'
          : outcome.error === 'unreachable'
            ? 'Non riesco a raggiungere ARTEX.'
            : 'Errore sconosciuto.';
  return [`🛡️ ARTEX: ${why}`];
}

/** Footer visibile in italico con l'id conversazione, parseabile via ARTEX_CONV_TAG. */
function convTag(conversationId: number): string {
  return `\n\n<i>· conversazione #${conversationId} · rispondi per continuare</i>`;
}

/** Composes just the header+body used for streaming updates (no conv footer). */
export function artexChatStreamingFrame(partial: string): string {
  const header = '🛡️ <b>ARTEX</b>\n';
  const trimmed =
    partial.length > ARTEX_TELEGRAM_CHUNK ? partial.slice(-ARTEX_TELEGRAM_CHUNK) : partial;
  return `${header}${escapeHtml(trimmed)}\n<i>…in corso ✍️</i>`;
}

function chunkArtexChat(reply: string, conversationId?: number): string[] {
  const escaped = escapeHtml(reply);
  const header = '🛡️ <b>ARTEX</b>\n';
  const footer = conversationId ? convTag(conversationId) : '';
  // One short answer fits in one message.
  if (header.length + escaped.length + footer.length <= ARTEX_TELEGRAM_CHUNK) {
    return [header + escaped + footer];
  }
  // Split on blank-line paragraphs where possible, falling back to hard cuts.
  const parts: string[] = [];
  let buf = '';
  const flush = () => {
    if (buf) parts.push(buf.trimEnd());
    buf = '';
  };
  for (const paragraph of escaped.split(/\n{2,}/)) {
    const next = buf ? `${buf}\n\n${paragraph}` : paragraph;
    if (next.length <= ARTEX_TELEGRAM_CHUNK) {
      buf = next;
      continue;
    }
    flush();
    if (paragraph.length <= ARTEX_TELEGRAM_CHUNK) {
      buf = paragraph;
      continue;
    }
    // Paragraph itself is too big — hard-slice.
    for (let i = 0; i < paragraph.length; i += ARTEX_TELEGRAM_CHUNK) {
      parts.push(paragraph.slice(i, i + ARTEX_TELEGRAM_CHUNK));
    }
  }
  flush();
  return parts.map((part, index) => {
    const prefix = index === 0 ? header : '';
    // Footer only on the last part so the conversation tag is near the final text.
    const suffix = index === parts.length - 1 ? footer : '';
    return prefix + part + suffix;
  });
}
