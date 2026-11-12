// @polsia:user-owned — carica un file audio proprio o libero (pubblico dominio / Creative Commons).
// Stessi paletti della registrazione: privato di default, conferma dei diritti, pubblicazione nella
// classifica community solo con opt-in. Non per materiale scaricato da terzi sotto licenza.
'use client';

import { Loader2, UploadCloud } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { type Recording, RecordingCreateResponseSchema } from '@/lib/contracts/recordings';
import { baseMimeType } from '@/lib/music/recorder';
import { FileUploadError, uploadPrivateFile } from '@/modules/file-upload/client';
import styles from './song-recorder.module.css';

const MAX_BYTES = 40 * 1024 * 1024;

/** Legge la durata del file lato client (fallback se il contenitore non la riporta al server). */
function readDurationSeconds(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    const finish = (value: number) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? audio.duration : 0);
    audio.onerror = () => finish(0);
    audio.src = url;
  });
}

export function SongUpload({ onSaved }: { onSaved: (recording: Recording) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const pick = (chosen: File | null) => {
    setError(null);
    if (!chosen) {
      setFile(null);
      return;
    }
    if (!chosen.type.startsWith('audio/')) {
      setError('Seleziona un file audio.');
      setFile(null);
      return;
    }
    if (chosen.size > MAX_BYTES) {
      setError('Il file è troppo grande (massimo 40 MB).');
      setFile(null);
      return;
    }
    setFile(chosen);
    if (!title.trim()) setTitle(chosen.name.replace(/\.[^.]+$/, '').slice(0, 80));
  };

  const save = async () => {
    const trimmed = title.trim();
    if (!file || !trimmed || !confirmed) return;
    setSaving(true);
    setPercent(0);
    setError(null);
    try {
      const seconds = Math.max(1, Math.ceil(await readDurationSeconds(file)));
      const uploaded = await uploadPrivateFile(file, { onProgress: setPercent });
      const { recording } = await apiFetch('/api/music/recordings', {
        method: 'POST',
        body: JSON.stringify({
          title: trimmed,
          fileKey: uploaded.key,
          mimeType: baseMimeType(uploaded.mime_type),
          byteLength: uploaded.size,
          elapsedSeconds: seconds,
        }),
        schema: RecordingCreateResponseSchema,
      });
      toast.success('Brano caricato su Solco.');
      onSaved(recording);
      setFile(null);
      setTitle('');
      setConfirmed(false);
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      if (err instanceof FileUploadError) {
        setError(err.message);
      } else {
        const cause =
          err instanceof Error ? (err.cause as { errors?: Record<string, string> }) : null;
        setError(cause?.errors?.fileKey ?? 'Caricamento non riuscito. Riprova.');
      }
      toast.error('Non è stato possibile caricare il brano.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <UploadCloud aria-hidden="true" className={styles.headIcon} />
        <div>
          <h2 className={styles.title}>Carica un brano</h2>
          <p className={styles.subtitle}>
            Carica un file audio tuo o libero (pubblico dominio / Creative Commons). Resta privato
            finché non lo pubblichi.
          </p>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        disabled={saving}
        onChange={(event) => pick(event.target.files?.[0] ?? null)}
      />

      {file ? (
        <>
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
              Confermo di avere i diritti per caricare questo brano: è mio originale oppure
              materiale libero (pubblico dominio o Creative Commons che consente la
              ridistribuzione). Non è scaricato da servizi terzi in violazione dei loro termini.
            </span>
          </label>
        </>
      ) : null}

      {saving ? (
        <div className={styles.progress}>
          <div className={styles.progressBar} style={{ width: `${percent}%` }} />
        </div>
      ) : null}

      {error ? <p className={styles.error}>{error}</p> : null}

      <div className={styles.actions}>
        <Button
          type="button"
          onClick={() => void save()}
          disabled={saving || !file || !title.trim() || !confirmed}
        >
          {saving ? (
            <Loader2 aria-hidden="true" className={styles.spin} />
          ) : (
            <UploadCloud aria-hidden="true" />
          )}
          {saving ? 'Caricamento…' : 'Carica sul sito'}
        </Button>
      </div>
    </div>
  );
}
