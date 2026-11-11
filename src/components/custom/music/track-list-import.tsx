// @polsia:user-owned — "Importa un elenco di brani": l'utente incolla righe "Artista - Titolo"
// o carica il CSV di una playlist esportata da un altro servizio; Solco crea la playlist e cerca
// ogni brano su YouTube solo quando lo si ascolta. Nessuna API di terzi.
'use client';

import { FileUp, ListMusic } from 'lucide-react';
import { type ChangeEvent, type FormEvent, useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { TrackListImportResponseSchema } from '@/lib/contracts/library';
import styles from './discover.module.css';

const MAX_TEXT = 300_000;

/** The field error to show on the form, if the server returned one. */
function fieldError(error: unknown) {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { errors?: { text?: unknown } })
      : null;
  return typeof cause?.errors?.text === 'string' ? cause.errors.text : null;
}

function generalError(error: unknown) {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { message?: unknown })
      : null;
  return typeof cause?.message === 'string' ? cause.message : 'Importazione non riuscita. Riprova.';
}

/** Exports come in UTF-8, UTF-16 (Excel "Unicode text") or Windows-1252 (old Excel CSV). */
async function readTextFile(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export function TrackListImport({ onImported }: { onImported: () => void }) {
  const ids = { name: useId(), text: useId(), file: useId() };
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_TEXT) {
      setError('Il file è troppo grande (massimo 300 KB).');
      return;
    }
    setError(null);
    setText(await readTextFile(file));
    setFileName(file.name);
    if (!name.trim()) setName(file.name.replace(/\.(csv|txt)$/i, '').slice(0, 50));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch('/api/music/import/track-list', {
        method: 'POST',
        body: JSON.stringify({ text: text.slice(0, MAX_TEXT), name: name.trim() || undefined }),
        schema: TrackListImportResponseSchema,
      });
      const notes = [
        result.skipped ? `${result.skipped} saltati` : '',
        result.truncated ? `${result.truncated} oltre il limite di 200` : '',
      ].filter(Boolean);
      toast.success(
        `“${result.name}” importata: ${result.imported} brani${notes.length ? ` (${notes.join(', ')})` : ''}.`,
      );
      setText('');
      setName('');
      setFileName(null);
      onImported();
    } catch (reason) {
      // Field problems stay on the form; everything else is a transient toast.
      const field = fieldError(reason);
      if (field) setError(field);
      else toast.error(generalError(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className={styles.importPanel}>
      <summary>
        <ListMusic aria-hidden="true" /> Importa un elenco di brani (da Spotify o altri servizi)
      </summary>
      <form className={styles.aiForm} onSubmit={(event) => void submit(event)}>
        <p className={styles.state}>
          Incolla un brano per riga, come “Artista - Titolo”, oppure carica il file CSV della tua
          playlist (massimo 200 brani per elenco). Per Spotify puoi esportarla in CSV con uno
          strumento come Exportify. Solco crea la playlist e cerca ogni brano su YouTube quando lo
          ascolti.
        </p>
        <label htmlFor={ids.name} className="sr-only">
          Nome della playlist
        </label>
        <input
          id={ids.name}
          value={name}
          maxLength={50}
          placeholder="Nome della playlist (facoltativo)"
          onChange={(event) => setName(event.target.value)}
          className="min-h-10 rounded-lg border border-input bg-background px-3 text-sm"
        />
        <label htmlFor={ids.text} className="sr-only">
          Elenco dei brani
        </label>
        <textarea
          id={ids.text}
          value={text}
          rows={6}
          placeholder={'Artista - Titolo\nArtista - Titolo'}
          onChange={(event) => {
            setText(event.target.value);
            setFileName(null);
          }}
          className="w-full rounded-lg border border-input bg-background p-3 text-sm"
        />
        <div className={styles.headerActions}>
          <label htmlFor={ids.file} className={styles.backgroundButton}>
            <FileUp aria-hidden="true" /> {fileName ?? 'Carica CSV o TXT'}
          </label>
          <input
            id={ids.file}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="sr-only"
            onChange={(event) => void readFile(event)}
          />
          <Button type="submit" disabled={busy || !text.trim()}>
            {busy ? 'Importazione…' : 'Importa elenco'}
          </Button>
        </div>
        {error ? (
          <p className={styles.state} role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </details>
  );
}
