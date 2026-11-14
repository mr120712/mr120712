// @polsia:user-owned — calcoli puri della scheda Iscritti (nessun accesso al database): giorno di
// calendario in ora italiana, i 30 giorni del grafico, inizio delle finestre mobili, conversione
// dei conteggi restituiti da Postgres e riempimento con zero dei giorni senza iscrizioni.
import {
  type AdminSignupDay,
  type AdminSignups,
  SIGNUPS_DAYS,
  SIGNUPS_TIME_ZONE,
} from '@/lib/contracts/admin-signups';

const DAY_MS = 86_400_000;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

const romeDayParts = new Intl.DateTimeFormat('en-US', {
  timeZone: SIGNUPS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Giorno di calendario a Roma (`YYYY-MM-DD`) dell'istante dato; ora legale compresa. */
export function romeDayKey(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new RangeError('Data non valida.');
  const parts: Record<string, string> = {};
  for (const part of romeDayParts.formatToParts(date)) parts[part.type] = part.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Sposta un giorno di calendario di `delta` giorni. Aritmetica sulle sole date di calendario
 * (in UTC, senza ore), quindi i giorni di 23 o 25 ore del cambio d'ora non contano.
 */
export function shiftDayKey(key: string, delta: number): string {
  const match = DAY_KEY.exec(key);
  if (!match || !Number.isInteger(delta)) throw new RangeError(`Giorno non valido: ${key}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + delta));
  return date.toISOString().slice(0, 10);
}

/** I giorni del grafico in ora italiana, dal più vecchio a oggi compreso. */
export function signupDayKeys(now: Date, days: number = SIGNUPS_DAYS): string[] {
  const today = romeDayKey(now);
  return Array.from({ length: days }, (_, index) => shiftDayKey(today, index - (days - 1)));
}

/** Inizio delle finestre mobili delle schede (24 ore, 7 e 30 giorni), come istanti ISO in UTC. */
export function signupWindows(now: Date) {
  const at = now.getTime();
  if (!Number.isFinite(at)) throw new RangeError('Data non valida.');
  return {
    nowIso: now.toISOString(),
    since24h: new Date(at - DAY_MS).toISOString(),
    since7d: new Date(at - 7 * DAY_MS).toISOString(),
    since30d: new Date(at - 30 * DAY_MS).toISOString(),
  };
}

/** Postgres restituisce COUNT(*) come bigint (BigInt in JS): diventa un intero sicuro o errore. */
export function toCount(value: unknown): number {
  const count =
    typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d+$/.test(value)
          ? Number(value)
          : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('Conteggio non valido.');
  return count;
}

/**
 * Un giorno per ogni chiave, nell'ordine delle chiavi, con zero dove non ci sono righe. Le righe
 * fuori finestra (per esempio una data di creazione nel futuro) vengono ignorate.
 */
export function zeroFillDays(
  keys: readonly string[],
  rows: readonly { day: string; count: number }[],
): AdminSignupDay[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.day, (counts.get(row.day) ?? 0) + row.count);
  return keys.map((day) => ({ day, count: counts.get(day) ?? 0 }));
}

/** Riga unica dei totali, come la restituisce la query aggregata (valori bigint). */
export type RawSignupTotals = Record<
  'total' | 'last24h' | 'last7d' | 'last30d' | 'verified' | 'banned' | 'admins',
  unknown
>;
/** Una riga per giorno con almeno un'iscrizione. */
export type RawSignupDay = { day: unknown; count: unknown };

/**
 * Compone la risposta copiando SOLO i campi aggregati per nome: qualunque altra colonna presente
 * nelle righe grezze non arriva mai nella risposta.
 */
export function buildSignupStats(
  now: Date,
  keys: readonly string[],
  totals: RawSignupTotals | undefined,
  daily: readonly RawSignupDay[],
): AdminSignups {
  if (!totals) throw new TypeError('Totali mancanti.');
  const rows = daily.map((row) => {
    if (typeof row.day !== 'string' || !DAY_KEY.test(row.day)) {
      throw new TypeError('Giorno non valido.');
    }
    return { day: row.day, count: toCount(row.count) };
  });
  return {
    generatedAt: now.toISOString(),
    timeZone: SIGNUPS_TIME_ZONE,
    totals: {
      total: toCount(totals.total),
      last24h: toCount(totals.last24h),
      last7d: toCount(totals.last7d),
      last30d: toCount(totals.last30d),
      verified: toCount(totals.verified),
      banned: toCount(totals.banned),
      admins: toCount(totals.admins),
    },
    daily: zeroFillDays(keys, rows),
  };
}
