// @polsia:user-owned — «Skynet», il cacciatore (parte pura). Scelta del proprietario: chi il
// firewall di Vercel ha già fermato almeno OFFENSES_TO_CHALLENGE volte in 24 ore per sonde da
// scanner o per tentativi ripetuti su accesso, SMS, registrazioni o recupero password deve
// superare la verifica del browser su tutto il sito per CHALLENGE_HOURS ore: gli strumenti da hacker
// restano fuori, una persona vera dietro la stessa connessione (iCloud Private Relay, operatori
// mobili) passa in un secondo. Mai un blocco totale.
//
// Le regole IP create da Skynet si riconoscono dalla nota «Skynet · verifica fino al <ISO>», che
// porta anche la scadenza: nessun indirizzo IP finisce nel database di Solco. Le regole IP messe
// a mano non vengono mai toccate.

/** Le regole del firewall che fermano comportamenti da hacker (mai i limiti di traffico generici). */
export const OFFENDER_RULES: Readonly<Record<string, string>> = {
  'Skynet · sonde e scanner': 'sonde da scanner',
  'Accesso: limite tentativi': 'tentativi di accesso a raffica',
  'Skynet · SMS, registrazioni e recupero': 'abuso di SMS, registrazioni o recupero password',
};
export const OFFENSES_TO_CHALLENGE = 2;
export const CHALLENGE_HOURS = 24;
export const LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Tetti di sicurezza: mai più di tante regole Skynet attive, né troppe nuove in un solo giro. */
export const MAX_SKYNET_IP_RULES = 50;
export const MAX_NEW_PER_RUN = 10;
export const NOTE_PREFIX = 'Skynet · verifica fino al ';

export type FirewallBlock = { ip: string; ruleName: string; count: number };
export type IpRule = { id: string; ip: string; action: string; notes: string | null };
export type Offender = { ip: string; offenses: number; reasons: Record<string, number> };
export type HuntPlan = {
  challenge: Offender[];
  release: IpRule[];
  /** Recidivi lasciati fuori per i tetti di sicurezza. */
  capped: number;
  /** Regole Skynet ancora attive dopo il piano. */
  active: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:]{2,39}$/i;

export function isPublicIpLike(ip: string): boolean {
  if (IPV4.test(ip)) {
    const [a, b] = ip.split('.').map(Number);
    // Reti private, loopback, link-local e CGNAT: mai una regola su queste.
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)) return false;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return false;
    return true;
  }
  if (IPV6.test(ip) && ip.includes(':')) {
    const lower = ip.toLowerCase();
    return !(
      lower === '::1' ||
      lower.startsWith('fe80:') ||
      lower.startsWith('fc') ||
      lower.startsWith('fd')
    );
  }
  return false;
}

/** I blocchi persistenti dal registro di Vercel (accetta sia public_ip sia publicIp). */
export function parseFirewallBlocks(raw: unknown): FirewallBlock[] {
  const actions = isRecord(raw) && Array.isArray(raw.actions) ? raw.actions : [];
  const blocks: FirewallBlock[] = [];
  for (const action of actions) {
    if (!isRecord(action)) continue;
    const ip = action.public_ip ?? action.publicIp;
    const ruleName = action.ruleName ?? action.rule_name;
    const count =
      typeof action.count === 'number' && Number.isFinite(action.count) ? action.count : 1;
    if (typeof ip !== 'string' || typeof ruleName !== 'string') continue;
    blocks.push({ ip: ip.trim(), ruleName, count: Math.max(1, Math.floor(count)) });
  }
  return blocks;
}

/** Le regole IP del firewall attivo (id, ip, azione, nota). */
export function parseIpRules(raw: unknown): IpRule[] {
  const ips = isRecord(raw) && Array.isArray(raw.ips) ? raw.ips : [];
  return ips.flatMap((rule) =>
    isRecord(rule) && typeof rule.id === 'string' && typeof rule.ip === 'string'
      ? [
          {
            id: rule.id,
            ip: rule.ip,
            action: typeof rule.action === 'string' ? rule.action : '',
            notes: typeof rule.notes === 'string' ? rule.notes : null,
          },
        ]
      : [],
  );
}

export function skynetNote(expiresAt: Date): string {
  return `${NOTE_PREFIX}${expiresAt.toISOString()}`;
}

/** Scadenza scritta nella nota di una regola Skynet; null per le regole messe a mano. */
export function noteExpiry(notes: string | null): Date | null {
  if (!notes?.startsWith(NOTE_PREFIX)) return null;
  const when = new Date(notes.slice(NOTE_PREFIX.length).trim());
  return Number.isNaN(when.getTime()) ? null : when;
}

/** Cosa fare in questo giro: chi rimandare alla verifica, quali regole Skynet scadute togliere. */
export function planHunt(blocks: FirewallBlock[], rules: IpRule[], now: Date): HuntPlan {
  const skynetRules = rules.filter((rule) => noteExpiry(rule.notes) !== null);
  const release = skynetRules.filter(
    (rule) => (noteExpiry(rule.notes)?.getTime() ?? 0) <= now.getTime(),
  );
  const covered = new Set(rules.map((rule) => rule.ip));
  for (const rule of release) covered.delete(rule.ip);

  const byIp = new Map<string, Offender>();
  for (const block of blocks) {
    const reason = OFFENDER_RULES[block.ruleName];
    if (!reason || !isPublicIpLike(block.ip)) continue;
    const entry = byIp.get(block.ip) ?? { ip: block.ip, offenses: 0, reasons: {} };
    entry.offenses += block.count;
    entry.reasons[reason] = (entry.reasons[reason] ?? 0) + block.count;
    byIp.set(block.ip, entry);
  }
  const candidates = [...byIp.values()]
    .filter((offender) => offender.offenses >= OFFENSES_TO_CHALLENGE && !covered.has(offender.ip))
    .sort((a, b) => b.offenses - a.offenses || a.ip.localeCompare(b.ip));

  const stillActive = skynetRules.length - release.length;
  const room = Math.max(0, Math.min(MAX_NEW_PER_RUN, MAX_SKYNET_IP_RULES - stillActive));
  const challenge = candidates.slice(0, room);
  return {
    challenge,
    release,
    capped: candidates.length - challenge.length,
    active: stillActive + challenge.length,
  };
}

/** Indirizzo mascherato per messaggi e diario: «104.23.x.x», «2a02:1810:…». */
export function maskIp(ip: string): string {
  if (IPV4.test(ip)) {
    const [a, b] = ip.split('.');
    return `${a}.${b}.x.x`;
  }
  const groups = ip.split(':').filter(Boolean);
  return `${groups.slice(0, 2).join(':')}:…`;
}

/** Rapporto in italiano di quello che Skynet ha fatto (indirizzi mascherati). */
export function huntReport(
  done: Offender[],
  failed: number,
  capped: number,
  hours = CHALLENGE_HOURS,
): string {
  const lines = done.map((offender) => {
    const why = Object.entries(offender.reasons)
      .map(([reason, count]) => `${reason} ×${count}`)
      .join(', ');
    return `- ${maskIp(offender.ip)}: ${why}`;
  });
  if (failed > 0)
    lines.push(
      `- ${failed} non applicat${failed === 1 ? 'o' : 'i'}: Vercel ha rifiutato la modifica.`,
    );
  if (capped > 0) {
    lines.push(`- ${capped} in attesa: raggiunto il tetto di sicurezza delle regole Skynet.`);
  }
  lines.push(
    '',
    `Per ${hours} ore questi indirizzi devono superare la verifica del browser su tutto il sito: gli strumenti automatici restano fuori, una persona vera passa. La regola si toglie da sola alla scadenza; per toglierla prima: Vercel → progetto → Firewall → IP Blocking.`,
  );
  return lines.join('\n');
}
