// @polsia:user-owned — /artex command for the Solco Telegram bot.
//
// Scope right now: `/artex status` only. A chat subcommand will land next; keeping
// the parser flexible so adding `ask` later is one match line.
//
// Server-safe: this module is used by the webhook handler (server-only) but
// contains no top-level server imports (easier to test).

import type { ArtexOutcome, ArtexStatus } from './artex-client.server';

export const ARTEX_COMMAND = /^\/artex(?:@\w+)?(?:\s+([\s\S]+))?$/i;

export type ArtexInput =
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'unknown'; subcommand: string };

export function parseArtexCommand(raw: string): ArtexInput {
  const text = raw.trim();
  if (!text) return { kind: 'help' };
  const [sub] = text.split(/\s+/, 1);
  const subcommand = (sub ?? '').toLowerCase();
  if (subcommand === 'status' || subcommand === 'stato') return { kind: 'status' };
  if (subcommand === 'help' || subcommand === 'aiuto' || subcommand === '?')
    return { kind: 'help' };
  return { kind: 'unknown', subcommand };
}

export const ARTEX_USAGE =
  '🛡️ <b>ARTEX</b>\n' +
  'Comandi:\n' +
  '• <code>/artex status</code> — attività e findings del tuo agente ARTEX\n' +
  '\n' +
  'La chat con ARTEX arriva presto: prima verifichiamo che la connessione funzioni.';

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
