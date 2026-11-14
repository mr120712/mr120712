// @polsia:user-owned — TESTO dei brani caricati in /pubblica: i campi "Testo (facoltativo)" del
// form di caricamento e l'editor del testo dei propri brani già pubblicati (aggiungi, modifica,
// togli). Il testo è un'opera con diritti propri: si pubblica solo spuntando "Il testo è mio o ho
// il diritto di pubblicarlo". Gli errori del server (400 { errors }) tornano sotto i campi con
// applyServerErrors, come in ogni form dell'app.
'use client';

import { Loader2, MicVocal } from 'lucide-react';
import { useId, useState } from 'react';
import type { UseFormSetError } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { UPLOAD_LYRICS_MAX_CHARS } from '@/lib/contracts/lyrics';
import {
  type PublicUpload,
  PublicUploadCreateResponseSchema,
  PublicUploadLyricsUpdateSchema,
} from '@/lib/contracts/public-uploads';
import { applyServerErrors } from '@/lib/forms';
import styles from './upload-lyrics.module.css';

export type LyricsFieldValues = { lyrics: string; lyricsRightsConfirmed: boolean };
export type LyricsFieldErrors = Partial<Record<keyof LyricsFieldValues, string>>;

/**
 * Controllo PRIMA dell'invio, con lo stesso contratto del server: un testo senza conferma non
 * parte nemmeno (nel caricamento eviterebbe un file su Blob senza brano registrato).
 */
export function checkLyricsFields(values: LyricsFieldValues): LyricsFieldErrors {
  const parsed = PublicUploadLyricsUpdateSchema.safeParse({
    lyrics: values.lyrics,
    lyricsRightsConfirmed: values.lyricsRightsConfirmed,
  });
  if (parsed.success) return {};
  const errors: LyricsFieldErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] === 'lyricsRightsConfirmed' ? 'lyricsRightsConfirmed' : 'lyrics';
    errors[field] ??= issue.message;
  }
  return errors;
}

/**
 * Applica il corpo di un 400 del server ai campi del testo. Restituisce gli errori dei campi del
 * testo trovati (vuoto se il 400 riguardava altro) e, in `other`, il primo messaggio degli altri.
 */
export function lyricsErrorsFromServer(body: unknown): {
  fields: LyricsFieldErrors;
  other: string | null;
} {
  const fields: LyricsFieldErrors = {};
  let other: string | null = null;
  const setError: UseFormSetError<LyricsFieldValues> = (name, error) => {
    const message = error.message ?? '';
    if (name === 'lyrics' || name === 'lyricsRightsConfirmed') fields[name] ??= message;
    else other ??= message;
  };
  applyServerErrors(body, setError);
  return { fields, other };
}

/** Testo (textarea) con suggerimento sul formato LRC e la conferma dei diritti sul testo. */
export function UploadLyricsFields({
  values,
  errors,
  disabled,
  onChange,
}: {
  values: LyricsFieldValues;
  errors: LyricsFieldErrors;
  disabled?: boolean;
  onChange: (values: LyricsFieldValues) => void;
}) {
  const id = useId();
  const filled = values.lyrics.trim() !== '';
  return (
    <div className={styles.fields}>
      <label className={styles.field} htmlFor={`${id}-lyrics`}>
        <span className={styles.label}>Testo (facoltativo)</span>
        <textarea
          id={`${id}-lyrics`}
          className={styles.textarea}
          value={values.lyrics}
          // Niente maxLength: il browser taglierebbe in silenzio un testo incollato troppo lungo.
          // Il limite lo controlla il contratto (checkLyricsFields) con l'errore sotto il campo.
          rows={6}
          disabled={disabled}
          aria-invalid={errors.lyrics ? true : undefined}
          aria-describedby={`${id}-hint${errors.lyrics ? ` ${id}-lyrics-error` : ''}`}
          onChange={(event) => onChange({ ...values, lyrics: event.target.value })}
          placeholder={'[00:12.00] Prima riga del testo\n[00:17.50] Seconda riga…'}
          spellCheck={false}
        />
      </label>
      <p id={`${id}-hint`} className={styles.hint}>
        Incolla il testo semplice, una riga per verso, oppure in formato LRC con il tempo davanti a
        ogni riga (es. <code>[01:23.45]</code>): nel player le righe si illumineranno a tempo. Al
        massimo {UPLOAD_LYRICS_MAX_CHARS.toLocaleString('it-IT')} caratteri.
      </p>
      {errors.lyrics ? (
        <p id={`${id}-lyrics-error`} className={styles.error}>
          {errors.lyrics}
        </p>
      ) : null}
      <label className={styles.consent}>
        <input
          type="checkbox"
          checked={values.lyricsRightsConfirmed}
          required={filled}
          disabled={disabled}
          aria-invalid={errors.lyricsRightsConfirmed ? true : undefined}
          aria-describedby={errors.lyricsRightsConfirmed ? `${id}-consent-error` : undefined}
          onChange={(event) => onChange({ ...values, lyricsRightsConfirmed: event.target.checked })}
        />
        <span>Il testo è mio o ho il diritto di pubblicarlo</span>
      </label>
      {errors.lyricsRightsConfirmed ? (
        <p id={`${id}-consent-error`} className={styles.error}>
          {errors.lyricsRightsConfirmed}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Editor del testo di un PROPRIO brano già caricato (elenco "I tuoi brani pubblicati"): apre i
 * campi, salva con PATCH /api/music/public-uploads/[id], toglie il testo con "Rimuovi testo".
 */
export function UploadLyricsEditor({
  upload,
  onSaved,
}: {
  upload: PublicUpload;
  onSaved: (upload: PublicUpload) => void;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<LyricsFieldValues>({
    lyrics: upload.lyrics ?? '',
    lyricsRightsConfirmed: upload.lyricsRightsConfirmed === true,
  });
  const [errors, setErrors] = useState<LyricsFieldErrors>({});
  const [saving, setSaving] = useState(false);
  const hasLyrics = Boolean(upload.lyrics);
  const panelId = useId();

  const send = async (next: LyricsFieldValues) => {
    const local = checkLyricsFields(next);
    setErrors(local);
    if (Object.keys(local).length > 0) return;
    setSaving(true);
    try {
      const removing = next.lyrics.trim() === '';
      const { upload: saved } = await apiFetch(`/api/music/public-uploads/${upload.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          lyrics: removing ? null : next.lyrics,
          lyricsRightsConfirmed: removing ? false : next.lyricsRightsConfirmed,
        }),
        schema: PublicUploadCreateResponseSchema,
      });
      onSaved(saved);
      setValues({
        lyrics: saved.lyrics ?? '',
        lyricsRightsConfirmed: saved.lyricsRightsConfirmed === true,
      });
      setOpen(false);
      toast.success(removing ? 'Testo rimosso.' : 'Testo salvato.');
    } catch (error) {
      const { fields } = lyricsErrorsFromServer(error instanceof Error ? error.cause : null);
      if (Object.keys(fields).length > 0) setErrors(fields);
      else toast.error('Non è stato possibile salvare il testo.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.editor}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        aria-label={`${hasLyrics ? 'Modifica il testo di' : 'Aggiungi il testo a'} ${upload.title}`}
      >
        <MicVocal aria-hidden="true" />
        {hasLyrics ? 'Testo' : 'Aggiungi testo'}
      </Button>
      {open ? (
        <div id={panelId} className={styles.editorPanel}>
          <UploadLyricsFields
            values={values}
            errors={errors}
            disabled={saving}
            onChange={(next) => {
              setValues(next);
              setErrors({});
            }}
          />
          <div className={styles.actions}>
            <Button type="button" size="sm" disabled={saving} onClick={() => void send(values)}>
              {saving ? <Loader2 aria-hidden="true" className={styles.spin} /> : null}
              Salva testo
            </Button>
            {hasLyrics ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => void send({ lyrics: '', lyricsRightsConfirmed: false })}
              >
                Rimuovi testo
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
