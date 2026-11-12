// @polsia:user-owned — "Scarica per offline" su una playlist Solco (o in Libreria): scarica nella
// libreria sul dispositivo i soli elementi consentiti, con avanzamento "n di m" e una regione live, e
// mostra con una nota in italiano quelli che restano solo in streaming (YouTube, radio, Jamendo…).
//
// Stati onesti: non hai effettuato l'accesso (il download richiede il login); limite giornaliero o tetto
// di dimensione raggiunti (messaggio dal server); niente di scaricabile in questa playlist (una nota).
// I brani già scaricati non vengono riscaricati (anti-duplicato nello store) e non servono per
// riprodurli offline: il download è l'azione protetta, non l'ascolto.
'use client';

import { CheckCircle2, Download, Info } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  downloadOne,
  notifyLocalMusicChanged,
  OFFLINE_LOGIN_REQUIRED_MESSAGE,
  OFFLINE_ONLINE_ONLY_NOTE,
  type OfflineBatchProgress,
  type OfflineBatchResult,
  type OfflineDownloadTarget,
  type OfflinePlan,
  offlineBatchSummary,
  offlineSavedCount,
  runOfflineDownloadBatch,
} from '@/components/custom/music/offline-download';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import styles from './offline-download-button.module.css';

type Phase = 'idle' | 'running' | 'done';

export function OfflineDownloadButton({
  label,
  plan,
  signedIn,
  onSaved,
}: {
  /** Nome della playlist/sezione, per le etichette accessibili. */
  label: string;
  plan: OfflinePlan;
  /** false: il download richiede il login; si mostra la nota con il link per accedere. */
  signedIn: boolean;
  /** Chiamato dopo che almeno un brano è stato salvato, per aggiornare la Libreria. */
  onSaved?: () => void;
}) {
  const { downloadable, onlineOnly } = plan;
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<OfflineBatchProgress | null>(null);
  const [result, setResult] = useState<OfflineBatchResult | null>(null);
  const runningRef = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const idPrefix = useId();
  const onlineOnlyId = `${idPrefix}-online-only`;

  const run = useCallback(async () => {
    if (runningRef.current || downloadable.length === 0) return;
    runningRef.current = true;
    setPhase('running');
    setResult(null);
    setProgress({ processed: 0, total: downloadable.length, title: '' });
    const outcome = await runOfflineDownloadBatch(downloadable, {
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
  }, [downloadable, onSaved]);

  // Niente da scaricare in questa playlist: una nota chiara, più l'elenco di cosa resta online.
  if (downloadable.length === 0) {
    if (onlineOnly.length === 0) return null;
    return (
      <div className={styles.wrap}>
        <p className={styles.note}>
          <Info aria-hidden="true" />
          <span>Nessun brano di questa playlist si può scaricare per l’ascolto offline.</span>
        </p>
        <OnlineOnlyList id={onlineOnlyId} items={onlineOnly} />
      </div>
    );
  }

  const running = phase === 'running';
  const busy = running || undefined;
  const count = downloadable.length;

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
            aria-label={`Scarica per l’ascolto offline i brani consentiti di ${label}`}
            onClick={() => {
              if (!running) void run();
            }}
          >
            <Download aria-hidden="true" />
            {running
              ? 'Scarico…'
              : phase === 'done'
                ? 'Scarica di nuovo'
                : `Scarica per offline (${count})`}
          </Button>
        ) : (
          <p className={styles.note}>
            <Info aria-hidden="true" />
            <span>
              <Link href="/login">Accedi</Link> per scaricare i brani consentiti di questa playlist
              e ascoltarli offline.
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

      {onlineOnly.length > 0 ? <OnlineOnlyList id={onlineOnlyId} items={onlineOnly} /> : null}
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
}: {
  target: OfflineDownloadTarget;
  signedIn: boolean;
  size?: 'sm' | 'default';
  variant?: 'outline' | 'ghost' | 'secondary';
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'running' | 'saved' | 'done'>('idle');
  const runningRef = useRef(false);

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
    <Button
      type="button"
      variant={state === 'saved' ? 'secondary' : variant}
      size={size}
      className={className}
      aria-busy={running || undefined}
      aria-disabled={running || state === 'saved' || undefined}
      aria-label={
        state === 'saved'
          ? `${target.title} è nella tua Libreria per l’ascolto offline`
          : `Scarica ${target.title} per l’ascolto offline`
      }
      onClick={() => {
        if (!running && state !== 'saved') void run();
      }}
    >
      {state === 'saved' ? <CheckCircle2 aria-hidden="true" /> : <Download aria-hidden="true" />}
      {state === 'saved' ? 'Offline' : running ? 'Scarico…' : 'Scarica'}
    </Button>
  );
}

function OnlineOnlyList({ id, items }: { id: string; items: OfflinePlan['onlineOnly'] }) {
  return (
    <div id={id} className={styles.onlineOnly}>
      <p className={styles.onlineOnlyLead}>
        <Info aria-hidden="true" />
        <span>{OFFLINE_ONLINE_ONLY_NOTE}</span>
      </p>
      <ul className={styles.onlineOnlyList}>
        {items.map((item) => (
          <li key={item.id}>
            <strong>{item.title}</strong>
            <span>{item.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
