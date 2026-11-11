// @polsia:user-owned — pagina /admin/monitoraggio: esito dell'ultimo controllo automatico,
// dettaglio di ogni controllo, storico delle ultime 48 esecuzioni, lavori pianificati e il
// pulsante "Controlla ora". Legge e scrive solo tramite /api/admin/monitoring.
'use client';

import {
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleX,
  ExternalLink,
  type LucideIcon,
  OctagonX,
  RefreshCw,
  RotateCw,
  TriangleAlert,
} from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ZodError } from 'zod';
import { AppSurface } from '@/components/custom/app-ui/app-shell';
import { EmptyState } from '@/components/custom/app-ui/empty-state';
import { PageHeader } from '@/components/custom/app-ui/page-header';
import { Panel } from '@/components/custom/app-ui/panel';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import {
  type AdminMonitoring,
  AdminMonitoringSchema,
  AdminMonitorRunResponseSchema,
  MONITOR_CHECK_IDS,
  type MonitorCheckResult,
  type MonitorHeartbeat,
  type MonitorOverallStatus,
  type MonitorRun,
  type MonitorRunSummary,
} from '@/lib/contracts/monitoring';
import { MONITOR_CHECKS, OVERALL_STATUS_LABELS } from '@/lib/monitoring/catalog';
import styles from './monitoring-dashboard.module.css';
import {
  CHECK_STATUS_TEXT,
  type CheckDisplayStatus,
  checkLabels,
  countsText,
  DAILY_CRON_LATE_MS,
  formatMs,
  formatWhen,
  historyEntryLabel,
  isStale,
  notFoundInHistory,
  summarizeRun,
  TRIGGER_TEXT,
} from './monitoring-format';

const ENDPOINT = '/api/admin/monitoring';
const HISTORY_LIMIT = 48;
const GITHUB_MONITOR_URL = 'https://github.com/mr120712/mr120712/actions/workflows/monitor.yml';
const ERROR_TEXT_MAX = 300;

/** Heartbeats with their own line; 'monitor' is written by every run, so it is not repeated. */
const HANDLED_HEARTBEATS = new Set(['cleanup', 'monitor']);

const OVERALL_ICONS: Record<MonitorOverallStatus, LucideIcon> = {
  ok: CircleCheck,
  degraded: CircleAlert,
  down: OctagonX,
};

const CHECK_ICONS: Record<CheckDisplayStatus, LucideIcon> = {
  ok: CircleCheck,
  warn: TriangleAlert,
  fail: CircleX,
  missing: CircleMinus,
};

const ERROR_CODE_TEXT: Record<string, string> = {
  unauthorized: 'La sessione è scaduta: accedi di nuovo.',
  forbidden: 'Serve un account amministratore con email verificata.',
  forbidden_origin: 'Richiesta rifiutata per sicurezza: ricarica la pagina e riprova.',
  session_unavailable: 'Non riesco a verificare la sessione in questo momento. Riprova tra poco.',
};

/** Server message (e.g. the 429 wait time) when there is one, else a short Italian fallback. */
function failureMessage(error: unknown, fallback: string): string {
  if (error instanceof ZodError) return 'La risposta del server non è nel formato atteso.';
  if (error instanceof TypeError) return 'Connessione non riuscita: controlla la rete e riprova.';
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { message?: unknown; error?: unknown })
      : null;
  if (typeof cause?.message === 'string' && cause.message.trim()) {
    return cause.message.trim().slice(0, ERROR_TEXT_MAX);
  }
  const code = cause?.error;
  return typeof code === 'string' && Object.hasOwn(ERROR_CODE_TEXT, code)
    ? (ERROR_CODE_TEXT[code] ?? fallback)
    : fallback;
}

function withRun(data: AdminMonitoring, run: MonitorRun): AdminMonitoring {
  const history = [summarizeRun(run), ...data.history.filter((entry) => entry.id !== run.id)];
  return { ...data, latest: run, history: history.slice(0, HISTORY_LIMIT) };
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: AdminMonitoring };

export function MonitoringDashboard() {
  const [view, setView] = useState<ViewState>({ kind: 'loading' });
  const [running, setRunning] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const viewRef = useRef(view);
  const runningRef = useRef(false);
  const requestRef = useRef(0);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setView({ kind: 'loading' });
    try {
      const data = await apiFetch(ENDPOINT, { schema: AdminMonitoringSchema });
      if (request !== requestRef.current) return;
      setNow(Date.now());
      setView({ kind: 'ready', data });
    } catch (error) {
      if (request !== requestRef.current) return;
      setView({
        kind: 'error',
        message: failureMessage(error, 'Lo storico dei controlli non è disponibile. Riprova.'),
      });
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      // Ignore a response that arrives after the page was left.
      requestRef.current += 1;
    };
  }, [load]);

  // Keeps "5 minuti fa" honest while the page stays open.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const runNow = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setAnnouncement('Controllo in corso: può richiedere fino a 30 secondi.');
    try {
      const { run } = await apiFetch(ENDPOINT, {
        method: 'POST',
        schema: AdminMonitorRunResponseSchema,
      });
      const text = `Controllo completato: ${OVERALL_STATUS_LABELS[run.status]}.`;
      setAnnouncement(text);
      if (run.status === 'ok') toast.success(text);
      else toast.warning(text);
      setNow(Date.now());
      if (viewRef.current.kind === 'ready') {
        setView((current) =>
          current.kind === 'ready' ? { kind: 'ready', data: withRun(current.data, run) } : current,
        );
      } else {
        // Without the history and heartbeats on screen, reload everything (includes this run).
        void load();
      }
    } catch (error) {
      const message = failureMessage(
        error,
        'Il controllo non è riuscito. Riprova tra qualche minuto.',
      );
      setAnnouncement(`Controllo non avviato. ${message}`);
      toast.error(message);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  return (
    <AppSurface className="bg-transparent">
      <PageHeader
        title="Monitoraggio"
        description="Controlli automatici di database, accesso, ricerca e cataloghi musicali. Orari in ora italiana."
        actions={
          <Button
            type="button"
            onClick={() => void runNow()}
            aria-disabled={running || undefined}
            className="aria-disabled:cursor-progress aria-disabled:opacity-70"
          >
            <RefreshCw aria-hidden="true" className={running ? 'motion-safe:animate-spin' : ''} />
            {running ? 'Controllo in corso…' : 'Controlla ora'}
          </Button>
        }
      />
      <output aria-live="polite" className={styles.announcement}>
        {announcement}
      </output>

      {view.kind === 'loading' ? <LoadingState /> : null}
      {view.kind === 'error' ? (
        <ErrorState message={view.message} onRetry={() => void load()} />
      ) : null}
      {view.kind === 'ready' && !view.data.latest ? (
        <EmptyState
          icon={<CircleMinus className="size-6 text-muted-foreground" />}
          title="Nessun controllo ancora: premi Controlla ora"
          description="Il primo controllo prova database, accesso, ricerca e cataloghi musicali in pochi secondi."
        />
      ) : null}
      {view.kind === 'ready' && view.data.latest ? (
        <>
          <OverallStatus run={view.data.latest} now={now} />
          <ChecksPanel run={view.data.latest} />
          <RunHistory history={view.data.history} now={now} />
          <ScheduledJobs heartbeats={view.data.heartbeats} history={view.data.history} now={now} />
        </>
      ) : null}

      <AlertsInfo />
    </AppSurface>
  );
}

function LoadingState() {
  return (
    <div className="grid gap-4">
      <output aria-live="polite" className="block text-sm text-muted-foreground">
        Caricamento dei controlli…
      </output>
      <Skeleton className="h-28 w-full motion-reduce:animate-none" />
      <Skeleton className="h-64 w-full motion-reduce:animate-none" />
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className={styles.error}>
      <CircleX aria-hidden="true" />
      <div className={styles.errorBody}>
        <p className="font-semibold">Non riesco a mostrare i controlli.</p>
        <p className={styles.muted}>{message}</p>
      </div>
      <Button type="button" variant="outline" onClick={onRetry}>
        <RotateCw aria-hidden="true" />
        Riprova
      </Button>
    </div>
  );
}

function OverallStatus({ run, now }: { run: MonitorRun; now: number }) {
  const headingId = useId();
  const Icon = OVERALL_ICONS[run.status];
  const failing = run.results.filter((result) => result.status === 'fail');
  const warnings = run.results.filter((result) => result.status === 'warn');

  return (
    <section aria-labelledby={headingId} className={styles.overall} data-status={run.status}>
      <Icon aria-hidden="true" className={styles.overallIcon} />
      <div className={styles.overallBody}>
        <h2 id={headingId} className={styles.eyebrow}>
          Stato generale
        </h2>
        <p className={styles.overallLabel}>{OVERALL_STATUS_LABELS[run.status]}</p>
        <p className={styles.muted}>
          Ultimo controllo {formatWhen(run.startedAt, now)}, {TRIGGER_TEXT[run.trigger]}, durata{' '}
          {formatMs(run.durationMs)}.
        </p>
        <p className={styles.muted}>{countsText(run)}</p>
        {failing.length > 0 ? (
          <p>
            <strong>Non funzionano:</strong> {checkLabels(failing.map((result) => result.id))}
          </p>
        ) : null}
        {warnings.length > 0 ? (
          <p className={styles.muted}>
            <strong>Avvisi (nessuna email):</strong>{' '}
            {checkLabels(warnings.map((result) => result.id))}
          </p>
        ) : null}
        {isStale(run.startedAt, now) ? (
          <p>L’ultimo controllo ha più di 2 ore: premi “Controlla ora” per aggiornarlo.</p>
        ) : null}
      </div>
    </section>
  );
}

function CheckStatusPill({ status }: { status: CheckDisplayStatus }) {
  const Icon = CHECK_ICONS[status];
  return (
    <span className={styles.pill} data-status={status}>
      <Icon aria-hidden="true" />
      {CHECK_STATUS_TEXT[status]}
    </span>
  );
}

function ChecksPanel({ run }: { run: MonitorRun }) {
  const results = new Map<string, MonitorCheckResult>(
    run.results.map((result) => [result.id, result]),
  );
  return (
    <Panel
      title="Controlli"
      description="«Essenziale»: se non funziona, Solco non è utilizzabile. Le avvertenze indicano servizi non configurati o lenti."
    >
      <ul className={styles.checks}>
        {MONITOR_CHECK_IDS.map((id) => {
          const info = MONITOR_CHECKS[id];
          const result = results.get(id);
          const status: CheckDisplayStatus = result?.status ?? 'missing';
          return (
            <li key={id} className={styles.check} data-status={status} data-check={id}>
              <div className={styles.checkHeader}>
                <div className={styles.checkName}>
                  <h3 className={styles.checkTitle}>{info.label}</h3>
                  {info.critical ? <span className={styles.critical}>Essenziale</span> : null}
                </div>
                <CheckStatusPill status={status} />
              </div>
              <p className={styles.detail}>
                {result?.detail || 'Nessun esito per questo controllo nell’ultima esecuzione.'}
              </p>
              <p className={styles.help}>{info.help}</p>
              {result ? <p className={styles.help}>Tempo: {formatMs(result.ms)}</p> : null}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function RunHistory({ history, now }: { history: MonitorRunSummary[]; now: number }) {
  // The API lists newest first; the strip reads left to right, newest on the right.
  const entries = [...history].reverse();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const found = selectedId ? entries.findIndex((entry) => entry.id === selectedId) : -1;
  const selectedIndex = found >= 0 ? found : entries.length - 1;
  const selected = entries[selectedIndex];
  const problems = history.filter((entry) => entry.status !== 'ok').length;

  const select = (index: number) => {
    const target = Math.max(0, Math.min(entries.length - 1, index));
    const entry = entries[target];
    if (!entry) return;
    setSelectedId(entry.id);
    buttons.current[target]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const moves: Record<string, number> = {
      ArrowLeft: index - 1,
      ArrowUp: index - 1,
      ArrowRight: index + 1,
      ArrowDown: index + 1,
      Home: 0,
      End: entries.length - 1,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(next);
  };

  return (
    <Panel
      title="Storico"
      description={`${entries.length === 1 ? 'Ultimo controllo' : `Ultimi ${entries.length} controlli`}: il più recente è a destra. Tocca una barra per i dettagli.`}
    >
      {entries.length === 0 ? (
        <p className={styles.muted}>Nessun controllo salvato nello storico.</p>
      ) : (
        <>
          <div className={styles.historyFrame}>
            <ol
              className={styles.history}
              aria-label="Storico dei controlli, dal più vecchio al più recente"
            >
              {entries.map((entry, index) => {
                const label = historyEntryLabel(entry, now);
                const isSelected = index === selectedIndex;
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      ref={(element) => {
                        buttons.current[index] = element;
                      }}
                      className={styles.dot}
                      data-status={entry.status}
                      aria-label={label}
                      title={label}
                      aria-pressed={isSelected}
                      tabIndex={isSelected ? 0 : -1}
                      onClick={() => setSelectedId(entry.id)}
                      onKeyDown={(event) => onKeyDown(event, index)}
                    >
                      <span aria-hidden="true" className={styles.mark} />
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
          {selected ? (
            <p className={styles.historyDetail}>
              <strong>Controllo selezionato:</strong> {historyEntryLabel(selected, now)} (
              {TRIGGER_TEXT[selected.trigger]}).
            </p>
          ) : null}
          <p className={`${styles.muted} mt-2`}>
            {problems === 0
              ? `Nessun problema negli ultimi ${entries.length} controlli.`
              : `Problemi in ${problems} degli ultimi ${entries.length} controlli.`}
          </p>
          <ul className={styles.legend} aria-label="Legenda">
            {(['ok', 'degraded', 'down'] as const).map((status) => (
              <li key={status}>
                <span aria-hidden="true" className={styles.legendMark} data-status={status}>
                  <span className={styles.mark} />
                </span>
                {OVERALL_STATUS_LABELS[status]}
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function ScheduledJobs({
  heartbeats,
  history,
  now,
}: {
  heartbeats: MonitorHeartbeat[];
  history: MonitorRunSummary[];
  now: number;
}) {
  const cleanup = heartbeats.find((beat) => beat.name === 'cleanup');
  const others = heartbeats.filter((beat) => !HANDLED_HEARTBEATS.has(beat.name));
  // Two separate jobs: the hourly GitHub runs must not hide a daily Vercel cron that stopped.
  const daily = history.find((entry) => entry.trigger === 'cron');
  const hourly = history.find((entry) => entry.trigger === 'status');
  const notFound = notFoundInHistory(history.length);

  return (
    <Panel title="Lavori automatici">
      <ul className={styles.jobs}>
        <li>
          <strong>Pulizia giornaliera:</strong>{' '}
          {cleanup ? `ultima esecuzione ${formatWhen(cleanup.at, now)}` : 'mai eseguita finora'}
          {cleanup?.detail ? (
            <span className={`${styles.help} block`}>{cleanup.detail}</span>
          ) : null}
        </li>
        <li>
          <strong>Controllo giornaliero (Vercel):</strong>{' '}
          {daily ? `ultima esecuzione ${formatWhen(daily.startedAt, now)}` : notFound}
          {daily && isStale(daily.startedAt, now, DAILY_CRON_LATE_MS) ? (
            <span className="mt-1 flex items-start gap-1.5 text-sm">
              <TriangleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]"
              />
              In ritardo: dovrebbe partire una volta al giorno. Controlla i Cron Job del progetto su
              Vercel.
            </span>
          ) : null}
        </li>
        <li>
          <strong>Controllo orario (GitHub, /api/status):</strong>{' '}
          {hourly ? `ultima esecuzione ${formatWhen(hourly.startedAt, now)}` : notFound}
        </li>
        {others.map((beat) => (
          <li key={beat.name}>
            <strong>{beat.name}:</strong> ultima esecuzione {formatWhen(beat.at, now)}
            {beat.detail ? <span className={`${styles.help} block`}>{beat.detail}</span> : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function AlertsInfo() {
  return (
    <Panel title="Avvisi via email">
      <div className="grid gap-3">
        <p>
          Ogni ora GitHub controlla il sito dall’esterno e ti manda un’email se qualcosa si rompe.
        </p>
        <ul className="grid list-disc gap-1 pl-5 text-sm text-muted-foreground">
          <li>Una volta al giorno apre anche le pagine principali in un browser vero.</li>
          <li>Le avvertenze non mandano email: indicano servizi non configurati o lenti.</li>
          <li>Un problema non ancora risolto viene ricordato una volta al giorno.</li>
        </ul>
        <div>
          <Button asChild variant="outline">
            <a href={GITHUB_MONITOR_URL} target="_blank" rel="noopener noreferrer">
              Apri i controlli su GitHub
              <ExternalLink aria-hidden="true" />
              <span className="sr-only">(si apre in una nuova scheda)</span>
            </a>
          </Button>
        </div>
      </div>
    </Panel>
  );
}
