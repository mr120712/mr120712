// @polsia:user-owned — «Skynet», il cacciatore (parte pura). Scelta del proprietario: chi il
// firewall di Vercel ferma per comportamenti da hacker deve superare la verifica del browser su tutto
// il sito: gli strumenti da hacker restano fuori, una persona vera dietro la stessa connessione
// (iCloud Private Relay, operatori mobili) passa in un secondo. Mai un blocco totale.
//
// Potenziato:
// - le sonde da scanner (/.env, /wp-admin, .php…) bastano al primo blocco: nessuna persona le chiede;
//   i tentativi a raffica su accesso, SMS, registrazioni e recupero ne vogliono 2 in 24 ore;
// - chi continua ad attaccare DURANTE la verifica resta fuori più a lungo: 24 ore, poi 7 giorni, poi
//   30 giorni (rinnovati finché insiste);
// - IPv6: la verifica vale per tutta la rete /64, dove un attaccante cambia indirizzo a piacere.
//
// Le regole IP create da Skynet si riconoscono dalla nota «Skynet · verifica fino al <ISO>», con
// «· livello N» dal secondo livello: la nota porta scadenza e livello, così nessun indirizzo IP
// finisce nel database di Solco. Le regole IP messe a mano non vengono mai toccate.

export type OffenderRule = { reason: string; strikes: number };

/** Le regole del firewall che fermano comportamenti da hacker (mai i limiti di traffico generici). */
export const OFFENDER_RULES: Readonly<Record<string, OffenderRule>> = {
  'Skynet · sonde e scanner': { reason: 'sonde da scanner', strikes: 1 },
  // Browser guidati da un programma (HeadlessChrome, PhantomJS…): agenti AI o robot, mai persone.
  'Skynet · browser automatici': { reason: 'browser automatici (agenti AI o robot)', strikes: 1 },
  'Accesso: limite tentativi': { reason: 'tentativi di accesso a raffica', strikes: 2 },
  'Skynet · SMS, registrazioni e recupero': {
    reason: 'abuso di SMS, registrazioni o recupero password',
    strikes: 2,
  },
};
/** Blocchi in 24 ore che bastano sempre, anche sommando regole diverse. */
export const OFFENSES_TO_CHALLENGE = 2;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Durata della verifica per livello: 24 ore; 7 e 30 giorni per chi attacca durante la verifica. */
export const CHALLENGE_LEVELS_MS: readonly number[] = [DAY_MS, 7 * DAY_MS, 30 * DAY_MS];
export const MAX_LEVEL = CHALLENGE_LEVELS_MS.length;
export const CHALLENGE_HOURS = 24;
/** Il registro di Vercel conserva 24 ore di blocchi (fuori dal piano Enterprise). */
export const LOOKBACK_MS = DAY_MS;
/** Tetti di sicurezza: Vercel Pro ammette 100 regole IP; 20 restano per quelle messe a mano. */
export const MAX_SKYNET_IP_RULES = 80;
export const MAX_NEW_PER_RUN = 10;
/** Da quanti nuovi hacker in un giro si avvisa su Telegram (sotto, solo il diario del pannello). */
export const HUNT_WAVE = 5;
export const NOTE_PREFIX = 'Skynet · verifica fino al ';
const LEVEL_MARK = ' · livello ';

export type FirewallBlock = {
  ip: string;
  ruleName: string;
  count: number;
  /** Inizio del blocco (ms); null se Vercel non lo dice. */
  startedAt: number | null;
};
export type IpRule = {
  id: string;
  ip: string;
  hostname: string;
  action: string;
  notes: string | null;
};
/** ip è un indirizzo IPv4 o una rete IPv6 /64. */
export type Offender = { ip: string; offenses: number; reasons: Record<string, number> };
/** Regola Skynet di chi ha attaccato durante la verifica: nuovo livello. */
export type Escalation = {
  rule: IpRule;
  level: number;
  offenses: number;
  reasons: Record<string, number>;
};
export type HuntPlan = {
  challenge: Offender[];
  escalate: Escalation[];
  release: IpRule[];
  /** Hacker in coda per i prossimi giri (al massimo MAX_NEW_PER_RUN nuove regole a giro). */
  queued: number;
  /** Hacker lasciati fuori perché le regole Skynet sono al tetto di sicurezza. */
  capped: number;
  /** Regole Skynet ancora attive dopo il piano. */
  active: number;
  /** Di queste, quelle prolungate (7 o 30 giorni). */
  long: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:.]{2,45}$/i;

/** Gli 8 gruppi da 16 bit di un indirizzo IPv6 (anche abbreviato con «::»); null se non valido. */
function ipv6Groups(ip: string): number[] | null {
  let text = (ip.toLowerCase().split('%')[0] ?? '').trim();
  if (!IPV6.test(text) || !text.includes(':')) return null;
  const tail: number[] = [];
  const quad = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (quad) {
    const [, head = '', v4 = ''] = quad;
    if (!IPV4.test(v4)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4.split('.').map(Number);
    tail.push((a << 8) | b, (c << 8) | d);
    text = head.endsWith('::') ? head : head.slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const split = (part: string) => (part === '' ? [] : part.split(':'));
  const head = split(halves[0] ?? '');
  const rest = halves.length === 2 ? split(halves[1] ?? '') : null;
  if ([...head, ...(rest ?? [])].some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const needed = 8 - tail.length;
  const hex = (group: string) => Number.parseInt(group, 16);
  if (rest === null) return head.length === needed ? [...head.map(hex), ...tail] : null;
  const missing = needed - head.length - rest.length;
  if (missing < 1) return null;
  return [...head.map(hex), ...new Array<number>(missing).fill(0), ...rest.map(hex), ...tail];
}

type Net = { v: 4 | 6; groups: number[]; prefix: number };

/** Indirizzo o rete CIDR in gruppi da 16 bit (IPv4: 2 gruppi; IPv4 dentro IPv6 torna IPv4). */
function parseNet(text: string): Net | null {
  const [address = '', bits, extra] = text.trim().split('/');
  if (extra !== undefined) return null;
  let v: 4 | 6;
  let groups: number[];
  if (IPV4.test(address)) {
    const [a = 0, b = 0, c = 0, d = 0] = address.split('.').map(Number);
    v = 4;
    groups = [(a << 8) | b, (c << 8) | d];
  } else {
    const six = ipv6Groups(address);
    if (!six) return null;
    const mapped = six.slice(0, 5).every((g) => g === 0) && six[5] === 0xffff;
    if (mapped && bits === undefined) {
      v = 4;
      groups = six.slice(6);
    } else {
      v = 6;
      groups = six;
    }
  }
  const max = v === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (bits ?? '0').trim() === '')
    return null;
  return { v, groups, prefix };
}

/** La rete outer contiene tutto inner (indirizzo o rete)? */
function netContains(outer: Net, inner: Net): boolean {
  if (outer.v !== inner.v || inner.prefix < outer.prefix) return false;
  const full = Math.floor(outer.prefix / 16);
  for (let i = 0; i < full; i += 1) if (outer.groups[i] !== inner.groups[i]) return false;
  const rest = outer.prefix % 16;
  if (rest === 0) return true;
  const mask = (0xffff << (16 - rest)) & 0xffff;
  return ((outer.groups[full] ?? 0) & mask) === ((inner.groups[full] ?? 0) & mask);
}

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
  const groups = ipv6Groups(ip);
  if (!groups) return false;
  const [first = 0] = groups;
  if (groups.every((g, i) => g === (i === 7 ? 1 : 0)) || groups.every((g) => g === 0)) return false;
  // Locali (fc00::/7), link-local (fe80::/10).
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return false;
  // IPv4 dentro IPv6 (::ffff:a.b.c.d): vale la regola IPv4.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return isPublicIpLike(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return true;
}

/**
 * Chi riceve la verifica: l'indirizzo IPv4, o per IPv6 la rete /64 intera (un attaccante ci cambia
 * indirizzo a piacere). null per reti private, loopback, CGNAT o testi non validi.
 */
export function huntSubject(ip: string): string | null {
  const address = ip.trim();
  if (!isPublicIpLike(address)) return null;
  const net = parseNet(address);
  if (!net) return null;
  if (net.v === 4) {
    const [hi = 0, lo = 0] = net.groups;
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${net.groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

/** Istante di Vercel («2026-11-18 07:14:06.152», UTC, o millisecondi) in ms; null se illeggibile. */
export function apiTimestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (/^\d{10,}$/.test(text)) return Number(text);
  const iso = /^\d{4}-\d{2}-\d{2} \d/.test(text) ? text.replace(' ', 'T') : text;
  const zoned = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(zoned);
  return Number.isNaN(ms) ? null : ms;
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
    blocks.push({
      ip: ip.trim(),
      ruleName,
      count: Math.max(1, Math.floor(count)),
      startedAt: apiTimestamp(action.startTime ?? action.start_time),
    });
  }
  return blocks;
}

/** Le regole IP del firewall attivo (id, ip, host, azione, nota). */
export function parseIpRules(raw: unknown): IpRule[] {
  const ips = isRecord(raw) && Array.isArray(raw.ips) ? raw.ips : [];
  return ips.flatMap((rule) =>
    isRecord(rule) && typeof rule.id === 'string' && typeof rule.ip === 'string'
      ? [
          {
            id: rule.id,
            ip: rule.ip,
            hostname: typeof rule.hostname === 'string' && rule.hostname ? rule.hostname : '*',
            action: typeof rule.action === 'string' ? rule.action : '',
            notes: typeof rule.notes === 'string' ? rule.notes : null,
          },
        ]
      : [],
  );
}

/** Durata della verifica a un livello (1 = 24 ore). */
export function levelDurationMs(level: number): number {
  const index = Math.min(Math.max(Math.floor(level), 1), MAX_LEVEL) - 1;
  return CHALLENGE_LEVELS_MS[index] ?? DAY_MS;
}

/** Durata leggibile: «24 ore», «7 giorni», «30 giorni». */
export function levelLabel(level: number): string {
  const ms = levelDurationMs(level);
  return ms < 2 * DAY_MS ? `${Math.round(ms / HOUR_MS)} ore` : `${Math.round(ms / DAY_MS)} giorni`;
}

export function skynetNote(expiresAt: Date, level = 1): string {
  const base = `${NOTE_PREFIX}${expiresAt.toISOString()}`;
  return level > 1 ? `${base}${LEVEL_MARK}${Math.min(level, MAX_LEVEL)}` : base;
}

/** Scadenza e livello scritti nella nota di una regola Skynet; null per le regole messe a mano. */
export function parseSkynetNote(notes: string | null): { expiresAt: Date; level: number } | null {
  if (!notes?.startsWith(NOTE_PREFIX)) return null;
  const [when = '', level] = notes.slice(NOTE_PREFIX.length).split(LEVEL_MARK);
  const expiresAt = new Date(when.trim());
  if (Number.isNaN(expiresAt.getTime())) return null;
  const parsed = level === undefined ? 1 : Number(level.trim());
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return { expiresAt, level: Math.min(parsed, MAX_LEVEL) };
}

/**
 * Le regole che Skynet gestisce: le sue verifiche («challenge» con la nota Skynet). Se il
 * proprietario ne cambia l'azione, la regola diventa sua e Skynet non la tocca più.
 */
export function skynetRuleInfo(rule: IpRule): { expiresAt: Date; level: number } | null {
  return rule.action === 'challenge' ? parseSkynetNote(rule.notes) : null;
}

/** Scadenza scritta nella nota di una regola Skynet; null per le regole messe a mano. */
export function noteExpiry(notes: string | null): Date | null {
  return parseSkynetNote(notes)?.expiresAt ?? null;
}

type Tally = { offenses: number; reasons: Record<string, number>; enough: boolean };

function tally(blocks: FirewallBlock[]): Tally {
  const perRule = new Map<string, number>();
  const reasons: Record<string, number> = {};
  let offenses = 0;
  for (const block of blocks) {
    const rule = OFFENDER_RULES[block.ruleName];
    if (!rule) continue;
    offenses += block.count;
    reasons[rule.reason] = (reasons[rule.reason] ?? 0) + block.count;
    perRule.set(block.ruleName, (perRule.get(block.ruleName) ?? 0) + block.count);
  }
  const enough =
    offenses >= OFFENSES_TO_CHALLENGE ||
    [...perRule].some(([name, count]) => count >= (OFFENDER_RULES[name]?.strikes ?? Infinity));
  return { offenses, reasons, enough };
}

/**
 * Cosa fare in questo giro: chi rimandare alla verifica, chi ha attaccato durante la verifica (e
 * sale di livello), quali regole Skynet scadute togliere. Le regole manuali non si toccano mai.
 */
export function planHunt(blocks: FirewallBlock[], rules: IpRule[], now: Date): HuntPlan {
  const offending = blocks.filter((block) => OFFENDER_RULES[block.ruleName] !== undefined);
  const skynet = rules.flatMap((rule) => {
    const note = skynetRuleInfo(rule);
    const net = note ? parseNet(rule.ip) : null;
    return note && net ? [{ rule, net, ...note }] : [];
  });

  // 1. Chi ha attaccato di nuovo dopo l'inizio della sua verifica sale di livello (al massimo si
  //    rinnova l'ultimo): vale anche per le regole appena scadute.
  const escalate: Escalation[] = [];
  for (const entry of skynet) {
    const start = entry.expiresAt.getTime() - levelDurationMs(entry.level);
    const again = offending.filter((block) => {
      const host = parseNet(block.ip);
      return (
        block.startedAt !== null &&
        block.startedAt > start &&
        !!host &&
        netContains(entry.net, host)
      );
    });
    if (again.length === 0) continue;
    const { offenses, reasons } = tally(again);
    escalate.push({
      rule: entry.rule,
      level: Math.min(entry.level + 1, MAX_LEVEL),
      offenses,
      reasons,
    });
  }
  const escalated = new Map(escalate.map((step) => [step.rule.id, step.level]));

  // 2. Le regole Skynet scadute senza nuovi attacchi si tolgono.
  const release = skynet
    .filter((entry) => entry.expiresAt.getTime() <= now.getTime() && !escalated.has(entry.rule.id))
    .map((entry) => entry.rule);
  const released = new Set(release.map((rule) => rule.id));

  // 3. Nuovi hacker: per indirizzo IPv4 o rete IPv6 /64, se non già coperti da una regola in vigore
  //    (manuale o Skynet, anche come rete CIDR).
  const inForce = rules
    .filter((rule) => !released.has(rule.id))
    .flatMap((rule) => {
      const net = parseNet(rule.ip);
      return net ? [net] : [];
    });
  const bySubject = new Map<string, FirewallBlock[]>();
  for (const block of offending) {
    const subject = huntSubject(block.ip);
    if (!subject) continue;
    bySubject.set(subject, [...(bySubject.get(subject) ?? []), block]);
  }
  const candidates: Offender[] = [];
  for (const [subject, list] of bySubject) {
    const net = parseNet(subject);
    if (!net || inForce.some((rule) => netContains(rule, net))) continue;
    const { offenses, reasons, enough } = tally(list);
    if (enough) candidates.push({ ip: subject, offenses, reasons });
  }
  candidates.sort((a, b) => b.offenses - a.offenses || a.ip.localeCompare(b.ip));

  const stillActive = skynet.length - release.length;
  const totalRoom = Math.max(0, MAX_SKYNET_IP_RULES - stillActive);
  const challenge = candidates.slice(0, Math.min(MAX_NEW_PER_RUN, totalRoom));
  const long = skynet.filter(
    (entry) => !released.has(entry.rule.id) && (escalated.get(entry.rule.id) ?? entry.level) > 1,
  ).length;
  return {
    challenge,
    escalate,
    release,
    queued: Math.min(candidates.length, totalRoom) - challenge.length,
    capped: Math.max(0, candidates.length - totalRoom),
    active: stillActive + challenge.length,
    long,
  };
}

/** Indirizzo o rete mascherati per messaggi e diario: «104.23.x.x», «2a02:1810:…/64». */
export function maskIp(ip: string): string {
  const [address = '', bits] = ip.split('/');
  const suffix = bits === undefined ? '' : `/${bits}`;
  if (IPV4.test(address)) {
    const [a, b] = address.split('.');
    return `${a}.${b}.x.x${suffix}`;
  }
  const groups = address.split(':').filter(Boolean);
  return `${groups.slice(0, 2).join(':')}:…${suffix}`;
}

function reasonsText(reasons: Record<string, number>): string {
  return Object.entries(reasons)
    .map(([reason, count]) => `${reason} ×${count}`)
    .join(', ');
}

/**
 * Su Telegram solo i fatti importanti: prolungamenti, errori, ondate (HUNT_WAVE nuovi in un giro) o
 * tetto raggiunto. Le verifiche di routine (una sonda ogni tanto) restano nel diario del pannello.
 */
export function huntIsNotable(result: {
  challenged: number;
  escalated: number;
  failed: number;
  capped: number;
}): boolean {
  return (
    result.escalated > 0 || result.failed > 0 || result.capped > 0 || result.challenged >= HUNT_WAVE
  );
}

/** Titolo dell'avviso del cacciatore. */
export function huntTitle(challenged: number, escalated: number, failed = 0): string {
  if (challenged === 0 && escalated === 0) {
    return failed === 1
      ? 'Il cacciatore non è riuscito ad applicare 1 regola'
      : `Il cacciatore non è riuscito ad applicare ${failed} regole`;
  }
  const fresh =
    challenged === 1
      ? `1 indirizzo rimandato alla verifica per ${CHALLENGE_HOURS} ore`
      : `${challenged} indirizzi rimandati alla verifica per ${CHALLENGE_HOURS} ore`;
  const longer = escalated === 1 ? '1 verifica prolungata' : `${escalated} verifiche prolungate`;
  if (challenged > 0 && escalated > 0) return `${fresh}; ${longer}`;
  if (escalated > 0) return `${longer}: attaccavano anche durante la verifica`;
  return fresh;
}

/** Rapporto in italiano di quello che Skynet ha fatto (indirizzi mascherati). */
export function huntReport(input: {
  challenged: Offender[];
  escalated: Escalation[];
  failed: number;
  queued?: number;
  capped: number;
}): string {
  const lines = input.challenged.map(
    (offender) =>
      `- ${maskIp(offender.ip)}: ${reasonsText(offender.reasons)} → verifica per ${CHALLENGE_HOURS} ore${offender.ip.endsWith('/64') ? ' (tutta la rete IPv6 /64)' : ''}`,
  );
  for (const step of input.escalated) {
    lines.push(
      `- ${maskIp(step.rule.ip)}: ancora all’attacco durante la verifica (${reasonsText(step.reasons)}) → prolungata a ${levelLabel(step.level)}`,
    );
  }
  if (input.failed > 0)
    lines.push(
      `- ${input.failed} non applicat${input.failed === 1 ? 'o' : 'i'}: Vercel ha rifiutato la modifica.`,
    );
  if ((input.queued ?? 0) > 0) {
    lines.push(
      `- ${input.queued} in coda: entrano nei prossimi minuti (al massimo ${MAX_NEW_PER_RUN} nuove regole al minuto).`,
    );
  }
  if (input.capped > 0) {
    lines.push(`- ${input.capped} in attesa: raggiunto il tetto di sicurezza delle regole Skynet.`);
  }
  lines.push(
    '',
    `La verifica del browser vale su tutto il sito: gli strumenti automatici restano fuori, una persona vera passa. Chi attacca anche durante la verifica resta fuori più a lungo (${levelLabel(2)}, poi ${levelLabel(3)}). Le regole si tolgono da sole alla scadenza; per toglierne una prima: Vercel → progetto → Firewall → IP Blocking.`,
  );
  return lines.join('\n');
}
