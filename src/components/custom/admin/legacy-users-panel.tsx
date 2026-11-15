// @polsia:user-owned — pagina /admin/utenti-vecchi: «Controlla i database» legge (solo quando lo
// chiedi) i database indicati dalle variabili d'ambiente e mostra una scheda per ognuno; per un
// database che non è quello in uso: «Anteprima trasferimento» → riepilogo → «Trasferisci N
// account» con conferma → lotti con «Continua» finché non resta nulla. Legge e scrive solo tramite
// /api/admin/legacy-users e /api/admin/legacy-users/import: mai URL, host, email o password.
'use client';

import {
  ArrowRightLeft,
  CircleAlert,
  CircleCheck,
  CircleX,
  Database,
  KeyRound,
  RefreshCw,
  RotateCw,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ZodError } from 'zod';
import { AppSurface } from '@/components/custom/app-ui/app-shell';
import { PageHeader } from '@/components/custom/app-ui/page-header';
import { Panel } from '@/components/custom/app-ui/panel';
import { StatusBadge } from '@/components/custom/app-ui/status-badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api-client';
import { REWARDS } from '@/lib/business/rewards';
import {
  type LegacyBatch,
  type LegacyDbGroup,
  type LegacyErrorKindValue,
  LegacyImportPostResponseSchema,
  type LegacyImportRequest,
  type LegacyPreviewResponse,
  type LegacyStats,
  type LegacyUsersDiagnostic,
  LegacyUsersDiagnosticSchema,
} from '@/lib/contracts/legacy-users';

const CHECK_ENDPOINT = '/api/admin/legacy-users';
const IMPORT_ENDPOINT = '/api/admin/legacy-users/import';
const ERROR_TEXT_MAX = 300;
const STALE_PREVIEW_CODES = new Set(['preview_expired', 'preview_mismatch', 'preview_invalid']);

const numberFormat = new Intl.NumberFormat('it-IT');
const dateFormat = new Intl.DateTimeFormat('it-IT', {
  timeZone: 'Europe/Rome',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function count(value: number) {
  return numberFormat.format(value);
}

function accounts(value: number) {
  return value === 1 ? '1 account' : `${count(value)} account`;
}

const KIND_TEXT: Record<LegacyErrorKindValue, string> = {
  timeout: 'Il database non ha risposto in tempo. Potrebbe essere in pausa: riprova tra poco.',
  auth: 'Utente o password non accettati: la stringa di connessione non è più valida.',
  ssl: 'La connessione cifrata non è riuscita.',
  not_found: 'Il database indicato non esiste (forse è stato cancellato).',
  unreachable: 'Il server del database non è raggiungibile.',
  too_large: 'Ci sono troppi utenti da leggere in una sola volta.',
  unknown: 'Errore imprevisto durante la lettura.',
};

type ErrorCause = { message?: unknown; error?: unknown };

function errorCause(error: unknown): ErrorCause | null {
  return error instanceof Error && typeof error.cause === 'object' && error.cause !== null
    ? (error.cause as ErrorCause)
    : null;
}

/** Messaggio del server quando c'è, altrimenti un testo breve in italiano. */
function failureMessage(error: unknown, fallback: string): string {
  if (error instanceof ZodError) return 'La risposta del server non è nel formato atteso.';
  if (error instanceof TypeError) return 'Connessione non riuscita: controlla la rete e riprova.';
  const message = errorCause(error)?.message;
  if (typeof message === 'string' && message.trim()) {
    return message.trim().slice(0, ERROR_TEXT_MAX);
  }
  return fallback;
}

function isStalePreview(error: unknown): boolean {
  const code = errorCause(error)?.error;
  return typeof code === 'string' && STALE_PREVIEW_CODES.has(code);
}

async function postImport(body: LegacyImportRequest) {
  return apiFetch(IMPORT_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify(body),
    schema: LegacyImportPostResponseSchema,
  });
}

type CheckState = {
  data: LegacyUsersDiagnostic | null;
  loading: boolean;
  error: string | null;
};

export function LegacyUsersPanel() {
  const [state, setState] = useState<CheckState>({ data: null, loading: false, error: null });
  const [announcement, setAnnouncement] = useState('');
  const loadingRef = useRef(false);

  const runCheck = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setState((current) => ({ ...current, loading: true, error: null }));
    setAnnouncement('Controllo dei database in corso…');
    try {
      const data = await apiFetch(CHECK_ENDPOINT, { schema: LegacyUsersDiagnosticSchema });
      setState({ data, loading: false, error: null });
      setAnnouncement(
        data.groups.length === 1
          ? 'Trovato 1 database.'
          : `Trovati ${data.groups.length} database.`,
      );
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: failureMessage(error, 'Il controllo dei database non è riuscito. Riprova.'),
      }));
      setAnnouncement('Controllo non riuscito.');
    } finally {
      loadingRef.current = false;
    }
  }, []);

  const { data, loading, error } = state;
  const others = data?.groups.filter((group) => !group.current) ?? [];

  return (
    <AppSurface className="bg-transparent">
      <PageHeader
        title="Utenti del vecchio sito"
        description="Trova il database del vecchio Solco e copia qui i suoi account: stessa email e, quando possibile, stessa password. Nessun account esistente viene modificato."
        actions={
          <Button
            type="button"
            onClick={() => void runCheck()}
            aria-disabled={loading || undefined}
            className="aria-disabled:cursor-progress aria-disabled:opacity-70"
          >
            <RefreshCw aria-hidden="true" className={loading ? 'motion-safe:animate-spin' : ''} />
            {loading ? 'Controllo in corso…' : 'Controlla i database'}
          </Button>
        }
      />
      <output aria-live="polite" className="sr-only">
        {announcement}
      </output>

      <HowItWorks />

      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-start gap-3 rounded-lg border border-destructive/40 p-4"
        >
          <CircleX aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Non riesco a controllare i database.</p>
            <p className="text-sm text-muted-foreground">{error}</p>
          </div>
          <Button type="button" variant="outline" onClick={() => void runCheck()}>
            <RotateCw aria-hidden="true" />
            Riprova
          </Button>
        </div>
      ) : null}

      {loading && !data ? (
        <div className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            Mi collego ai database in sola lettura: può richiedere fino a mezzo minuto…
          </p>
          <Skeleton className="h-40 w-full motion-reduce:animate-none" />
          <Skeleton className="h-40 w-full motion-reduce:animate-none" />
        </div>
      ) : null}

      {!data && !loading && !error ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          Premi «Controlla i database»: leggo solo i database indicati dalle variabili d’ambiente di
          Vercel, senza modificare nulla.
        </p>
      ) : null}

      {data ? (
        <section aria-label="Database trovati" className="grid gap-4">
          {!data.currentDetected ? (
            <Notice>
              Non riesco a riconoscere il database in uso (DATABASE_URL): controlla con attenzione
              quale scheda è il vecchio sito prima di trasferire.
            </Notice>
          ) : null}
          {data.skippedVars.length > 0 ? (
            <Notice>
              Variabili ignorate perché non leggibili come database Postgres:{' '}
              {data.skippedVars.map((item) => item.name).join(', ')}.
            </Notice>
          ) : null}
          {data.groups.map((group) => (
            <LegacyDbCard key={group.source} group={group} onDone={() => void runCheck()} />
          ))}
          {others.length === 0 ? (
            <Notice>
              Ho trovato solo il database in uso: il database del vecchio sito non è tra le
              variabili d’ambiente. Leggi qui sotto come aggiungerlo.
            </Notice>
          ) : null}
        </section>
      ) : null}

      <AddOldDatabaseHelp />
    </AppSurface>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border p-3 text-sm">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span>{children}</span>
    </p>
  );
}

function HowItWorks() {
  return (
    <Panel
      title="Come funziona"
      description="Prima un controllo, poi un’anteprima, infine il trasferimento che confermi tu."
    >
      <ul className="grid list-disc gap-1 pl-5 text-sm">
        <li>
          Copio solo gli account (utenti e modo di accesso): playlist e altri dati restano lì.
        </li>
        <li>Se un’email esiste già qui, quell’account viene saltato: niente doppioni.</li>
        <li>
          Le password nel formato di Solco funzionano come prima; chi ha una password diversa userà
          «Password dimenticata».
        </li>
        <li>
          Nessuno diventa amministratore: chi lo era nel vecchio sito qui è un utente normale. Le
          email a cui il sito dà da solo il ruolo di amministratore non vengono copiate.
        </li>
        <li>
          Ogni account conserva la sua data d’iscrizione: i più vecchi possono entrare tra i primi{' '}
          {REWARDS.founderLimit} «Fondatori» e ricevere {REWARDS.founderDays} giorni di Premium
          quando ascoltano musica.
        </li>
        <li>I nuovi account contano subito anche nel contatore iscritti della landing.</li>
      </ul>
    </Panel>
  );
}

function AddOldDatabaseHelp() {
  return (
    <Panel
      title="Il database del vecchio sito non è in elenco?"
      description="Va aggiunto come variabile d’ambiente su Vercel, mai incollato qui o in chat."
    >
      <ol className="grid list-decimal gap-1 pl-5 text-sm">
        <li>
          Recupera la stringa di connessione del database del vecchio sito (inizia con
          «postgresql://»).
        </li>
        <li>
          Su Vercel apri il progetto → <strong>Settings</strong> →{' '}
          <strong>Environment Variables</strong>.
        </li>
        <li>
          Aggiungi <code>OLD_DATABASE_URL</code> con quella stringa, ambiente{' '}
          <strong>Production</strong>, e attiva <strong>Sensitive</strong>.
        </li>
        <li>Fai un nuovo deploy (Redeploy), poi torna qui e premi «Controlla i database».</li>
      </ol>
      <p className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
        <KeyRound aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>
          La stringa contiene la password del database: non incollarla mai in chat, in un messaggio
          o in questa pagina.
        </span>
      </p>
    </Panel>
  );
}

const STATUS_BADGE: Record<
  LegacyDbGroup['status'],
  { label: string; tone: 'neutral' | 'positive' | 'warning' | 'critical' | 'info' }
> = {
  current: { label: 'In uso', tone: 'info' },
  ready: { label: 'Raggiungibile', tone: 'positive' },
  incomplete: { label: 'Incompleto', tone: 'warning' },
  error: { label: 'Non raggiungibile', tone: 'critical' },
  incompatible: { label: 'Non compatibile', tone: 'warning' },
};

function LegacyDbCard({ group, onDone }: { group: LegacyDbGroup; onDone: () => void }) {
  const badge = STATUS_BADGE[group.status];
  return (
    <article
      className="grid gap-3 rounded-lg border p-4"
      data-source={group.source}
      data-status={group.status}
    >
      <header className="flex flex-wrap items-center gap-2">
        <Database aria-hidden="true" className="size-5 text-muted-foreground" />
        <h2 className="text-base font-semibold">{group.providerHint}</h2>
        <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
      </header>
      <p className="text-sm text-muted-foreground">
        Variabili:{' '}
        {group.envVars.map((name, index) => (
          <span key={name}>
            {index > 0 ? ', ' : null}
            <code className="text-foreground">{name}</code>
          </span>
        ))}
      </p>
      <CardBody group={group} />
      {group.otherTables.length > 0 ? <OtherTables group={group} /> : null}
      {group.status === 'ready' && group.stats && group.stats.importable > 0 && !group.current ? (
        <TransferFlow source={group.source} onDone={onDone} />
      ) : null}
    </article>
  );
}

function CardBody({ group }: { group: LegacyDbGroup }) {
  switch (group.status) {
    case 'current':
      return (
        <p className="text-sm">
          È il database che il sito usa adesso
          {group.currentUsers !== null ? ` (${accounts(group.currentUsers)})` : ''}. Da qui non si
          trasferisce nulla.
        </p>
      );
    case 'incomplete':
      return (
        <p className="text-sm">
          Manca la password
          {group.incompleteVars.length > 0 ? ` (${group.incompleteVars.join(', ')})` : ''}: non
          posso collegarmi e non invento credenziali. Se è il vecchio database, aggiungi la sua
          stringa di connessione completa come <code>OLD_DATABASE_URL</code>.
        </p>
      );
    case 'error':
      return <p className="text-sm">{KIND_TEXT[group.errorKind ?? 'unknown']}</p>;
    case 'incompatible':
      return (
        <p className="text-sm">
          Non ci sono le tabelle utenti di Solco («user» e «account»).
          {group.otherUsersTable
            ? ` C’è una tabella utenti diversa («${group.otherUsersTable}»): non si può trasferire automaticamente.`
            : ''}
        </p>
      );
    case 'ready':
      return group.stats ? <StatsList stats={group.stats} /> : null;
  }
}

function StatsList({ stats }: { stats: LegacyStats }) {
  const range =
    stats.oldestAt && stats.newestAt
      ? `dal ${dateFormat.format(new Date(stats.oldestAt))} al ${dateFormat.format(new Date(stats.newestAt))}`
      : null;
  const rows: Array<[string, string]> = [
    ['Utenti', `${count(stats.users)}${range ? ` · iscritti ${range}` : ''}`],
    ['Verificati', count(stats.verified)],
    ['Già presenti qui', count(stats.alreadyPresent + stats.duplicateInSource)],
    ['Già trasferiti', count(stats.alreadyImported)],
    ['Trasferibili', count(stats.importable)],
    ['Password compatibili', count(stats.passwordCompatible)],
    ['Da reimpostare con «Password dimenticata»', count(stats.needsPasswordReset)],
    ['Entrano con Google o Apple', count(stats.oauthOnly)],
    ['Entrano col telefono', count(stats.phoneOnly)],
    ['Admin che diventeranno utenti normali', count(stats.adminsToDemote)],
    ['Bloccati (restano bloccati)', count(stats.banned)],
    ['Email non valide (saltate)', count(stats.invalidEmail)],
  ];
  if (stats.reservedAdmin > 0) {
    rows.push(['Da gestire a mano (email da amministratore)', count(stats.reservedAdmin)]);
  }
  return (
    <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3 border-b py-1" data-stat={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="font-medium tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function OtherTables({ group }: { group: LegacyDbGroup }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer">
        Altre tabelle ({group.otherTables.length}) — solo informazione, non vengono trasferite
      </summary>
      <ul className="mt-2 grid gap-1 pl-5">
        {group.otherTables.map((table) => (
          <li key={table.name}>
            <code>{table.name}</code>:{' '}
            {table.rows === null
              ? 'righe sconosciute'
              : `${group.otherTablesApproximate ? 'circa ' : ''}${count(table.rows)} righe`}
          </li>
        ))}
      </ul>
    </details>
  );
}

type Flow = {
  preview: LegacyPreviewResponse | null;
  batch: LegacyBatch | null;
  importedNow: number;
  busy: 'preview' | 'import' | null;
  error: string | null;
};

const IDLE_FLOW: Flow = { preview: null, batch: null, importedNow: 0, busy: null, error: null };

function TransferFlow({ source, onDone }: { source: string; onDone: () => void }) {
  const [flow, setFlow] = useState<Flow>(IDLE_FLOW);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const busyRef = useRef(false);
  // Account creati in questa sessione (tra un «Continua» e l'altro): un ref, così il messaggio
  // finale non dipende da quando React applica l'aggiornamento dello stato.
  const importedRef = useRef(0);
  // Ogni anteprima o «Annulla» apre un nuovo giro: la risposta tardiva di un giro chiuso non
  // viene applicata (niente «Continua» senza un'anteprima valida).
  const runRef = useRef(0);
  // Senza un Trigger Radix non sa dove riportare il fuoco quando la conferma si chiude.
  const confirmedRef = useRef(false);
  const transferButtonRef = useRef<HTMLButtonElement>(null);
  const progressHeadingRef = useRef<HTMLHeadingElement>(null);
  const progressHeadingId = useId();

  const runPreview = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    runRef.current += 1;
    const run = runRef.current;
    importedRef.current = 0;
    setFlow({ ...IDLE_FLOW, busy: 'preview' });
    try {
      const result = await postImport({ action: 'preview', source });
      if (result.action !== 'preview') throw new Error('Risposta inattesa');
      if (run === runRef.current) setFlow({ ...IDLE_FLOW, preview: result });
    } catch (error) {
      if (run === runRef.current) {
        setFlow({
          ...IDLE_FLOW,
          error: failureMessage(error, 'Anteprima non riuscita. Riprova.'),
        });
      }
    } finally {
      busyRef.current = false;
    }
  };

  const cancelPreview = () => {
    // Durante un lotto non si annulla: il server sta già creando gli account.
    if (busyRef.current) return;
    runRef.current += 1;
    setFlow(IDLE_FLOW);
  };

  const runBatch = async () => {
    const preview = flow.preview;
    const token = preview?.previewToken;
    if (busyRef.current || !preview || !token) return;
    busyRef.current = true;
    const run = runRef.current;
    setFlow((current) => ({ ...current, busy: 'import', error: null }));
    try {
      const result = await postImport({ action: 'import', source, previewToken: token });
      if (result.action !== 'import') throw new Error('Risposta inattesa');
      const { batch } = result;
      importedRef.current += batch.imported;
      const importedNow = importedRef.current;
      if (run === runRef.current) {
        // Il lotto resta legato all'anteprima con cui è partito.
        setFlow((current) => ({ ...current, preview, batch, importedNow, busy: null }));
      }
      if (batch.done) toast.success(`Trasferimento completato: ${accounts(importedNow)} creati.`);
    } catch (error) {
      const message = failureMessage(error, 'Trasferimento non riuscito. Riprova con «Continua».');
      if (run === runRef.current) {
        if (isStalePreview(error)) {
          // Anteprima scaduta o superata: si rifà, i lotti già trasferiti restano.
          runRef.current += 1;
          setFlow((current) => ({
            ...IDLE_FLOW,
            importedNow: current.importedNow,
            error: message,
          }));
        } else {
          setFlow((current) => ({ ...current, busy: null, error: message }));
        }
      }
      toast.error(message);
    } finally {
      busyRef.current = false;
    }
  };

  const { preview, batch, busy, error } = flow;
  const stats = preview?.stats;
  const total = stats?.importable ?? 0;
  const processed = batch ? Math.max(0, total - batch.remaining) : 0;
  const transferring = busy === 'import';
  const done = batch?.done === true;

  // Quando l'ultimo lotto finisce, «Continua» sparisce: se il fuoco era lì, resta nella scheda.
  useEffect(() => {
    if (!done) return;
    const active = document.activeElement;
    if (active === null || active === document.body) progressHeadingRef.current?.focus();
  }, [done]);

  return (
    <div className="grid gap-3 border-t pt-3">
      {error ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <CircleX aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}

      {!preview ? (
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void runPreview()}
            aria-disabled={busy !== null || undefined}
            className="aria-disabled:cursor-progress aria-disabled:opacity-70"
          >
            <ArrowRightLeft aria-hidden="true" />
            {busy === 'preview' ? 'Preparo l’anteprima…' : 'Anteprima trasferimento'}
          </Button>
        </div>
      ) : null}

      {preview && stats && !batch && !transferring ? (
        <section aria-label="Anteprima del trasferimento" className="grid gap-2 text-sm">
          <h3 className="font-semibold">Anteprima</h3>
          {stats.importable === 0 || !preview.previewToken ? (
            <p>Niente da trasferire: tutti gli account sono già presenti qui.</p>
          ) : (
            <>
              <ul className="grid list-disc gap-1 pl-5">
                <li>{accounts(stats.importable)} verranno creati.</li>
                <li>{count(stats.passwordCompatible)} entreranno con la stessa password.</li>
                <li>
                  {count(stats.needsPasswordReset)} dovranno usare «Password dimenticata» (password
                  in un formato diverso o assente).
                </li>
                {stats.oauthOnly > 0 ? (
                  <li>{count(stats.oauthOnly)} entreranno con Google o Apple.</li>
                ) : null}
                {stats.phoneOnly > 0 ? (
                  <li>{count(stats.phoneOnly)} entreranno col numero di telefono.</li>
                ) : null}
                {stats.adminsToDemote > 0 ? (
                  <li>{count(stats.adminsToDemote)} erano admin: qui saranno utenti normali.</li>
                ) : null}
                <li>
                  {count(stats.alreadyPresent + stats.duplicateInSource)} saltati perché l’email
                  esiste già.
                </li>
                {stats.reservedAdmin > 0 ? (
                  <li>
                    {stats.reservedAdmin === 1
                      ? '1 account non copiato'
                      : `${count(stats.reservedAdmin)} account non copiati`}
                    : email a cui il sito dà da solo il ruolo di amministratore. Chi ne è titolare
                    si iscrive qui direttamente.
                  </li>
                ) : null}
                <li>
                  Conservano la data d’iscrizione del vecchio sito: i più vecchi possono entrare tra
                  i primi {REWARDS.founderLimit} «Fondatori» e ricevere {REWARDS.founderDays} giorni
                  di Premium quando ascoltano musica, anche se qui quei posti sono già assegnati.
                </li>
              </ul>
              <p className="text-muted-foreground">
                L’anteprima vale 15 minuti. Il trasferimento procede a lotti di {preview.batchSize}{' '}
                account.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button ref={transferButtonRef} type="button" onClick={() => setConfirmOpen(true)}>
                  Trasferisci {accounts(stats.importable)}
                </Button>
                <Button type="button" variant="outline" onClick={cancelPreview}>
                  Annulla
                </Button>
              </div>
            </>
          )}
        </section>
      ) : null}

      {preview && (batch || transferring) ? (
        <section aria-labelledby={progressHeadingId} className="grid gap-2 text-sm">
          <h3
            id={progressHeadingId}
            ref={progressHeadingRef}
            tabIndex={-1}
            className="font-semibold focus:outline-none"
          >
            Avanzamento del trasferimento
          </h3>
          {batch ? (
            <Progress
              value={total > 0 ? Math.round((processed / total) * 100) : 100}
              aria-label="Account trasferiti"
            />
          ) : null}
          <output aria-live="polite" className="grid gap-2">
            {!batch ? (
              <span className="text-muted-foreground">Trasferimento del primo lotto…</span>
            ) : batch.done ? (
              <span className="flex items-start gap-2">
                <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>
                  Fatto: {accounts(flow.importedNow)} creati in questa sessione (
                  {count(batch.totalImported)} in tutto da questo database). Contano già nel
                  contatore iscritti della landing.
                </span>
              </span>
            ) : (
              <span>
                {`Trasferiti ${count(processed)} di ${count(total)}: ne restano ${count(batch.remaining)}.`}
              </span>
            )}
            {batch && batch.conflicts > 0 ? (
              <span className="text-muted-foreground">
                {accounts(batch.conflicts)} saltati in questo lotto: l’email è comparsa qui nel
                frattempo.
              </span>
            ) : null}
          </output>
          {batch && !batch.done && preview.previewToken ? (
            <div>
              <Button
                type="button"
                onClick={() => void runBatch()}
                aria-disabled={busy !== null || undefined}
                className="aria-disabled:cursor-progress aria-disabled:opacity-70"
              >
                {transferring ? 'Trasferimento…' : 'Continua'}
              </Button>
            </div>
          ) : null}
          {batch?.done ? (
            <div>
              <Button type="button" variant="outline" onClick={onDone}>
                <RefreshCw aria-hidden="true" />
                Aggiorna i numeri
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            // Annullata: si torna su «Trasferisci»; confermata: sull'avanzamento del trasferimento.
            event.preventDefault();
            const confirmed = confirmedRef.current;
            confirmedRef.current = false;
            const target = confirmed
              ? (progressHeadingRef.current ?? transferButtonRef.current)
              : (transferButtonRef.current ?? progressHeadingRef.current);
            target?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Trasferire {accounts(total)}?</AlertDialogTitle>
            <AlertDialogDescription>
              Verranno creati nel database del sito. Gli account già presenti non vengono toccati e
              nessuno riceve email. Per annullare dovrai cancellare gli account a mano.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                confirmedRef.current = true;
                void runBatch();
              }}
            >
              Trasferisci
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
