// @polsia:user-owned — /ig nel bot Telegram (owner-only): comando, parsing e testi di risposta.
// Puro (niente rete), così è testabile. La ricerca vera è findInstagramCreators.
import type { InstagramFinderOutcome } from '@/lib/business/instagram-finder.server';
import type { InstagramFinderInput } from '@/lib/contracts/instagram-finder';

/** /ig <descrizione> oppure /instagram <descrizione> (anche /ig@NomeBot). */
export const INSTAGRAM_COMMAND = /^\/(?:ig|instagram)(?:@\w+)?(?:\s+([\s\S]+))?$/i;

export const INSTAGRAM_TELEGRAM_MAX_INPUT = 500;
/** Il webhook ha maxDuration 60 s: la ricerca si ferma prima, con quello che ha trovato. */
export const INSTAGRAM_TELEGRAM_BUDGET_MS = 45_000;
export const INSTAGRAM_TELEGRAM_AI_TIMEOUT_MS = 12_000;
const SHOWN = 8;

export const INSTAGRAM_USAGE =
  'Uso: <b>/ig descrizione</b> (o <b>/instagram</b>)\n' +
  'Es. <i>/ig producer lo-fi italiani 5k-100k #lofibeats @nome.account</i>\n\n' +
  '• <b>#hashtag</b> (max 5) e <b>@username</b> da verificare, facoltativi\n' +
  '• <b>5k-100k</b> = intervallo di follower (anche <b>10k+</b>)\n' +
  'Solo account Business/Creator pubblici, via API ufficiale di Meta.';

function count(value: string): number | undefined {
  const match = /^(\d+(?:[.,]\d+)?)([km])?$/i.exec(value);
  if (!match?.[1]) return undefined;
  const base = Number(match[1].replace(',', '.'));
  const unit = match[2]?.toLowerCase();
  return Math.round(base * (unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1));
}

/** Estrae dalla frase hashtag, username e intervallo di follower; il resto è la descrizione. */
export function parseInstagramCommand(text: string): InstagramFinderInput {
  const hashtags: string[] = [];
  const usernames: string[] = [];
  let minFollowers: number | undefined;
  let maxFollowers: number | undefined;
  const rest = text
    .replace(/(^|\s)#([\p{L}\p{N}_]{2,50})/gu, (_all, space: string, tag: string) => {
      hashtags.push(tag);
      return space;
    })
    .replace(/(^|\s)@([A-Za-z0-9._]{1,30})/g, (_all, space: string, name: string) => {
      usernames.push(name.replace(/\.+$/, ''));
      return space;
    })
    .replace(
      /(^|\s)(\d+(?:[.,]\d+)?[km]?)\s*[-–]\s*(\d+(?:[.,]\d+)?[km]?)(?:\s*follower\w*)?(?=\s|$)/gi,
      (_all, space: string, low: string, high: string) => {
        minFollowers = count(low);
        maxFollowers = count(high);
        return space;
      },
    )
    .replace(
      /(^|\s)(\d+(?:[.,]\d+)?[km]?)\+(?:\s*follower\w*)?(?=\s|$)/gi,
      (_all, space: string, low: string) => {
        minFollowers = count(low);
        return space;
      },
    )
    .replace(/\s+/g, ' ')
    .trim();
  const brief = rest.length >= 3 ? rest : text.replace(/\s+/g, ' ').trim();
  return {
    brief: brief.slice(0, INSTAGRAM_TELEGRAM_MAX_INPUT),
    hashtags: [...new Set(hashtags)].slice(0, 5),
    usernames: [...new Set(usernames)].slice(0, 20),
    ...(minFollowers !== undefined ? { minFollowers } : {}),
    ...(maxFollowers !== undefined && (minFollowers ?? 0) <= maxFollowers ? { maxFollowers } : {}),
  };
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const compact = new Intl.NumberFormat('it-IT', { notation: 'compact', maximumFractionDigits: 1 });

const FAILURES: Record<
  Exclude<InstagramFinderOutcome, { ok: true }>['error'] | 'not_configured',
  string
> = {
  not_configured:
    'Instagram non è collegato: imposta INSTAGRAM_ACCESS_TOKEN e INSTAGRAM_BUSINESS_ACCOUNT_ID su Vercel.',
  auth: 'Meta rifiuta il token (scaduto o revocato): generane uno nuovo di lunga durata.',
  permission:
    'permesso mancante sul token: servono instagram_basic, pages_show_list e pages_read_engagement.',
  rate_limited: 'limite di richieste di Meta raggiunto: riprova fra un’ora.',
  hashtag_limit: 'limite di Meta di 30 hashtag diversi ogni 7 giorni.',
  not_found: 'nessun account trovato.',
  timeout: 'Meta non ha risposto in tempo: riprova.',
  failed: 'errore della Graph API di Meta.',
};

/** Il fotogramma dell'attesa (HTML). */
export function instagramFrame(elapsedMs: number, tick: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  return `<b>📸 Cerco creator su Instagram</b>${'.'.repeat(((tick % 4) + 4) % 4)}\n<i>${seconds} s</i>`;
}

/** I messaggi HTML per un esito (≤ 4096 caratteri ciascuno). */
export function instagramTelegramMessages(
  outcome: InstagramFinderOutcome | { ok: false; error: 'not_configured'; detail?: string },
): string[] {
  if (!outcome.ok) {
    const detail = outcome.detail ? `\n<code>${escapeHtml(outcome.detail)}</code>` : '';
    return [`❌ Instagram: ${escapeHtml(FAILURES[outcome.error])}${detail}`];
  }
  const { result } = outcome;
  const tags = result.hashtags.map((tag) => `#${tag}`).join(' ') || '—';
  const aiOnly = result.mode === 'ai_only';
  const head = aiOnly
    ? `<b>📸 ${result.creators.length} creator suggeriti dall’AI</b> (non verificati)\n` +
      `<i>${escapeHtml(result.summary)}</i>`
    : `<b>📸 ${result.creators.length} creator trovati</b>\n` +
      `<i>${escapeHtml(result.summary)}</i>\n` +
      `Hashtag: ${escapeHtml(tags)} · ${result.checked} controllati, ${result.skipped} non Business/Creator` +
      (result.aiRanked ? ' · ordinati dall’AI' : '');
  const warnings = result.warnings.length
    ? `\n\n${result.warnings.map((w) => `⚠️ ${escapeHtml(w)}`).join('\n')}`
    : '';
  if (result.creators.length === 0) {
    return [
      `${head}${warnings}\n\nNessun creator adatto: prova altri #hashtag o aggiungi @username.`,
    ];
  }
  const cards = result.creators.slice(0, SHOWN).map((c, index) => {
    const lines = [
      `<b>${index + 1}. <a href="https://www.instagram.com/${c.username}/">@${escapeHtml(c.username)}</a></b> · ${c.score}/100`,
      c.verified
        ? `${compact.format(c.followers)} follower · ${(c.engagementRate * 100).toFixed(1)}% engagement · ${compact.format(c.avgLikes)} like medi`
        : c.name
          ? escapeHtml(c.name)
          : '',
      escapeHtml(c.reason),
    ].filter(Boolean);
    if (c.biography)
      lines.push(`<i>${escapeHtml(c.biography.replace(/\s+/g, ' ').slice(0, 140))}</i>`);
    return lines.join('\n');
  });
  const more =
    result.creators.length > SHOWN
      ? `\n\n…e altri ${result.creators.length - SHOWN}: lista completa e CSV su /admin/instagram-finder`
      : '';
  const messages: string[] = [];
  let current = `${head}${warnings}`;
  for (const card of cards) {
    if (current.length + card.length + 2 > 3800) {
      messages.push(current);
      current = card;
    } else {
      current += `\n\n${card}`;
    }
  }
  messages.push(`${current}${more}`);
  return messages;
}
