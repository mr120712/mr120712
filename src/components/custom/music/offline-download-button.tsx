// @polsia:user-owned — "Scarica per offline" su una playlist Solco (o in Libreria): scarica nella
// libreria sul dispositivo i soli elementi consentiti, con avanzamento "n di m" e una regione live, e
// mostra con una nota in italiano quelli che restano solo in streaming (YouTube, radio, Jamendo…).
//
// Stati onesti: non hai effettuato l'accesso (il download richiede il login); limite giornaliero o tetto
// di dimensione raggiunti (messaggio dal server); niente di scaricabile in questa playlist (una nota).
// I brani già scaricati non vengono riscaricati (anti-duplicato nello store) e non servono per
// riprodurli offline: il download è l'azione protetta, non l'ascolto.
//
// Lo stesso pulsante serve le pagine dei "brani in evidenza" (cartella /cartella/<id> e artista
// /artista/<slug>): `scope`, `actionLabel` e `onlineOnlyNote` adattano i testi («Scarica la cartella
// per offline», «solo streaming»); il piano lo costruisce featuredDownloadPlan con i soli brani che
// il server dichiara scaricabili.
'use client';

import { CheckCircle2, Download, Info, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  downloadOne,
  featuredCopySaved,
  notifyLocalMusicChanged,
  OFFLINE_LOGIN_REQUIRED_MESSAGE,
  OFFLINE_ONLINE_ONLY_NOTE,
  type OfflineBatchProgress,
  type OfflineBatchResult,
  type OfflineDownloadTarget,
  type OfflinePlan,
  offlineBatchSummary,
  offlineSavedCount,
  resolveDownloadableSongs,
  runOfflineDownloadBatch,
  subscribeLocalMusicChanged,
} from '@/components/custom/music/offline-download';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import styles from './offline-download-button.module.css';

type Phase = 'idle' | 'resolving' | 'running' | 'done';

export function OfflineDownloadButton({
  label,
  plan,
  signedIn,
  onSaved,
  scope = 'questa playlist',
  actionLabel = 'Scarica per offline',
  onlineOnlyNote = OFFLINE_ONLINE_ONLY_NOTE,
}: {
  /** Nome della playlist/sezione, per le etichette accessibili. */
  label: string;
  plan: OfflinePlan;
  /** false: il download richiede il login; si mostra la nota con il link per accedere. */
  signedIn: boolean;
  /** Chiamato dopo che almeno un brano è stato salvato, per aggiornare la Libreria. */
  onSaved?: () => void;
  /** Di che cosa si parla nelle note («questa playlist», «questa cartella», «questo artista»). */
  scope?: string;
  /** Testo del pulsante a riposo (il numero dei brani scaricabili si aggiunge da sé). */
  actionLabel?: string;
  /** Nota sopra l'elenco dei brani che restano solo in streaming. */
  onlineOnlyNote?: string;
}) {
  const { downloadable, onlineOnly, resolvable } = plan;
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<OfflineBatchProgress | null>(null);
  const [result, setResult] = useState<OfflineBatchResult | null>(null);
  const runningRef = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const idPrefix = useId();
  const onlineOnlyId = `${idPrefix}-online-only`;

  const run = useCallback(async () => {
    if (runningRef.current || (downloadable.length === 0 && resolvable.length === 0)) return;
    runningRef.current = true;
    setResult(null);

    // Prima cerca una versione Audius scaricabile dei brani importati (Spotify/elenco).
    let targets = downloadable;
    if (resolvable.length > 0) {
      setPhase('resolving');
      const resolution = await resolveDownloadableSongs(resolvable);
      targets = [...downloadable, ...resolution.targets];
    }
    if (targets.length === 0) {
      runningRef.current = false;
      setProgress(null);
      setResult({
        stopped: null,
        stopMessage: null,
        saved: [],
        already: [],
        onlineOnly: [],
        failed: [],
      });
      setPhase('done');
      toast.error('Nessuna versione scaricabile trovata per i brani importati.');
      buttonRef.current?.focus();
      return;
    }

    setPhase('running');
    setProgress({ processed: 0, total: targets.length, title: '' });
    const outcome = await runOfflineDownloadBatch(targets, {
      onProgress: (value) => setProgress(value),
    });
    runningRef.current = false;
    setProgress(null);
    setResult(outcome);
    setPhase('done');
    const summary = offlineBatchSummary(outcome);
    if (summary.tone === 'success') toast.success(summary.message);
    else toast.error(summary.message);
    if (offlineSavedCount(outcome) > 0) {
      // La sezione "La tua musica" rilegge l'elenco anche se è in un'altra parte della pagina.
      notifyLocalMusicChanged();
      onSaved?.();
    }
    // Il focus resta sul pulsante (non si smonta): l'ascoltatore può scaricare di nuovo.
    buttonRef.current?.focus();
  }, [downloadable, resolvable, onSaved]);

  // Niente da scaricare né da cercare: una nota chiara, più l'elenco di cosa resta online.
  if (downloadable.length === 0 && resolvable.length === 0) {
    if (onlineOnly.length === 0) return null;
    return (
      <div className={styles.wrap}>
        <p className={styles.note}>
          <Info aria-hidden="true" />
          <span>Nessun brano di {scope} si può scaricare per l’ascolto offline.</span>
        </p>
        <OnlineOnlyList id={onlineOnlyId} items={onlineOnly} note={onlineOnlyNote} />
      </div>
    );
  }

  const running = phase === 'running';
  const resolving = phase === 'resolving';
  const busy = running || resolving || undefined;
  const count = downloadable.length;
  const buttonText = resolving
    ? 'Cerco versioni scaricabili…'
    : running
      ? 'Scarico…'
      : phase === 'done'
        ? 'Scarica di nuovo'
        : resolvable.length > 0
          ? actionLabel
          : `${actionLabel} (${count})`;

  return (
    <div className={styles.wrap}>
      <div className={styles.actionRow}>
        {signedIn ? (
          <Button
            ref={buttonRef}
            type="button"
            variant="outline"
            size="sm"
            className={styles.button}
            aria-busy={busy}
            aria-disabled={busy}
            aria-describedby={onlineOnly.length > 0 ? onlineOnlyId : undefined}
            // Il nome accessibile COMINCIA con il testo visibile (WCAG 2.5.3): chi usa la voce può
            // dire quello che vede; il resto dice di quale playlist/cartella/artista si parla.
            aria-label={`${buttonText}: i brani consentiti di ${label}`}
            onClick={() => {
              if (!busy) void run();
            }}
          >
            <Download aria-hidden="true" />
            {buttonText}
          </Button>
        ) : (
          <p className={styles.note}>
            <Info aria-hidden="true" />
            <span>
              <Link href="/login">Accedi</Link> per scaricare i brani consentiti di {scope} e
              ascoltarli offline.
            </span>
          </p>
        )}
      </div>

      {/* Avanzamento "n di m": visibile e annunciato con parsimonia dalla regione live. */}
      <div className={running ? styles.progress : 'sr-only'}>
        <p className={styles.progressText}>
          {progress ? `Scarico ${progress.processed} di ${progress.total}` : ''}
          {progress?.title ? `: ${progress.title}` : ''}
        </p>
        <output aria-live="polite" className="sr-only">
          {progress ? `Scarico ${progress.processed} di ${progress.total}.` : ''}
        </output>
        {progress ? (
          <Progress
            value={progress.total > 0 ? (progress.processed / progress.total) * 100 : 0}
            aria-label="Avanzamento dello scaricamento"
            aria-valuetext={`${progress.processed} di ${progress.total}`}
            className={styles.progressBar}
          />
        ) : null}
      </div>

      {phase === 'done' && result ? <BatchSummary result={result} /> : null}

      {resolvable.length > 0 && phase === 'idle' ? (
        <p className={styles.note}>
          <Info aria-hidden="true" />
          <span>
            {resolvable.length === 1
              ? '1 brano importato: al download cerco una versione scaricabile su Audius (non sempre disponibile; niente audio da Spotify).'
              : `${resolvable.length} brani importati: al download cerco una versione scaricabile su Audius (non sempre disponibile; niente audio da Spotify).`}
          </span>
        </p>
      ) : null}

      {onlineOnly.length > 0 ? (
        <OnlineOnlyList id={onlineOnlyId} items={onlineOnly} note={onlineOnlyNote} />
      ) : null}
    </div>
  );
}

function BatchSummary({ result }: { result: OfflineBatchResult }) {
  const saved = offlineSavedCount(result);
  const onlineOnly = result.onlineOnly;
  return (
    <output className={styles.summary}>
      {result.stopped === 'login-required' || result.stopped === 'limit-reached' ? (
        <p className={styles.summaryError}>
          <Info aria-hidden="true" />
          <span>{result.stopMessage ?? 'Scaricamento interrotto.'}</span>
        </p>
      ) : (
        <p className={styles.summaryOk}>
          <CheckCircle2 aria-hidden="true" />
          <span>
            {saved === 0
              ? onlineOnly.length > 0
                ? 'Nessun brano scaricato: i brani qui sotto restano solo in streaming.'
                : 'Nessun brano scaricato.'
              : saved === 1
                ? '1 brano disponibile offline nella tua Libreria.'
                : `${saved} brani disponibili offline nella tua Libreria.`}
          </span>
        </p>
      )}
      {result.failed.length > 0 ? (
        <ul className={styles.failedList}>
          {result.failed.map(({ target, message }) => (
            <li key={target.id}>
              <strong>{target.title}</strong> — {message}
            </li>
          ))}
        </ul>
      ) : null}
      {/* Brani che il server ha riportato tra i soli-streaming durante il lotto (es. un Audius che */}
      {/* l'artista non ha reso scaricabile): si elencano col loro motivo, così nessuno sparisce. */}
      {onlineOnly.length > 0 ? (
        <div className={styles.onlineOnly}>
          <p className={styles.onlineOnlyLead}>
            <Info aria-hidden="true" />
            <span>
              {onlineOnly.length === 1
                ? '1 brano resta solo in streaming: la fonte non ne permette il download.'
                : `${onlineOnly.length} brani restano solo in streaming: la fonte non ne permette il download.`}
            </span>
          </p>
          <ul className={styles.onlineOnlyList}>
            {onlineOnly.map(({ target, reason }) => (
              <li key={target.id}>
                <strong>{target.title}</strong>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </output>
  );
}

/**
 * Pulsante per scaricare UN elemento (es. un episodio podcast). Richiede il login; mostra lo stato
 * (scarico, scaricato, già salvato, resta online) e segnala alla Libreria quando il brano è salvato.
 */
export function SingleOfflineDownloadButton({
  target,
  signedIn,
  size = 'sm',
  variant = 'outline',
  className,
  iconOnly = false,
}: {
  target: OfflineDownloadTarget;
  signedIn: boolean;
  size?: 'sm' | 'default';
  variant?: 'outline' | 'ghost' | 'secondary';
  className?: string;
  /** Solo l'icona (righe e copertine compatte): il nome accessibile resta quello completo. */
  iconOnly?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'running' | 'saved' | 'done'>('idle');
  const runningRef = useRef(false);
  const featuredShareId = target.endpoint.kind === 'featured' ? target.endpoint.shareId : null;

  // Brano in evidenza già salvato su questo dispositivo: il pulsante parte (e torna) «Offline» senza
  // richieste; se la copia sparisce (rimossa, revocata) torna «Scarica». Solo dopo il montaggio
  // (localStorage e IndexedDB non esistono sul server).
  useEffect(() => {
    if (!featuredShareId) return;
    let active = true;
    const check = () => {
      void featuredCopySaved(featuredShareId).then((saved) => {
        if (!active || runningRef.current) return;
        setState((current) => (saved ? 'saved' : current === 'saved' ? 'idle' : current));
      });
    };
    check();
    const unsubscribe = subscribeLocalMusicChanged(check);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [featuredShareId]);

  const run = useCallback(async () => {
    if (runningRef.current) return;
    if (!signedIn) {
      toast.error(OFFLINE_LOGIN_REQUIRED_MESSAGE);
      return;
    }
    runningRef.current = true;
    setState('running');
    const outcome = await downloadOne(target);
    runningRef.current = false;
    if (outcome.status === 'saved' || outcome.status === 'already') {
      setState('saved');
      notifyLocalMusicChanged();
      toast.success(
        outcome.status === 'already'
          ? 'Già nella tua Libreria per l’ascolto offline.'
          : 'Scaricato: disponibile offline nella tua Libreria.',
      );
      return;
    }
    setState('done');
    if (outcome.status === 'online-only') toast.error(outcome.reason);
    else toast.error(outcome.message);
  }, [signedIn, target]);

  const running = state === 'running';
  return (
    <>
      <Button
        type="button"
        variant={state === 'saved' ? 'secondary' : variant}
        size={iconOnly ? 'icon' : size}
        className={className}
        title={
          iconOnly
            ? state === 'saved'
              ? 'Disponibile offline'
              : running
                ? 'Scarico…'
                : 'Scarica offline'
            : undefined
        }
        aria-busy={running || undefined}
        aria-disabled={running || state === 'saved' || undefined}
        aria-label={
          state === 'saved'
            ? `${target.title} è nella tua Libreria per l’ascolto offline`
            : running
              ? `Scarico ${target.title}…`
              : `Scarica ${target.title} per l’ascolto offline`
        }
        onClick={() => {
          if (!running && state !== 'saved') void run();
        }}
      >
        {state === 'saved' ? (
          <CheckCircle2 aria-hidden="true" />
        ) : running ? (
          // Ruota solo senza «riduci movimento»; l'icona cambia comunque.
          <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />
        ) : (
          <Download aria-hidden="true" />
        )}
        {iconOnly ? null : state === 'saved' ? 'Offline' : running ? 'Scarico…' : 'Scarica'}
      </Button>
      {/* L'inizio del download si annuncia subito (il file può richiedere decine di secondi); */}
      {/* la fine la annuncia il toast. */}
      <output className="sr-only" aria-live="polite">
        {running ? `Scarico ${target.title}…` : ''}
      </output>
    </>
  );
}

/** Fino a quanti brani l'elenco dei soli-streaming resta aperto; oltre si apre a richiesta. */
export const ONLINE_ONLY_OPEN_MAX = 5;

function OnlineOnlyList({
  id,
  items,
  note,
}: {
  id: string;
  items: OfflinePlan['onlineOnly'];
  note: string;
}) {
  const count = items.length;
  // Lo stesso motivo per tutti (es. i brani in evidenza senza copia offline): detto una volta sola.
  const shared = items.every((item) => item.reason === items[0]?.reason)
    ? (items[0]?.reason ?? null)
    : null;
  return (
    <div className={styles.onlineOnly}>
      {/* Frase breve (è la descrizione del pulsante): la nota e quanti brani restano online. */}
      <p id={id} className={styles.onlineOnlyLead}>
        <Info aria-hidden="true" />
        <span>
          {note}{' '}
          {count === 1
            ? '(1 brano resta solo in streaming)'
            : `(${count} brani restano solo in streaming)`}
        </span>
      </p>
      <details className={styles.onlineOnlyDetails} open={count <= ONLINE_ONLY_OPEN_MAX}>
        <summary>{count === 1 ? 'Mostra il brano' : `Mostra i ${count} brani`}</summary>
        {shared ? <p className={styles.onlineOnlyReason}>{shared}</p> : null}
        <ul className={styles.onlineOnlyList}>
          {items.map((item) => (
            <li key={item.id}>
              <strong>{item.title}</strong>
              {shared ? null : <span>{item.reason}</span>}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
