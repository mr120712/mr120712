// @polsia:user-owned — registra un brano dal microfono e lo carica sul sito.
// Il file resta in archivio PRIVATO (uploadPrivateFile) e viene servito solo dalla
// route con controllo di proprietà: è una registrazione originale, niente terze parti.
'use client';

import { Loader2, Mic, Square, Trash2, UploadCloud } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { type Recording, RecordingCreateResponseSchema } from '@/lib/contracts/recordings';
import {
  baseMimeType,
  defaultRecordingTitle,
  formatClock,
  MAX_RECORDING_SECONDS,
  pickRecorderMimeType,
  recordingFileName,
} from '@/lib/music/recorder';
import { FileUploadError, uploadPrivateFile } from '@/modules/file-upload/client';
import styles from './song-recorder.module.css';

type Phase = 'idle' | 'requesting' | 'recording' | 'recorded' | 'saving';

export function SongRecorder({ onSaved }: { onSaved: (recording: Recording) => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const blobRef = useRef<Blob | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const supported =
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;

  const stopStream = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const revokePreview = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  }, []);

  // Pulizia su smontaggio: ferma microfono, timer e URL oggetto.
  useEffect(() => {
    return () => {
      clearTimer();
      stopStream();
      revokePreview();
    };
  }, [clearTimer, stopStream, revokePreview]);

  const stop = useCallback(() => {
    clearTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
  }, [clearTimer]);

  const start = useCallback(async () => {
    setError(null);
    if (!supported) {
      setError('Questo browser non supporta la registrazione audio.');
      return;
    }
    setPhase('requesting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setPhase('idle');
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setError('Permesso del microfono negato. Consentilo e riprova.');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setError('Nessun microfono trovato.');
      } else {
        setError('Impossibile accedere al microfono.');
      }
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];
    blobRef.current = null;
    revokePreview();
    setPreviewUrl(null);
    setElapsed(0);

    const mimeType = pickRecorderMimeType((type) => MediaRecorder.isTypeSupported(type));
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      stopStream();
      setPhase('idle');
      setError('Impossibile avviare la registrazione.');
      return;
    }
    recorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      stopStream();
      const type = recorder.mimeType || chunksRef.current[0]?.type || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type });
      blobRef.current = blob;
      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;
      setPreviewUrl(url);
      if (!title.trim()) setTitle(defaultRecordingTitle(new Date()));
      setPhase('recorded');
    };

    try {
      recorder.start();
    } catch {
      stopStream();
      setPhase('idle');
      setError('Impossibile avviare la registrazione.');
      return;
    }
    setPhase('recording');
    timerRef.current = setInterval(() => {
      setElapsed((previous) => {
        const next = previous + 1;
        if (next >= MAX_RECORDING_SECONDS) stop();
        return next;
      });
    }, 1000);
  }, [supported, revokePreview, stopStream, title, stop]);

  const discard = useCallback(() => {
    revokePreview();
    blobRef.current = null;
    chunksRef.current = [];
    setPreviewUrl(null);
    setTitle('');
    setConfirmed(false);
    setElapsed(0);
    setUploadPercent(0);
    setPhase('idle');
    setError(null);
  }, [revokePreview]);

  const save = useCallback(async () => {
    const blob = blobRef.current;
    const trimmed = title.trim();
    if (!blob || !trimmed || !confirmed) return;
    setPhase('saving');
    setUploadPercent(0);
    setError(null);

    const fileName = recordingFileName(trimmed, baseMimeType(blob.type));
    const file = new File([blob], fileName, { type: blob.type });

    try {
      const uploaded = await uploadPrivateFile(file, {
        onProgress: (percent) => setUploadPercent(percent),
      });
      const { recording } = await apiFetch('/api/music/recordings', {
        method: 'POST',
        body: JSON.stringify({
          title: trimmed,
          fileKey: uploaded.key,
          mimeType: baseMimeType(uploaded.mime_type),
          byteLength: uploaded.size,
          elapsedSeconds: Math.max(1, elapsed),
        }),
        schema: RecordingCreateResponseSchema,
      });
      toast.success('Brano registrato e salvato su Solco.');
      onSaved(recording);
      discard();
    } catch (err) {
      setPhase('recorded');
      if (err instanceof FileUploadError) {
        setError(err.message);
      } else {
        const cause =
          err instanceof Error ? (err.cause as { errors?: Record<string, string> }) : null;
        setError(cause?.errors?.fileKey ?? 'Salvataggio non riuscito. Riprova.');
      }
      toast.error('Non è stato possibile salvare la registrazione.');
    }
  }, [title, confirmed, elapsed, onSaved, discard]);

  if (!supported) {
    return (
      <div className={styles.card}>
        <p className={styles.unsupported}>
          Questo browser non supporta la registrazione audio. Prova con Chrome, Edge o Firefox
          aggiornati.
        </p>
      </div>
    );
  }

  const busy = phase === 'saving';

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <Mic aria-hidden="true" className={styles.headIcon} />
        <div>
          <h2 className={styles.title}>Registra un brano</h2>
          <p className={styles.subtitle}>
            Registri dal microfono e il brano resta ospitato interamente su Solco.
          </p>
        </div>
      </div>

      {phase === 'recording' ? (
        <div className={styles.recording}>
          <span className={styles.pulse} aria-hidden="true" />
          <span className={styles.clock}>{formatClock(elapsed)}</span>
          <span className={styles.limit}>/ {formatClock(MAX_RECORDING_SECONDS)}</span>
        </div>
      ) : null}

      {phase === 'recorded' && previewUrl ? (
        <div className={styles.preview}>
          {/* biome-ignore lint/a11y/useMediaCaption: registrazione vocale dell'utente, senza didascalia. */}
          <audio controls src={previewUrl} className={styles.audio} />
          <label className={styles.field}>
            <span className={styles.label}>Titolo</span>
            <input
              className={styles.input}
              type="text"
              value={title}
              maxLength={80}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Titolo del brano"
            />
          </label>
          <label className={styles.consent}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              Confermo che è una mia registrazione originale e di avere i diritti per pubblicarla su
              Solco.
            </span>
          </label>
        </div>
      ) : null}

      {phase === 'saving' ? (
        <div className={styles.progress}>
          <div className={styles.progressBar} style={{ width: `${uploadPercent}%` }} />
        </div>
      ) : null}

      {error ? <p className={styles.error}>{error}</p> : null}

      <div className={styles.actions}>
        {phase === 'idle' || phase === 'requesting' ? (
          <Button type="button" onClick={() => void start()} disabled={phase === 'requesting'}>
            <Mic aria-hidden="true" /> {phase === 'requesting' ? 'Attendi…' : 'Inizia a registrare'}
          </Button>
        ) : null}

        {phase === 'recording' ? (
          <Button type="button" variant="secondary" onClick={stop}>
            <Square aria-hidden="true" /> Ferma
          </Button>
        ) : null}

        {phase === 'recorded' || phase === 'saving' ? (
          <>
            <Button
              type="button"
              onClick={() => void save()}
              disabled={busy || !title.trim() || !confirmed}
            >
              {busy ? (
                <Loader2 aria-hidden="true" className={styles.spin} />
              ) : (
                <UploadCloud aria-hidden="true" />
              )}
              {busy ? 'Salvataggio…' : 'Salva sul sito'}
            </Button>
            <Button type="button" variant="ghost" onClick={discard} disabled={busy}>
              <Trash2 aria-hidden="true" /> Scarta
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
