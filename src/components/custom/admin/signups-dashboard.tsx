// @polsia:user-owned — pagina /admin/iscritti: totali degli account, nuovi nelle ultime 24 ore /
// 7 / 30 giorni, verificati, bloccati e grafico a barre delle iscrizioni degli ultimi 30 giorni
// (con tabella per i lettori di schermo). Legge solo /api/admin/signups: numeri aggregati, nessun
// dato personale.
'use client';

import { CircleX, RefreshCw, RotateCw, Table2, Users } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ZodError } from 'zod';
import { AppSurface } from '@/components/custom/app-ui/app-shell';
import { EmptyState } from '@/components/custom/app-ui/empty-state';
import { MetricCard, MetricGrid } from '@/components/custom/app-ui/metrics';
import { PageHeader } from '@/components/custom/app-ui/page-header';
import { Panel } from '@/components/custom/app-ui/panel';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import {
  type AdminSignupDay,
  type AdminSignups,
  AdminSignupsSchema,
  SIGNUPS_TIME_ZONE,
} from '@/lib/contracts/admin-signups';
import styles from './signups-dashboard.module.css';

const ENDPOINT = '/api/admin/signups';
const HOUR_MS = 3_600_000;
const ERROR_TEXT_MAX = 300;

const ERROR_CODE_TEXT: Record<string, string> = {
  unauthorized: 'La sessione è scaduta: accedi di nuovo.',
  forbidden: 'Serve un account amministratore con email verificata.',
  session_unavailable: 'Non riesco a verificare la sessione in questo momento. Riprova tra poco.',
};

const numberFormat = new Intl.NumberFormat('it-IT');
const percentFormat = new Intl.NumberFormat('it-IT', {
  style: 'percent',
  maximumFractionDigits: 1,
});
const timeFormat = new Intl.DateTimeFormat('it-IT', {
  timeZone: SIGNUPS_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
});
const instantDayFormat = new Intl.DateTimeFormat('it-IT', {
  timeZone: SIGNUPS_TIME_ZONE,
  day: 'numeric',
  month: 'short',
});
// Le chiavi sono già giorni di calendario di Roma: formattate a mezzogiorno UTC nessun fuso le sposta.
const dayShortFormat = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
});
const dayLongFormat = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'UTC',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

function dayDate(key: string) {
  return new Date(`${key}T12:00:00Z`);
}

function formatCount(value: number) {
  return numberFormat.format(value);
}

function formatUpdatedTime(iso: string) {
  return timeFormat.format(new Date(iso));
}

/** "dal 13 nov alle 14:05": inizio della finestra mobile, in ora italiana. */
function windowStart(generatedAt: string, hours: number) {
  const start = new Date(new Date(generatedAt).getTime() - hours * HOUR_MS);
  return `dal ${instantDayFormat.format(start)} alle ${timeFormat.format(start)}`;
}

function share(part: number, total: number) {
  return total > 0 ? `${percentFormat.format(part / total)} del totale` : '';
}

function signupsText(count: number) {
  return count === 1 ? '1 iscrizione' : `${formatCount(count)} iscrizioni`;
}

/** Messaggio del server quando c'è, altrimenti un testo breve in italiano. */
function failureMessage(error: unknown): string {
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
  if (typeof code === 'string' && Object.hasOwn(ERROR_CODE_TEXT, code)) {
    return ERROR_CODE_TEXT[code] ?? '';
  }
  return 'I dati sugli iscritti non sono disponibili. Riprova.';
}

type State = { data: AdminSignups | null; loading: boolean; error: string | null };

export function SignupsDashboard() {
  const [state, setState] = useState<State>({ data: null, loading: true, error: null });
  const [announcement, setAnnouncement] = useState('');
  const requestRef = useRef(0);
  const loadingRef = useRef(true);

  const load = useCallback(async (announce: boolean) => {
    const request = ++requestRef.current;
    loadingRef.current = true;
    setState((current) => ({ ...current, loading: true }));
    if (announce) setAnnouncement('Aggiornamento in corso…');
    try {
      const data = await apiFetch(ENDPOINT, { schema: AdminSignupsSchema });
      if (request !== requestRef.current) return;
      setState({ data, loading: false, error: null });
      if (announce) setAnnouncement(`Dati aggiornati alle ${formatUpdatedTime(data.generatedAt)}.`);
    } catch (error) {
      if (request !== requestRef.current) return;
      setState((current) => ({ ...current, loading: false, error: failureMessage(error) }));
      // Il riquadro di errore resta lo stesso se il messaggio non cambia: senza questo annuncio un
      // secondo tentativo fallito non verrebbe comunicato ai lettori di schermo.
      if (announce) setAnnouncement('Aggiornamento non riuscito.');
    } finally {
      if (request === requestRef.current) loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void load(false);
    return () => {
      // Ignora una risposta che arriva dopo l'uscita dalla pagina.
      requestRef.current += 1;
    };
  }, [load]);

  const refresh = () => {
    if (loadingRef.current) return;
    void load(true);
  };

  const { data, loading, error } = state;

  return (
    <AppSurface className="bg-transparent">
      <PageHeader
        title="Iscritti"
        description="Solo numeri aggregati sugli account di Solco: nessun dato personale. Giorni e orari in ora italiana."
        actions={
          <Button
            type="button"
            onClick={refresh}
            aria-disabled={loading || undefined}
            className="aria-disabled:cursor-progress aria-disabled:opacity-70"
          >
            <RefreshCw aria-hidden="true" className={loading ? 'motion-safe:animate-spin' : ''} />
            {loading && data ? 'Aggiornamento…' : 'Aggiorna'}
          </Button>
        }
      />
      <div className={styles.status}>
        {data ? (
          <p>
            Aggiornato alle{' '}
            <time dateTime={data.generatedAt}>{formatUpdatedTime(data.generatedAt)}</time>
          </p>
        ) : null}
        <output aria-live="polite" className={styles.announcement}>
          {announcement}
        </output>
      </div>

      {error ? (
        <ErrorState message={error} stale={data !== null} onRetry={refresh} retrying={loading} />
      ) : null}
      {loading && !data && !error ? <LoadingState /> : null}
      {data && data.totals.total === 0 ? (
        <EmptyState
          icon={<Users className="size-6 text-muted-foreground" />}
          title="Ancora nessun iscritto"
          description="Quando qualcuno crea un account, qui compaiono i totali e l’andamento giorno per giorno."
        />
      ) : null}
      {data && data.totals.total > 0 ? (
        <>
          <SignupTiles data={data} />
          <DailyChart daily={data.daily} />
        </>
      ) : null}
    </AppSurface>
  );
}

function LoadingState() {
  return (
    <div className="grid gap-4">
      <output aria-live="polite" className="block text-sm text-muted-foreground">
        Caricamento dei dati sugli iscritti…
      </output>
      <Skeleton className="h-36 w-full motion-reduce:animate-none" />
      <Skeleton className="h-56 w-full motion-reduce:animate-none" />
    </div>
  );
}

function ErrorState({
  message,
  stale,
  retrying,
  onRetry,
}: {
  message: string;
  stale: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className={styles.error}>
      <CircleX aria-hidden="true" />
      <div className={styles.errorBody}>
        <p className="font-semibold">
          {stale ? 'Aggiornamento non riuscito.' : 'Non riesco a mostrare i dati sugli iscritti.'}
        </p>
        <p className={styles.muted}>{message}</p>
        {stale ? (
          <p className={styles.muted}>I numeri qui sotto sono quelli dell’ultima lettura.</p>
        ) : null}
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={onRetry}
        aria-disabled={retrying || undefined}
        className="aria-disabled:cursor-progress aria-disabled:opacity-70"
      >
        <RotateCw aria-hidden="true" />
        Riprova
      </Button>
    </div>
  );
}

function SignupTiles({ data }: { data: AdminSignups }) {
  const { totals, generatedAt } = data;
  return (
    <MetricGrid label="Iscritti in sintesi">
      <MetricCard
        label="Totale iscritti"
        value={formatCount(totals.total)}
        detail={
          totals.admins === 1
            ? 'di cui 1 amministratore'
            : `di cui ${formatCount(totals.admins)} amministratori`
        }
      />
      <MetricCard
        label="Ultime 24 ore"
        value={formatCount(totals.last24h)}
        detail={windowStart(generatedAt, 24)}
      />
      <MetricCard
        label="Ultimi 7 giorni"
        value={formatCount(totals.last7d)}
        detail={windowStart(generatedAt, 7 * 24)}
      />
      <MetricCard
        label="Ultimi 30 giorni"
        value={formatCount(totals.last30d)}
        detail={windowStart(generatedAt, 30 * 24)}
      />
      <MetricCard
        label="Verificati"
        value={formatCount(totals.verified)}
        detail={`Email o telefono · ${share(totals.verified, totals.total)}`}
      />
      <MetricCard
        label="Bloccati"
        value={formatCount(totals.banned)}
        detail={totals.banned === 0 ? 'Nessun blocco in corso' : share(totals.banned, totals.total)}
      />
    </MetricGrid>
  );
}

function DailyChart({ daily }: { daily: AdminSignupDay[] }) {
  // La tabella è sempre leggibile dai lettori di schermo; il pulsante la mostra anche a chi usa
  // il tocco o la tastiera, perché il title delle barre compare solo al passaggio del mouse.
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  const today = daily.at(-1)?.day;
  const first = daily[0]?.day;
  const max = Math.max(1, ...daily.map((entry) => entry.count));
  const total = daily.reduce((sum, entry) => sum + entry.count, 0);
  const peak = daily.reduce<AdminSignupDay | null>(
    (best, entry) => (entry.count > (best?.count ?? 0) ? entry : best),
    null,
  );
  const dayLabel = (key: string) =>
    `${dayLongFormat.format(dayDate(key))}${key === today ? ' (oggi, in corso)' : ''}`;

  return (
    <Panel
      title="Iscrizioni per giorno"
      description={`Ultimi ${daily.length} giorni di calendario, dal più vecchio a oggi. La barra a righe è la giornata in corso.`}
    >
      <figure className={styles.chart}>
        <figcaption className={styles.summary}>
          {peak
            ? `${signupsText(total)} in ${daily.length} giorni. Il giorno con più iscrizioni: ${dayLongFormat.format(dayDate(peak.day))} (${formatCount(peak.count)}).`
            : `Nessuna nuova iscrizione negli ultimi ${daily.length} giorni.`}
        </figcaption>
        <div className={styles.plot} aria-hidden="true">
          <span className={styles.scale}>{formatCount(max)}</span>
          <div className={styles.bars}>
            {daily.map((entry) => (
              <div
                key={entry.day}
                className={styles.bar}
                data-day={entry.day}
                data-zero={entry.count === 0 || undefined}
                data-today={entry.day === today || undefined}
                title={`${dayLabel(entry.day)}: ${signupsText(entry.count)}`}
              >
                <span className={styles.fill} style={{ height: `${(entry.count / max) * 100}%` }} />
              </div>
            ))}
          </div>
        </div>
        <div className={styles.axis} aria-hidden="true">
          <span>{first ? dayShortFormat.format(dayDate(first)) : ''}</span>
          <span>Oggi</span>
        </div>
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={showTable}
            aria-controls={tableId}
            onClick={() => setShowTable((shown) => !shown)}
            className="aria-pressed:bg-accent aria-pressed:text-accent-foreground"
          >
            <Table2 aria-hidden="true" />
            Mostra i numeri per giorno
          </Button>
        </div>
        <table id={tableId} className={showTable ? styles.table : 'sr-only'}>
          <caption>Iscrizioni per giorno, dal più vecchio a oggi</caption>
          <thead>
            <tr>
              <th scope="col">Giorno</th>
              <th scope="col">Iscrizioni</th>
            </tr>
          </thead>
          <tbody>
            {daily.map((entry) => (
              <tr key={entry.day}>
                <th scope="row">{dayLabel(entry.day)}</th>
                <td>{formatCount(entry.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figure>
    </Panel>
  );
}
