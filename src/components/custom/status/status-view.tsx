// @polsia:user-owned — pagina di stato pubblica dell'API: legge /api/status e mostra SOLO i
// controlli core (essenziali) dell'API — database, accesso, registrazione — con stato generale
// calcolato su di essi. Le integrazioni esterne non sono incluse. Nessun dato riservato.
// Servita a /stato: pubblica (fuori dal login wall) e spoglia (niente nav/footer del sito), ed è
// la pagina a cui status.solcomusic.online fa redirect — così il sottodominio mostra solo lo stato.
'use client';

import { CircleCheck, CircleHelp, CircleX, RotateCw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import {
  MONITOR_CHECK_IDS,
  type MonitorCheckId,
  type PublicMonitorStatus,
  PublicMonitorStatusSchema,
} from '@/lib/contracts/monitoring';
import { MONITOR_CHECKS, OVERALL_STATUS_LABELS } from '@/lib/monitoring/catalog';

const ENDPOINT = '/api/status';
const REFRESH_MS = 60_000;

// Controlli "core" dell'API: quelli marcati essenziali nel catalogo (se falliscono, l'API non è
// utilizzabile). La pagina pubblica mostra SOLO questi, e lo stato generale è calcolato su di essi,
// così riflette l'API e non le integrazioni esterne (Audius, YouTube, radio, podcast…).
const CORE_CHECK_IDS = MONITOR_CHECK_IDS.filter((id) => MONITOR_CHECKS[id].critical);

type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown';

const OVERALL_TONE: Record<PublicMonitorStatus['status'], string> = {
  ok: 'var(--status-ok, #10b981)',
  degraded: 'var(--status-warning, #f59e0b)',
  down: 'var(--status-down, #ef4444)',
  unknown: 'var(--muted-foreground, #6b7280)',
};

const CHECK_ICON: Record<CheckStatus, typeof CircleCheck> = {
  ok: CircleCheck,
  warn: TriangleAlert,
  fail: CircleX,
  unknown: CircleHelp,
};

const CHECK_COLOR: Record<CheckStatus, string> = {
  ok: 'var(--status-ok, #10b981)',
  warn: 'var(--status-warning, #f59e0b)',
  fail: 'var(--status-down, #ef4444)',
  unknown: 'var(--muted-foreground, #6b7280)',
};

const CHECK_LABEL: Record<CheckStatus, string> = {
  ok: 'Operativo',
  warn: 'Avviso',
  fail: 'Non funziona',
  unknown: 'Sconosciuto',
};

function checkStatusOf(id: MonitorCheckId, data: PublicMonitorStatus): CheckStatus {
  if (data.failing.includes(id)) return 'fail';
  if (data.warnings.includes(id)) return 'warn';
  // Verde solo se il controllo ha davvero girato ed è passato. Un id assente dal giro
  // (es. aggiunto dopo l'ultimo controllo) resta "sconosciuto", mai un falso verde.
  if (data.ok.includes(id)) return 'ok';
  return 'unknown';
}

/** Stato generale calcolato SOLO sui controlli core dell'API (non sulle integrazioni esterne). */
function overallFromCore(data: PublicMonitorStatus): PublicMonitorStatus['status'] {
  if (data.status === 'unknown') return 'unknown';
  if (CORE_CHECK_IDS.some((id) => data.failing.includes(id))) return 'down';
  if (CORE_CHECK_IDS.some((id) => data.warnings.includes(id))) return 'degraded';
  // Se un controllo core non è tra quelli passati, non è stato verificato: stato sconosciuto,
  // non "tutto funziona".
  if (CORE_CHECK_IDS.some((id) => !data.ok.includes(id))) return 'unknown';
  return 'ok';
}

function relativeTime(iso: string | null, now: number): string {
  if (!iso) return 'nessun controllo ancora';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'orario non disponibile';
  const diff = Math.max(0, now - then);
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'pochi secondi fa';
  if (min === 1) return '1 minuto fa';
  if (min < 60) return `${min} minuti fa`;
  const hours = Math.round(min / 60);
  if (hours === 1) return '1 ora fa';
  if (hours < 24) return `${hours} ore fa`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 giorno fa' : `${days} giorni fa`;
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; data: PublicMonitorStatus };

export function StatusView() {
  const [view, setView] = useState<ViewState>({ kind: 'loading' });
  const [now, setNow] = useState(() => Date.now());
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const data = await apiFetch(ENDPOINT, { schema: PublicMonitorStatusSchema });
      if (request !== requestRef.current) return;
      setNow(Date.now());
      setView({ kind: 'ready', data });
    } catch {
      if (request !== requestRef.current) return;
      setView({ kind: 'error' });
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = window.setInterval(() => void load(), REFRESH_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      requestRef.current += 1;
      window.clearInterval(refresh);
      window.clearInterval(tick);
    };
  }, [load]);

  const data = view.kind === 'ready' ? view.data : null;
  const overall = data ? overallFromCore(data) : 'unknown';

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-6">
      <header className="grid gap-2">
        <p className="text-sm font-medium text-muted-foreground">Stato dell’API</p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Stato dell’API Solco
        </h1>
        <p className="text-sm leading-6 text-muted-foreground">
          Stato in tempo quasi reale dei sistemi essenziali dell’API: database, accesso e
          registrazione. Aggiornamento automatico ogni minuto.
        </p>
      </header>

      {view.kind === 'loading' ? (
        <Skeleton className="h-24 w-full motion-reduce:animate-none" />
      ) : null}

      {view.kind === 'error' ? (
        <div
          role="alert"
          className="grid gap-3 rounded-xl border border-border bg-card p-6 text-card-foreground"
        >
          <p className="font-semibold">Non riesco a leggere lo stato in questo momento.</p>
          <p className="text-sm text-muted-foreground">
            Questo può voler dire che il servizio di stato è momentaneamente non raggiungibile.
          </p>
          <div>
            <Button type="button" variant="outline" onClick={() => void load()}>
              <RotateCw aria-hidden="true" />
              Riprova
            </Button>
          </div>
        </div>
      ) : null}

      {data ? (
        <>
          <section
            aria-label="Stato generale"
            className="flex items-center gap-4 rounded-xl border border-border bg-card p-6"
          >
            <span
              aria-hidden="true"
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-full"
              style={{ backgroundColor: OVERALL_TONE[overall], opacity: 0.18 }}
            >
              <span
                className="size-4 rounded-full"
                style={{ backgroundColor: OVERALL_TONE[overall] }}
              />
            </span>
            <div className="grid gap-0.5">
              <p className="text-xl font-semibold text-card-foreground">
                {OVERALL_STATUS_LABELS[overall]}
              </p>
              <p className="text-sm text-muted-foreground">
                Ultimo controllo {relativeTime(data.checkedAt, now)}
                {data.stale ? ' · dati non recenti' : ''}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => void load()}
            >
              <RotateCw aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">Aggiorna</span>
            </Button>
          </section>

          <section aria-label="Controlli" className="grid gap-2">
            <ul className="grid gap-px overflow-hidden rounded-xl border border-border bg-border">
              {CORE_CHECK_IDS.map((id) => {
                const status = checkStatusOf(id, data);
                const Icon = CHECK_ICON[status];
                return (
                  <li
                    key={id}
                    className="flex items-center gap-3 bg-card px-4 py-3"
                    data-status={status}
                  >
                    <Icon
                      aria-hidden="true"
                      className="size-5 shrink-0"
                      style={{ color: CHECK_COLOR[status] }}
                    />
                    <span className="flex-1 text-sm font-medium text-card-foreground">
                      {MONITOR_CHECKS[id].label}
                    </span>
                    <span className="text-sm" style={{ color: CHECK_COLOR[status] }}>
                      {CHECK_LABEL[status]}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted-foreground">
              Sono i controlli essenziali dell’API: se uno non funziona, Solco non è utilizzabile.
              Le integrazioni esterne (ricerca e cataloghi musicali) non sono incluse.
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}
