// @polsia:user-owned — /artex command for the Solco Telegram bot.
//
// Scope right now: `/artex status` only. A chat subcommand will land next; keeping
// the parser flexible so adding `ask` later is one match line.
//
// Server-safe: this module is used by the webhook handler (server-only) but
// contains no top-level server imports (easier to test).

import type { ArtexChatOutcome, ArtexOutcome, ArtexStatus } from './artex-client.server';

export const ARTEX_COMMAND = /^\/artex(?:@\w+)?(?:\s+([\s\S]+))?$/i;

/** Max chars in a single Telegram text message (Telegram's own limit is 4096). */
export const ARTEX_TELEGRAM_CHUNK = 3900;

export type ArtexInput =
  | { kind: 'status' }
  | { kind: 'ask'; question: string }
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
  return { kind: 'unknown', subcommand };
}

export const ARTEX_USAGE =
  '🛡️ <b>ARTEX</b>\n' +
  'Comandi:\n' +
  '• <code>/artex status</code> — attività e findings del tuo agente ARTEX\n' +
  "• <code>/artex ask &lt;domanda&gt;</code> — chatta con l'agente (una domanda, una risposta)\n" +
  '\n' +
  "Ogni <code>/artex ask</code> apre una conversazione nuova in ARTEX: non c'è memoria fra due domande.";

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
    return [`🛡️ ARTEX: ${why}`];
  }
  return chunkArtexChat(outcome.reply);
}

function chunkArtexChat(reply: string): string[] {
  const escaped = escapeHtml(reply);
  const header = '🛡️ <b>ARTEX</b>\n';
  // One short answer fits in one message.
  if (header.length + escaped.length <= ARTEX_TELEGRAM_CHUNK) return [header + escaped];
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
  return parts.map((part, index) => (index === 0 ? header + part : part));
}
