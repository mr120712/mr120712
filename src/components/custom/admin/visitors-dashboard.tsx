// @polsia:user-owned — pagina /admin/visitatori: visitatori distinti e pagine aperte di oggi, degli
// ultimi 7 e 30 giorni, grafico a barre dei visitatori per giorno (con tabella per i lettori di
// schermo), pagine più viste, Paesi, siti di provenienza e dispositivi. Legge solo
// /api/admin/visitors: numeri aggregati, nessun indirizzo IP, nessuna impronta.
'use client';

import { BarChart3, CircleX, RefreshCw, RotateCw, Table2 } from 'lucide-react';
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
  type AdminVisitors,
  AdminVisitorsSchema,
  VISITORS_TIME_ZONE,
  type VisitDevice,
  type VisitorDay,
} from '@/lib/contracts/admin-visitors';
import styles from './visitors-dashboard.module.css';

const ENDPOINT = '/api/admin/visitors';
const ERROR_TEXT_MAX = 300;

const ERROR_CODE_TEXT: Record<string, string> = {
  unauthorized: 'La sessione è scaduta: accedi di nuovo.',
  forbidden: 'Serve un account amministratore con email verificata.',
  session_unavailable: 'Non riesco a verificare la sessione in questo momento. Riprova tra poco.',
};

const DEVICE_TEXT: Record<VisitDevice, string> = {
  desktop: 'Computer',
  mobile: 'Telefono',
  tablet: 'Tablet',
};

const numberFormat = new Intl.NumberFormat('it-IT');
const ratioFormat = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });
const timeFormat = new Intl.DateTimeFormat('it-IT', {
  timeZone: VISITORS_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
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

/** Nomi dei Paesi in italiano dal codice ISO; se il browser non li conosce resta il codice. */
const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['it'], { type: 'region' });
  } catch {
    return null;
  }
})();

function dayDate(key: string) {
  return new Date(`${key}T12:00:00Z`);
}

function formatCount(value: number) {
  return numberFormat.format(value);
}

function formatUpdatedTime(iso: string) {
  return timeFormat.format(new Date(iso));
}

export function countryName(code: string) {
  if (!code) return 'Paese sconosciuto';
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

function pageLabel(path: string) {
  return path === '/' ? 'Home (/)' : path;
}

function visitorsText(count: number) {
  return count === 1 ? '1 visitatore' : `${formatCount(count)} visitatori`;
}

function viewsText(count: number) {
  return count === 1 ? '1 pagina aperta' : `${formatCount(count)} pagine aperte`;
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
  return 'I dati sui visitatori non sono disponibili. Riprova.';
}

type State = { data: AdminVisitors | null; loading: boolean; error: string | null };

export function VisitorsDashboard() {
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
      const data = await apiFetch(ENDPOINT, { schema: AdminVisitorsSchema });
      if (request !== requestRef.current) return;
      setState({ data, loading: false, error: null });
      if (announce) setAnnouncement(`Dati aggiornati alle ${formatUpdatedTime(data.generatedAt)}.`);
    } catch (error) {
      if (request !== requestRef.current) return;
      setState((current) => ({ ...current, loading: false, error: failureMessage(error) }));
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
        title="Visitatori"
        description="Visite alle pagine di Solco contate senza cookie: visitatori distinti per giorno e pagine aperte. Solo numeri aggregati, nessun indirizzo IP. Giorni e orari in ora italiana."
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
      {data && data.last30d.views === 0 ? (
        <EmptyState
          icon={<BarChart3 className="size-6 text-muted-foreground" />}
          title="Ancora nessuna visita registrata"
          description="Il conteggio parte da quando questa funzione è online: appena qualcuno apre una pagina, qui compaiono visitatori e pagine aperte."
        />
      ) : null}
      {data && data.last30d.views > 0 ? (
        <>
          <VisitorTiles data={data} />
          <DailyChart daily={data.daily} />
          <div className={styles.columns}>
            <PagesPanel data={data} />
            <CountriesPanel data={data} />
            <ReferrersPanel data={data} />
            <DevicesPanel data={data} />
          </div>
          <MethodNote retentionDays={data.retentionDays} />
        </>
      ) : null}
      {data && data.last30d.views === 0 ? <MethodNote retentionDays={data.retentionDays} /> : null}
    </AppSurface>
  );
}

function LoadingState() {
  return (
    <div className="grid gap-4">
      <output aria-live="polite" className="block text-sm text-muted-foreground">
        Caricamento dei dati sui visitatori…
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
          {stale ? 'Aggiornamento non riuscito.' : 'Non riesco a mostrare i dati sui visitatori.'}
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

function VisitorTiles({ data }: { data: AdminVisitors }) {
  const perVisitor = data.last30d.visitors > 0 ? data.last30d.views / data.last30d.visitors : null;
  return (
    <MetricGrid label="Visitatori in sintesi">
      <MetricCard
        label="Oggi"
        value={formatCount(data.today.visitors)}
        detail={`${viewsText(data.today.views)} · giornata in corso`}
      />
      <MetricCard
        label="Ultimi 7 giorni"
        value={formatCount(data.last7d.visitors)}
        detail={viewsText(data.last7d.views)}
      />
      <MetricCard
        label="Ultimi 30 giorni"
        value={formatCount(data.last30d.visitors)}
        detail={viewsText(data.last30d.views)}
      />
      <MetricCard
        label="Pagine per visitatore"
        value={perVisitor === null ? '—' : ratioFormat.format(perVisitor)}
        detail="Negli ultimi 30 giorni"
      />
    </MetricGrid>
  );
}

function DailyChart({ daily }: { daily: VisitorDay[] }) {
  // La tabella è sempre leggibile dai lettori di schermo; il pulsante la mostra anche a chi usa
  // il tocco o la tastiera, perché il title delle barre compare solo al passaggio del mouse.
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  const today = daily.at(-1)?.day;
  const first = daily[0]?.day;
  const max = Math.max(1, ...daily.map((entry) => entry.visitors));
  const total = daily.reduce((sum, entry) => sum + entry.visitors, 0);
  const peak = daily.reduce<VisitorDay | null>(
    (best, entry) => (entry.visitors > (best?.visitors ?? 0) ? entry : best),
    null,
  );
  const dayLabel = (key: string) =>
    `${dayLongFormat.format(dayDate(key))}${key === today ? ' (oggi, in corso)' : ''}`;

  return (
    <Panel
      title="Visitatori per giorno"
      description={`Ultimi ${daily.length} giorni di calendario, dal più vecchio a oggi. Ogni persona conta una volta al giorno. La barra a righe è la giornata in corso.`}
    >
      <figure className={styles.chart}>
        <figcaption className={styles.summary}>
          {peak
            ? `${visitorsText(total)} in ${daily.length} giorni. Il giorno con più visitatori: ${dayLongFormat.format(dayDate(peak.day))} (${formatCount(peak.visitors)}).`
            : `Nessun visitatore negli ultimi ${daily.length} giorni.`}
        </figcaption>
        <div className={styles.plot} aria-hidden="true">
          <span className={styles.scale}>{formatCount(max)}</span>
          <div className={styles.bars}>
            {daily.map((entry) => (
              <div
                key={entry.day}
                className={styles.bar}
                data-day={entry.day}
                data-zero={entry.visitors === 0 || undefined}
                data-today={entry.day === today || undefined}
                title={`${dayLabel(entry.day)}: ${visitorsText(entry.visitors)} · ${viewsText(entry.views)}`}
              >
                <span
                  className={styles.fill}
                  style={{ height: `${(entry.visitors / max) * 100}%` }}
                />
              </div>
            ))}
          </div>
        </div>
        <div className={styles.axis} aria-hidden="true">
          <span>{first ? dayShortFormat.format(dayDate(first)) : ''}</span>
          <span>Oggi</span>
        </div>
      </figure>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3"
        aria-expanded={showTable}
        aria-controls={tableId}
        onClick={() => setShowTable((value) => !value)}
      >
        <Table2 aria-hidden="true" />
        {showTable ? 'Nascondi i numeri per giorno' : 'Mostra i numeri per giorno'}
      </Button>
      <table
        id={tableId}
        className={`${styles.table} ${styles.dayTable} ${showTable ? 'mt-3' : 'sr-only'}`}
      >
        <caption>Visitatori e pagine aperte per giorno, in ora italiana</caption>
        <thead>
          <tr>
            <th scope="col">Giorno</th>
            <th scope="col">Visitatori</th>
            <th scope="col">Pagine aperte</th>
          </tr>
        </thead>
        <tbody>
          {daily.map((entry) => (
            <tr key={entry.day}>
              <th scope="row">{dayLabel(entry.day)}</th>
              <td>{formatCount(entry.visitors)}</td>
              <td>{formatCount(entry.views)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function PagesPanel({ data }: { data: AdminVisitors }) {
  return (
    <Panel
      title="Pagine più viste"
      description="Ultimi 30 giorni. I percorsi con un identificativo (playlist, profili, brani condivisi) sono raggruppati con «*»."
    >
      {data.pages.length === 0 ? (
        <p className={styles.muted}>Nessuna pagina aperta negli ultimi 30 giorni.</p>
      ) : (
        <table className={styles.table}>
          <caption className="sr-only">Pagine più viste negli ultimi 30 giorni</caption>
          <thead>
            <tr>
              <th scope="col">Pagina</th>
              <th scope="col">Visitatori</th>
              <th scope="col">Pagine aperte</th>
            </tr>
          </thead>
          <tbody>
            {data.pages.map((page) => (
              <tr key={page.path}>
                <th scope="row">{pageLabel(page.path)}</th>
                <td>{formatCount(page.visitors)}</td>
                <td>{formatCount(page.views)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

/** Classifica con nome, visitatori e una barra proporzionale al primo (decorativa). */
function RankList({
  items,
  label,
}: {
  items: Array<{ key: string; label: string; visitors: number }>;
  label: string;
}) {
  const max = Math.max(1, ...items.map((item) => item.visitors));
  return (
    <ol className={styles.rank} aria-label={label}>
      {items.map((item) => (
        <li key={item.key} className={styles.rankItem}>
          <div className={styles.rankLine}>
            <span className={styles.rankLabel}>{item.label}</span>
            <span className={styles.rankValue}>{formatCount(item.visitors)}</span>
          </div>
          <span className={styles.rankBar} aria-hidden="true">
            <span style={{ width: `${(item.visitors / max) * 100}%` }} />
          </span>
        </li>
      ))}
    </ol>
  );
}

function CountriesPanel({ data }: { data: AdminVisitors }) {
  return (
    <Panel title="Paesi" description="Visitatori per Paese stimato dall’hosting, ultimi 30 giorni.">
      {data.countries.length === 0 ? (
        <p className={styles.muted}>Nessun dato sui Paesi negli ultimi 30 giorni.</p>
      ) : (
        <RankList
          label="Visitatori per Paese"
          items={data.countries.map((entry) => ({
            key: entry.country || 'sconosciuto',
            label: countryName(entry.country),
            visitors: entry.visitors,
          }))}
        />
      )}
    </Panel>
  );
}

function ReferrersPanel({ data }: { data: AdminVisitors }) {
  return (
    <Panel
      title="Da dove arrivano"
      description="Siti di provenienza (solo il nome del sito), ultimi 30 giorni. Gli accessi diretti e quelli da app non compaiono."
    >
      {data.referrers.length === 0 ? (
        <p className={styles.muted}>
          Nessun sito di provenienza negli ultimi 30 giorni: accessi diretti, da app o da browser
          che non lo comunicano.
        </p>
      ) : (
        <RankList
          label="Visitatori per sito di provenienza"
          items={data.referrers.map((entry) => ({
            key: entry.host,
            label: entry.host,
            visitors: entry.visitors,
          }))}
        />
      )}
    </Panel>
  );
}

function DevicesPanel({ data }: { data: AdminVisitors }) {
  return (
    <Panel title="Dispositivi" description="Visitatori per tipo di dispositivo, ultimi 30 giorni.">
      {data.devices.length === 0 ? (
        <p className={styles.muted}>Nessun dato sui dispositivi negli ultimi 30 giorni.</p>
      ) : (
        <RankList
          label="Visitatori per dispositivo"
          items={data.devices.map((entry) => ({
            key: entry.device,
            label: DEVICE_TEXT[entry.device],
            visitors: entry.visitors,
          }))}
        />
      )}
    </Panel>
  );
}

function MethodNote({ retentionDays }: { retentionDays: number }) {
  return (
    <p className={styles.footnote}>
      Conteggio interno senza cookie: per ogni pagina aperta il server salva percorso, Paese
      stimato, dispositivo e sito di provenienza con un’impronta del visitatore che cambia ogni
      giorno e non è riconducibile alla persona; l’indirizzo IP non viene salvato. Robot, il monitor
      automatico e i browser che chiedono di non essere tracciati non contano. Le visite si
      cancellano dopo {retentionDays} giorni.
    </p>
  );
}
