// @polsia:user-owned — testi e orari della pagina /admin/monitoraggio (ora italiana, tempo
// relativo in italiano). Solo funzioni pure: nessun import server-only.
import type {
  MonitorCheckId,
  MonitorCheckStatus,
  MonitorRun,
  MonitorRunSummary,
  MonitorTrigger,
} from '@/lib/contracts/monitoring';
import { MONITOR_CHECKS, OVERALL_STATUS_LABELS } from '@/lib/monitoring/catalog';

/** The latest run is shown as outdated past this age (same threshold as /api/status). */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
/**
 * The daily Vercel cron (vercel.json "41 5 * * *"; on Hobby it may start anywhere in that hour)
 * is late past one day plus a margin.
 */
export const DAILY_CRON_LATE_MS = 26 * 60 * 60 * 1000;

const absoluteFormat = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const relativeFormat = new Intl.RelativeTimeFormat('it', { numeric: 'always' });
const numberFormat = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });

export type CheckDisplayStatus = MonitorCheckStatus | 'missing';

export const CHECK_STATUS_TEXT: Record<CheckDisplayStatus, string> = {
  ok: 'Funziona',
  warn: 'Avviso',
  fail: 'Non funziona',
  missing: 'Non eseguito',
};

export const TRIGGER_TEXT: Record<MonitorTrigger, string> = {
  status: 'avviato dal controllo orario di GitHub tramite l’indirizzo pubblico /api/status',
  cron: 'avviato dal controllo giornaliero di Vercel',
  admin: 'avviato da un amministratore',
};

/** "11 nov, 11:25" in Europe/Rome. */
export function formatAbsolute(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? 'data sconosciuta' : absoluteFormat.format(time);
}

/** "5 minuti fa", "2 ore fa", "3 giorni fa". A time slightly in the future (clock skew) is now. */
export function formatRelative(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return 'in un momento sconosciuto';
  const seconds = Math.min(0, Math.round((time - now) / 1000));
  const elapsed = -seconds;
  if (elapsed < 45) return 'pochi secondi fa';
  if (elapsed < 45 * 60) return relativeFormat.format(Math.round(seconds / 60), 'minute');
  if (elapsed < 48 * 60 * 60) return relativeFormat.format(Math.round(seconds / 3600), 'hour');
  return relativeFormat.format(-Math.floor(elapsed / 86_400), 'day');
}

/** "5 minuti fa (11 nov, 11:25)". */
export function formatWhen(iso: string, now: number): string {
  return `${formatRelative(iso, now)} (${formatAbsolute(iso)})`;
}

export function isStale(iso: string, now: number, maxAgeMs = STALE_AFTER_MS): boolean {
  const time = Date.parse(iso);
  return Number.isNaN(time) || now - time > maxAgeMs;
}

/** A scheduled job with no run in the stored history (it keeps only the latest runs). */
export function notFoundInHistory(count: number): string {
  if (count === 0) return 'non trovato: lo storico è vuoto';
  if (count === 1) return 'non trovato nell’ultimo controllo';
  return `non trovato negli ultimi ${count} controlli`;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${numberFormat.format(ms / 1000)} s`;
}

export function checkLabels(ids: readonly MonitorCheckId[]): string {
  return ids.map((id) => MONITOR_CHECKS[id].label).join(', ');
}

/** Accessible name of one history dot: time, overall status and the failing checks. */
export function historyEntryLabel(entry: MonitorRunSummary, now: number): string {
  const parts = [formatWhen(entry.startedAt, now), OVERALL_STATUS_LABELS[entry.status]];
  if (entry.failing.length > 0) parts.push(`non funzionavano: ${checkLabels(entry.failing)}`);
  return parts.join(' — ');
}

export function summarizeRun(run: MonitorRun): MonitorRunSummary {
  return {
    id: run.id,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    status: run.status,
    trigger: run.trigger,
    failing: run.results.filter((result) => result.status === 'fail').map((result) => result.id),
  };
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/** "12 funzionano · 1 avviso · 1 non funziona". */
export function countsText(run: MonitorRun): string {
  const count = (status: MonitorCheckStatus) =>
    run.results.filter((result) => result.status === status).length;
  const parts = [plural(count('ok'), 'funziona', 'funzionano')];
  const warnings = count('warn');
  const failures = count('fail');
  if (warnings > 0) parts.push(plural(warnings, 'avviso', 'avvisi'));
  if (failures > 0) parts.push(plural(failures, 'non funziona', 'non funzionano'));
  return parts.join(' · ');
}
