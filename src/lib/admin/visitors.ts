// @polsia:user-owned — calcoli puri della scheda Visitatori (nessun accesso al database né a
// node:crypto): normalizzazione del percorso della pagina, host di provenienza, tipo di dispositivo
// dal browser, riconoscimento dei robot e del monitor, composizione della risposta dalle righe
// aggregate di Postgres (zero compresi). Usati dalla route del segnale (POST /api/visits), dalla
// route admin e dai test.
import { romeDayKey, shiftDayKey, toCount } from '@/lib/admin/signups';
import {
  type AdminVisitors,
  VISIT_DEVICES,
  VISITORS_DAYS,
  VISITORS_RETENTION_DAYS,
  VISITORS_TIME_ZONE,
  VISITORS_TOP_LIMIT,
  type VisitDevice,
  type VisitorCountry,
  type VisitorDay,
  type VisitorDeviceCount,
  type VisitorPage,
  type VisitorReferrer,
} from '@/lib/contracts/admin-visitors';
import { VISIT_PATH_MAX_LENGTH } from '@/lib/contracts/site-visit';

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Caratteri ammessi in un percorso di pagina (niente spazi, query o frammenti). */
const PATH_CHARS = /^\/[A-Za-z0-9\-._~%/]*$/;
/** Prefissi delle aree che non si contano: amministrazione e API. */
const EXCLUDED_PREFIXES = ['/admin', '/api/', '/_next/'];
/**
 * Percorsi con un segmento variabile dopo il primo (id di playlist, profili, quiz, brani in
 * evidenza, articoli): si contano come "/prefisso/*", così la statistica non elenca id o titoli.
 * I generi hanno un elenco chiuso e corto e restano per nome.
 */
const KEEP_SECOND_SEGMENT = new Set(['generi']);

/** Il monitor automatico del sito e i robot più comuni: non sono visitatori. */
const AUTOMATED_USER_AGENT =
  /SolcoMonitor\/|bot\b|bot\/|crawl|spider|slurp|headless|lighthouse|pingdom|uptime|monitor|preview|fetch|curl\/|wget\/|python-requests|go-http-client|axios\/|node-fetch|facebookexternalhit|whatsapp|telegrambot|discordbot|twitterbot|linkedinbot|bingpreview|yandex|baidu|duckduck|applebot|petalbot|semrush|ahrefs|mj12bot|dotbot|screaming frog|vercel-screenshot|chrome-lighthouse/i;

/** True per i robot, gli strumenti da riga di comando e il monitor di Solco; false per i browser. */
export function isAutomatedUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true;
  return AUTOMATED_USER_AGENT.test(userAgent);
}

/** Tipo di dispositivo dal browser: tablet (iPad, tablet Android), telefono o desktop. */
export function deviceFrom(userAgent: string | null | undefined): VisitDevice {
  const ua = userAgent ?? '';
  if (
    /iPad|Tablet|PlayBook|Silk|Kindle/i.test(ua) ||
    (/Android/i.test(ua) && !/Mobile/i.test(ua))
  ) {
    return 'tablet';
  }
  if (/Mobi|iPhone|iPod|Android|Windows Phone|webOS|BlackBerry|Opera Mini/i.test(ua)) {
    return 'mobile';
  }
  return 'desktop';
}

/**
 * Il percorso da contare, o null se la pagina non si conta: deve essere un pathname semplice (niente
 * query, frammenti, caratteri strani), non dell'amministrazione o dell'API. La barra finale sparisce,
 * il percorso vuoto è "/", e i percorsi con un secondo segmento variabile diventano "/prefisso/*".
 */
export function normalizeVisitPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > VISIT_PATH_MAX_LENGTH) return null;
  if (!PATH_CHARS.test(trimmed) || trimmed.includes('//') || trimmed.includes('/.')) return null;
  const withoutSlash = trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
  const path = withoutSlash.length === 0 ? '/' : withoutSlash;
  if (
    EXCLUDED_PREFIXES.some(
      (prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix),
    )
  ) {
    return null;
  }
  const segments = path.split('/').slice(1);
  if (segments.length >= 2) {
    const first = segments[0] ?? '';
    if (!KEEP_SECOND_SEGMENT.has(first)) return `/${first}/*`;
    return `/${first}/${segments[1]}`;
  }
  return path;
}

/**
 * L'host del sito di provenienza (minuscolo, senza porta), o null se manca, non è un URL http(s) o è
 * il sito stesso (una pagina interna che ne apre un'altra non è una "provenienza").
 */
export function referrerHostFrom(
  referrer: string | null | undefined,
  ownHosts: readonly string[],
): string | null {
  if (!referrer) return null;
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (!host || host.length > 253) return null;
  // Confronto senza "www." da entrambe le parti: solcomusic.online e www.solcomusic.online sono lo
  // stesso sito.
  const apex = (name: string) => name.toLowerCase().replace(/^www\./, '');
  const own = new Set(ownHosts.map(apex));
  if (own.has(apex(host))) return null;
  return host;
}

/** Codice Paese dall'header dell'hosting ("IT"), o null se assente o non a due lettere. */
export function countryFrom(header: string | null | undefined): string | null {
  const value = header?.trim().toUpperCase();
  return value && /^[A-Z]{2}$/.test(value) ? value : null;
}

/** I giorni del grafico in ora italiana, dal più vecchio a oggi compreso. */
export function visitorDayKeys(now: Date, days: number = VISITORS_DAYS): string[] {
  const today = romeDayKey(now);
  return Array.from({ length: days }, (_, index) => shiftDayKey(today, index - (days - 1)));
}

/** Istante prima del quale le righe vengono cancellate (90 giorni). */
export function visitRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - VISITORS_RETENTION_DAYS * 86_400_000);
}

/** Una riga per giorno con almeno una visita (valori bigint da Postgres). */
export type RawVisitorDay = { day: unknown; visitors: unknown; views: unknown };
export type RawVisitorPage = { path: unknown; visitors: unknown; views: unknown };
export type RawVisitorCountry = { country: unknown; visitors: unknown };
export type RawVisitorReferrer = { host: unknown; visitors: unknown };
export type RawVisitorDevice = { device: unknown; visitors: unknown };

export type RawVisitorStats = {
  daily: readonly RawVisitorDay[];
  pages: readonly RawVisitorPage[];
  countries: readonly RawVisitorCountry[];
  referrers: readonly RawVisitorReferrer[];
  devices: readonly RawVisitorDevice[];
};

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new TypeError('Testo non valido.');
  return value;
}

function sumWindow(days: readonly VisitorDay[], from: number) {
  const slice = days.slice(from);
  return {
    visitors: slice.reduce((sum, day) => sum + day.visitors, 0),
    views: slice.reduce((sum, day) => sum + day.views, 0),
  };
}

/**
 * Compone la risposta copiando SOLO i campi aggregati per nome e riempiendo con zero i giorni senza
 * visite: qualunque altra colonna nelle righe grezze non arriva mai al client. Le finestre di 7 e
 * 30 giorni sommano i visitatori distinti di ogni giorno (l'impronta cambia ogni giorno).
 */
export function buildVisitorStats(
  now: Date,
  keys: readonly string[],
  raw: RawVisitorStats,
): AdminVisitors {
  const byDay = new Map<string, { visitors: number; views: number }>();
  for (const row of raw.daily) {
    if (typeof row.day !== 'string' || !DAY_KEY.test(row.day))
      throw new TypeError('Giorno non valido.');
    byDay.set(row.day, { visitors: toCount(row.visitors), views: toCount(row.views) });
  }
  const daily: VisitorDay[] = keys.map((day) => ({
    day,
    visitors: byDay.get(day)?.visitors ?? 0,
    views: byDay.get(day)?.views ?? 0,
  }));
  const pages: VisitorPage[] = raw.pages.slice(0, VISITORS_TOP_LIMIT).map((row) => ({
    path: text(row.path, 200),
    visitors: toCount(row.visitors),
    views: toCount(row.views),
  }));
  const countries: VisitorCountry[] = raw.countries.slice(0, VISITORS_TOP_LIMIT).map((row) => ({
    country: row.country === null || row.country === undefined ? '' : text(row.country, 2),
    visitors: toCount(row.visitors),
  }));
  const referrers: VisitorReferrer[] = raw.referrers.slice(0, VISITORS_TOP_LIMIT).map((row) => ({
    host: text(row.host, 253),
    visitors: toCount(row.visitors),
  }));
  const devices: VisitorDeviceCount[] = raw.devices
    .filter((row) => (VISIT_DEVICES as readonly unknown[]).includes(row.device))
    .map((row) => ({ device: row.device as VisitDevice, visitors: toCount(row.visitors) }));
  return {
    generatedAt: now.toISOString(),
    timeZone: VISITORS_TIME_ZONE,
    retentionDays: VISITORS_RETENTION_DAYS,
    today: sumWindow(daily, daily.length - 1),
    last7d: sumWindow(daily, Math.max(0, daily.length - 7)),
    last30d: sumWindow(daily, 0),
    daily,
    pages,
    countries,
    referrers,
    devices,
  };
}
