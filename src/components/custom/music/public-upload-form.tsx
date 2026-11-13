// @polsia:user-owned — carica un brano nella LIBRERIA PUBBLICA: il file va su AWS S3 (oggetto
// pubblico) ed è ascoltabile da tutti. Richiede login e l'attestazione dei diritti; la moderazione
// (segnalazioni) può ritirarlo. Non per materiale di terzi sotto copyright.
'use client';

import { Loader2, UploadCloud } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useLibrary } from '@/components/custom/music/library-context';
import { Button } from '@/components/ui/button';
import type { PublicUpload } from '@/lib/contracts/public-uploads';
import {
  AUDIO_UPLOAD_EXTENSIONS,
  audioUploadMimeType,
  MAX_UPLOAD_BYTES,
  PublicUploadError,
  shouldReassignMime,
  uploadPublicSong,
} from '@/lib/music/public-upload.client';
import styles from './public-upload-form.module.css';

export function PublicUploadForm({
  onUploaded,
  count,
  limit,
}: {
  onUploaded: (upload: PublicUpload) => void;
  /** Quanti brani pubblici ha già l'utente, e il tetto massimo. */
  count: number;
  limit: number;
}) {
  const library = useLibrary();
  const atLimit = count >= limit;
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // null = non ancora saputo; false = storage (AWS S3) non configurato sul server.
  const [configured, setConfigured] = useState<boolean | null>(null);

  // Sa in anticipo se la libreria pubblica è attiva, per mostrare un messaggio chiaro invece
  // di un errore criptico quando lo storage non è configurato.
  useEffect(() => {
    if (!library.signedIn) return;
    let alive = true;
    fetch('/api/music/public-uploads/blob', { method: 'GET', cache: 'no-store' })
      .then(async (res) => {
        // Una risposta non-ok (tipicamente il 502 di cold-start della serverless function) NON
        // significa "storage non configurato": lasciamo lo stato "sconosciuto" (null), così il form
        // resta utilizzabile invece di mostrare falsamente "non attiva" e disattivare il caricamento.
        if (!res.ok) return null;
        return (await res.json()) as { configured?: boolean };
      })
      .then((data) => {
        if (alive && data) setConfigured(data.configured === true);
      })
      .catch(() => {
        if (alive) setConfigured(null);
      });
    return () => {
      alive = false;
    };
  }, [library.signedIn]);

  const pick = (chosen: File | null) => {
    setError(null);
    if (!chosen) {
      setFile(null);
      return;
    }
    const mime = audioUploadMimeType(chosen.type, chosen.name);
    if (!mime) {
      setError('Formato non supportato. Scegli un file audio (MP3, M4A, WAV, FLAC, OGG…).');
      setFile(null);
      return;
    }
    if (chosen.size > MAX_UPLOAD_BYTES) {
      setError('Il file è troppo grande (massimo 40 MB).');
      setFile(null);
      return;
    }
    const normalized = shouldReassignMime(chosen.type)
      ? new File([chosen], chosen.name, { type: mime, lastModified: chosen.lastModified })
      : chosen;
    setFile(normalized);
    if (!title.trim()) setTitle(normalized.name.replace(/\.[^.]+$/, '').slice(0, 120));
  };

  const save = async () => {
    const trimmed = title.trim();
    if (!file || !trimmed || !confirmed) return;
    setSaving(true);
    setPercent(0);
    setError(null);
    try {
      const upload = await uploadPublicSong(file, {
        title: trimmed,
        artist: artist.trim() || undefined,
        onProgress: setPercent,
      });
      onUploaded(upload);
      toast.success('Brano caricato nella libreria pubblica.');
      setFile(null);
      setTitle('');
      setArtist('');
      setConfirmed(false);
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      if (err instanceof PublicUploadError) {
        setError(err.message);
      } else {
        const cause =
          err instanceof Error ? (err.cause as { errors?: Record<string, string> }) : null;
        setError(
          cause?.errors?.blobUrl ??
            cause?.errors?.title ??
            (err instanceof Error
              ? `Caricamento non riuscito. (${err.message})`
              : 'Caricamento non riuscito. Riprova.'),
        );
      }
      toast.error('Non è stato possibile caricare il brano.');
    } finally {
      setSaving(false);
    }
  };

  if (!library.signedIn) {
    return (
      <div className={styles.card}>
        <p className={styles.lead}>Accedi per caricare un brano nella libreria pubblica.</p>
        <Button asChild>
          <a href="/login">Accedi</a>
        </Button>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <UploadCloud aria-hidden="true" className={styles.headIcon} />
        <div>
          <h2 className={styles.title}>Carica un brano pubblico</h2>
          <p className={styles.subtitle}>
            Puoi pubblicare fino a <strong>{limit} brani</strong>, ascoltabili da tutti nella
            libreria pubblica. Carica solo musica tua o libera (pubblico dominio / Creative
            Commons): niente materiale di terzi sotto copyright.
          </p>
          <p className={styles.counter} aria-live="polite">
            <strong>{count}</strong> / {limit} brani pubblicati
          </p>
        </div>
      </div>

      {configured === false ? (
        <p className={styles.error}>
          La libreria pubblica non è ancora attiva: lo storage (AWS S3) non è configurato sul
          server. Riprova più tardi.
        </p>
      ) : null}

      {atLimit ? (
        <p className={styles.limitNotice}>
          Hai raggiunto il massimo di {limit} brani pubblici. Rimuovi un brano qui sotto per
          pubblicarne un altro.
        </p>
      ) : null}

      <input
        ref={inputRef}
        type="file"
        accept={`audio/*,${AUDIO_UPLOAD_EXTENSIONS.map((ext) => `.${ext}`).join(',')}`}
        disabled={saving || configured === false || atLimit}
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
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Titolo del brano"
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Artista (facoltativo)</span>
            <input
              className={styles.input}
              type="text"
              value={artist}
              maxLength={120}
              onChange={(event) => setArtist(event.target.value)}
              placeholder="Nome dell'artista"
            />
          </label>
          <label className={styles.consent}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              Confermo di avere i diritti per pubblicare e diffondere questo brano: è mio originale
              oppure materiale libero (pubblico dominio o Creative Commons che consente la
              ridistribuzione). Non è di terzi sotto copyright.
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
          disabled={
            saving || !file || !title.trim() || !confirmed || configured === false || atLimit
          }
        >
          {saving ? (
            <Loader2 aria-hidden="true" className={styles.spin} />
          ) : (
            <UploadCloud aria-hidden="true" />
          )}
          {saving ? 'Caricamento…' : 'Pubblica brano'}
        </Button>
      </div>
    </div>
  );
}
