// @polsia:user-owned — pannello «Carica su audio.com» della pagina admin /admin/audiocom (solo con
// l'account collegato): l'amministratore sceglie un file audio dal suo dispositivo e lo pubblica sul
// SUO account audio.com con titolo, descrizione, licenza, categoria, visibilità, download ed
// eventuale collection. Serve la conferma dei diritti (musica sua o di cui ha i diritti, niente
// brani commerciali di altri artisti): senza, il modulo non parte e il server rifiuta comunque.
//
// Passi visibili: «Caricamento del file…» (staging su Vercel Blob, con la percentuale) e «Invio ad
// audio.com…» (il server lo manda ad audio.com e cancella la copia). Esito nei toast, con il link
// alla pagina del brano anche nel pannello; errori dei campi sotto i campi (applyServerErrors).
// L'animazione dell'attesa e della barra si ferma con «riduci movimento».
'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ExternalLink, Loader2, UploadCloud } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { ZodError } from 'zod';
import { Panel } from '@/components/custom/app-ui/panel';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@/lib/api-client';
import { requestErrorMessage } from '@/lib/business/request-error-message';
import {
  type AudioComCollectionSummary,
  AudioComCollectionsAdminResponseSchema,
} from '@/lib/contracts/audiocom-collections';
import {
  AUDIOCOM_UPLOAD_DESCRIPTION_MAX,
  AUDIOCOM_UPLOAD_FORMATS,
  AUDIOCOM_UPLOAD_MESSAGES,
  AUDIOCOM_UPLOAD_TITLE_MAX,
  type AudioComUploadCategory,
  AudioComUploadFormSchema,
  type AudioComUploadFormValues,
  type AudioComUploadLicense,
  type AudioComUploadResponse,
} from '@/lib/contracts/audiocom-upload';
import { applyServerErrors } from '@/lib/forms';
import { isAudioComPlayableLicense } from '@/lib/music/audiocom-license';
import {
  AUDIOCOM_UPLOAD_ACCEPT,
  AudioComUploadClientError,
  audioComTitleFromFileName,
  audioComUploadFileProblem,
  uploadToAudioCom,
} from '@/lib/music/audiocom-upload.client';

const COLLECTIONS_ENDPOINT = '/api/admin/audiocom/collections';

const SELECT_CLASS =
  'flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';
/** Casella nativa: accessibile così com'è e senza dipendenze dal layout (niente ResizeObserver). */
const CHECKBOX_CLASS =
  'mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

export const AUDIOCOM_UPLOAD_LICENSE_OPTIONS: ReadonlyArray<{
  value: AudioComUploadLicense;
  label: string;
  hint: string;
}> = [
  {
    value: 'arr',
    label: 'Tutti i diritti riservati',
    hint: 'Nessuno può riusare il brano senza il tuo permesso.',
  },
  {
    value: 'cc-0',
    label: 'CC0 — pubblico dominio',
    hint: 'Rinunci ai diritti: chiunque può usarlo per qualsiasi scopo, anche senza citarti.',
  },
  {
    value: 'cc-by',
    label: 'CC BY — attribuzione',
    hint: 'Chiunque può riusarlo, anche a fini commerciali, citandoti come autore.',
  },
  {
    value: 'cc-by-sa',
    label: 'CC BY-SA — attribuzione, stessa licenza',
    hint: 'Come CC BY, ma le opere derivate devono avere la stessa licenza.',
  },
  {
    value: 'cc-by-nd',
    label: 'CC BY-ND — attribuzione, senza modifiche',
    hint: 'Si può diffondere, anche a fini commerciali, citandoti, ma non modificare.',
  },
  {
    value: 'cc-by-nc',
    label: 'CC BY-NC — attribuzione, non commerciale',
    hint: 'Riuso citandoti, solo per scopi non commerciali.',
  },
  {
    value: 'cc-by-nc-sa',
    label: 'CC BY-NC-SA — non commerciale, stessa licenza',
    hint: 'Riuso non commerciale citandoti; le opere derivate con la stessa licenza.',
  },
  {
    value: 'cc-by-nc-nd',
    label: 'CC BY-NC-ND — non commerciale, senza modifiche',
    hint: 'Si può solo diffondere così com’è, citandoti e non a fini commerciali.',
  },
];

const CATEGORY_OPTIONS: ReadonlyArray<{ value: AudioComUploadCategory; label: string }> = [
  { value: 'music', label: 'Musica' },
  { value: 'beats', label: 'Basi (beats)' },
  { value: 'cover', label: 'Cover' },
  { value: 'other', label: 'Altro' },
];

const CATEGORY_HINTS: Record<AudioComUploadCategory, string> = {
  music: 'Compare nella ricerca e, se pubblico, nelle collection in Home di Solco.',
  beats: 'Basi strumentali: compaiono nella ricerca come la musica.',
  cover:
    'La canzone è di un altro autore: pubblicala solo se hai la licenza per farlo. In Solco si ascolta solo col player ufficiale di audio.com.',
  other: 'Non compare nella ricerca né in Home di Solco.',
};

const DEFAULT_VALUES: AudioComUploadFormValues = {
  title: '',
  description: '',
  license: 'arr',
  category: 'music',
  isListed: false,
  isDownloadable: false,
  collectionId: '',
  rightsConfirmed: false,
};

/** Campi del modulo che il server può segnalare (gli altri riguardano il file). */
const FORM_FIELDS = new Set<string>(Object.keys(DEFAULT_VALUES));
const FILE_FIELDS = ['mime', 'size', 'name', 'blobUrl'] as const;

type Phase = 'idle' | 'staging' | 'sending';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toLocaleString('it-IT', { maximumFractionDigits: 1 })} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('it-IT')} KB`;
}

function playbackNote(license: AudioComUploadLicense, category: AudioComUploadCategory): string {
  return isAudioComPlayableLicense(license) && category !== 'cover'
    ? 'In Solco si ascolta nel player di Solco, con autore e licenza.'
    : 'In Solco si ascolta col player ufficiale di audio.com.';
}

/** Messaggio di un invio non riuscito (senza errori dei campi). */
function uploadErrorText(error: unknown): string {
  if (error instanceof ZodError) {
    return 'Risposta del server non valida: controlla su audio.com se il brano è arrivato.';
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'Il server non ha risposto in tempo: controlla su audio.com se il brano è arrivato prima di riprovare.';
  }
  if (error instanceof TypeError) return 'Connessione non riuscita: controlla la rete.';
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { error?: unknown; message?: unknown })
      : null;
  if (cause?.error === 'forbidden' || cause?.error === 'unauthorized') {
    return 'Serve un account amministratore con email verificata.';
  }
  const limited = requestErrorMessage(error, '');
  if (limited) return limited;
  if (typeof cause?.message === 'string' && cause.message.trim()) return cause.message.trim();
  return 'Il caricamento su audio.com non è riuscito. Riprova.';
}

export function AudioComUploadAdmin() {
  const form = useForm<AudioComUploadFormValues>({
    resolver: zodResolver(AudioComUploadFormSchema),
    defaultValues: DEFAULT_VALUES,
  });
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  /** Ultimo titolo proposto dal nome del file: si sostituisce solo se non è stato cambiato. */
  const autoTitleRef = useRef('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [percent, setPercent] = useState(0);
  const [collections, setCollections] = useState<AudioComCollectionSummary[]>([]);
  const [collectionsState, setCollectionsState] = useState<'loading' | 'ok' | 'unavailable'>(
    'loading',
  );
  const [lastUpload, setLastUpload] = useState<AudioComUploadResponse | null>(null);
  const fileId = useId();
  const fileHintId = useId();
  const fileErrorId = useId();
  const busy = phase !== 'idle';

  const license = form.watch('license');
  const category = form.watch('category');
  const description = form.watch('description') ?? '';
  const licenseHint =
    AUDIOCOM_UPLOAD_LICENSE_OPTIONS.find((option) => option.value === license)?.hint ?? '';

  // Le collection dell'account, per aggiungervi il brano (facoltativo).
  useEffect(() => {
    let alive = true;
    apiFetch(COLLECTIONS_ENDPOINT, { schema: AudioComCollectionsAdminResponseSchema })
      .then((body) => {
        if (!alive) return;
        setCollections(body.status === 'ok' ? body.collections : []);
        setCollectionsState(body.status === 'ok' ? 'ok' : 'unavailable');
      })
      .catch(() => {
        if (alive) setCollectionsState('unavailable');
      });
    return () => {
      alive = false;
    };
  }, []);

  const pick = (chosen: File | null) => {
    setLastUpload(null);
    if (!chosen) {
      setFile(null);
      setFileError(null);
      return;
    }
    const problem = audioComUploadFileProblem(chosen);
    setFileError(problem);
    setFile(problem ? null : chosen);
    if (problem) return;
    const proposed = audioComTitleFromFileName(chosen.name);
    const current = form.getValues('title');
    if (proposed && (!current.trim() || current === autoTitleRef.current)) {
      form.setValue('title', proposed, { shouldValidate: form.formState.isSubmitted });
      autoTitleRef.current = proposed;
    }
  };

  const showServerErrors = (error: unknown): boolean => {
    const cause =
      error instanceof Error && typeof error.cause === 'object' && error.cause !== null
        ? (error.cause as { errors?: unknown })
        : null;
    if (!cause?.errors || typeof cause.errors !== 'object') return false;
    const errors = cause.errors as Record<string, unknown>;
    const fileMessage = FILE_FIELDS.map((field) => errors[field]).find(
      (value): value is string => typeof value === 'string',
    );
    if (fileMessage) setFileError(fileMessage);
    const formErrors = Object.fromEntries(
      Object.entries(errors).filter(
        ([field, message]) => FORM_FIELDS.has(field) && typeof message === 'string',
      ),
    );
    const applied = applyServerErrors({ errors: formErrors }, form.setError);
    const first = Object.keys(formErrors)[0];
    if (applied && first) form.setFocus(first as keyof AudioComUploadFormValues);
    else if (fileMessage) fileRef.current?.focus();
    return applied || Boolean(fileMessage);
  };

  const send = async (chosen: File, values: AudioComUploadFormValues) => {
    busyRef.current = true;
    setPercent(0);
    setPhase('staging');
    try {
      const result = await uploadToAudioCom(chosen, values, {
        onProgress: (value) => setPercent(Math.min(100, Math.max(0, value))),
        onSending: () => setPhase('sending'),
      });
      setLastUpload(result);
      const pageUrl = result.audio.pageUrl;
      toast.success(
        result.collectionAdded === false
          ? 'Brano caricato su audio.com, ma non aggiunto alla collection: aggiungilo da audio.com.'
          : 'Brano caricato su audio.com.',
        {
          description: 'audio.com lo sta elaborando: tra qualche minuto si può ascoltare.',
          ...(pageUrl
            ? {
                action: {
                  label: 'Apri su audio.com',
                  onClick: () => {
                    window.open(pageUrl, '_blank', 'noopener,noreferrer');
                  },
                },
              }
            : {}),
        },
      );
      form.reset({
        ...DEFAULT_VALUES,
        license: values.license,
        category: values.category,
        isListed: values.isListed,
        isDownloadable: values.isDownloadable,
        collectionId: values.collectionId,
      });
      autoTitleRef.current = '';
      setFile(null);
      setFileError(null);
      if (fileRef.current) fileRef.current.value = '';
    } catch (error) {
      if (error instanceof AudioComUploadClientError) {
        if (error.field === 'file') {
          setFileError(error.message);
          fileRef.current?.focus();
        } else {
          toast.error(error.message);
        }
      } else if (!showServerErrors(error)) {
        toast.error(uploadErrorText(error));
      }
    } finally {
      busyRef.current = false;
      setPhase('idle');
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current) return;
    // Senza file valido resta il motivo già mostrato (es. formato non accettato), se c'è.
    const fileProblem = file
      ? audioComUploadFileProblem(file)
      : (fileError ?? AUDIOCOM_UPLOAD_MESSAGES.file);
    setFileError(fileProblem);
    void form.handleSubmit(async (values) => {
      if (fileProblem || !file) {
        fileRef.current?.focus();
        return;
      }
      await send(file, values);
    })();
  };

  const phaseText =
    phase === 'staging'
      ? 'Caricamento del file…'
      : phase === 'sending'
        ? 'Invio ad audio.com…'
        : '';

  return (
    <Panel
      title="Carica su audio.com"
      description="Pubblica un file audio dal tuo dispositivo sul tuo account audio.com collegato."
    >
      <Form {...form}>
        <form className="grid gap-5" onSubmit={onSubmit} noValidate aria-busy={busy || undefined}>
          <fieldset disabled={busy} className="grid min-w-0 gap-5">
            <legend className="sr-only">Dati del brano</legend>

            <div className="grid gap-2">
              <Label htmlFor={fileId}>File audio</Label>
              <Input
                ref={fileRef}
                id={fileId}
                type="file"
                accept={AUDIOCOM_UPLOAD_ACCEPT}
                aria-describedby={fileError ? `${fileHintId} ${fileErrorId}` : fileHintId}
                aria-invalid={fileError ? true : undefined}
                onChange={(event) => pick(event.target.files?.[0] ?? null)}
              />
              <p id={fileHintId} className="text-[0.8rem] text-muted-foreground">
                {AUDIOCOM_UPLOAD_FORMATS.map((format) => format.label).join(', ')}, fino a 100 MB.
                {file ? ` Scelto: ${file.name} (${formatBytes(file.size)}).` : ''}
              </p>
              {fileError ? (
                <p
                  id={fileErrorId}
                  role="alert"
                  className="text-[0.8rem] font-medium text-destructive"
                >
                  {fileError}
                </p>
              ) : null}
            </div>

            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Titolo</FormLabel>
                  <FormControl>
                    <Input {...field} maxLength={AUDIOCOM_UPLOAD_TITLE_MAX} autoComplete="off" />
                  </FormControl>
                  <FormDescription>Proposto dal nome del file: cambialo se vuoi.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Descrizione (facoltativa)</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={3} maxLength={AUDIOCOM_UPLOAD_DESCRIPTION_MAX} />
                  </FormControl>
                  <FormDescription>
                    {description.length}/{AUDIOCOM_UPLOAD_DESCRIPTION_MAX} caratteri.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-5 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="license"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Licenza</FormLabel>
                    <FormControl>
                      <select {...field} className={SELECT_CLASS}>
                        {AUDIOCOM_UPLOAD_LICENSE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </FormControl>
                    <FormDescription>
                      {licenseHint} {playbackNote(license, category)}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Categoria</FormLabel>
                    <FormControl>
                      <select {...field} className={SELECT_CLASS}>
                        {CATEGORY_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </FormControl>
                    <FormDescription>{CATEGORY_HINTS[category]}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <p className="text-[0.8rem] leading-5 text-muted-foreground">
              Nel player di Solco suonano solo i brani con licenza CC0, CC BY, CC BY-SA o CC BY-ND
              (mai le cover); con le altre licenze si ascoltano col player ufficiale di audio.com.
            </p>

            <FormField
              control={form.control}
              name="isListed"
              render={({ field }) => (
                <FormItem className="flex items-start gap-3 space-y-0">
                  <FormControl>
                    <input
                      type="checkbox"
                      ref={field.ref}
                      name={field.name}
                      checked={field.value}
                      onChange={(event) => field.onChange(event.target.checked)}
                      onBlur={field.onBlur}
                      className={CHECKBOX_CLASS}
                    />
                  </FormControl>
                  <div className="grid gap-1">
                    <FormLabel>Pubblico su audio.com</FormLabel>
                    <FormDescription>
                      Serve per comparire nella Home di Solco e su Google. Un brano non pubblico si
                      ascolta solo da chi ha il link.
                    </FormDescription>
                  </div>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="isDownloadable"
              render={({ field }) => (
                <FormItem className="flex items-start gap-3 space-y-0">
                  <FormControl>
                    <input
                      type="checkbox"
                      ref={field.ref}
                      name={field.name}
                      checked={field.value}
                      onChange={(event) => field.onChange(event.target.checked)}
                      onBlur={field.onBlur}
                      className={CHECKBOX_CLASS}
                    />
                  </FormControl>
                  <div className="grid gap-1">
                    <FormLabel>Download consentito</FormLabel>
                    <FormDescription>
                      Chi visita audio.com può scaricare il file (tu puoi sempre).
                    </FormDescription>
                  </div>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="collectionId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Collection (facoltativa)</FormLabel>
                  <FormControl>
                    <select {...field} className={SELECT_CLASS}>
                      <option value="">Nessuna</option>
                      {collections.map((collection) => (
                        <option key={collection.id} value={collection.id}>
                          {collection.title}
                        </option>
                      ))}
                    </select>
                  </FormControl>
                  <FormDescription>
                    {collectionsState === 'loading'
                      ? 'Caricamento delle collection…'
                      : collectionsState === 'unavailable'
                        ? 'Le collection non sono disponibili ora: puoi caricare senza.'
                        : collections.length === 0
                          ? 'Nessuna collection su questo account.'
                          : 'Il brano si aggiunge in fondo all’album o alla playlist scelta.'}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="rightsConfirmed"
              render={({ field }) => (
                <FormItem className="flex items-start gap-3 space-y-0 rounded-lg border border-border p-3">
                  <FormControl>
                    <input
                      type="checkbox"
                      ref={field.ref}
                      name={field.name}
                      checked={field.value}
                      onChange={(event) => field.onChange(event.target.checked)}
                      onBlur={field.onBlur}
                      required
                      className={CHECKBOX_CLASS}
                    />
                  </FormControl>
                  <div className="grid gap-1">
                    <FormLabel className="leading-5">
                      Confermo che è musica mia o di cui ho i diritti di pubblicazione: niente brani
                      commerciali di altri artisti.
                    </FormLabel>
                    <FormMessage />
                  </div>
                </FormItem>
              )}
            />
          </fieldset>

          <div className="grid gap-2">
            <output aria-live="polite" className="block text-sm text-muted-foreground">
              {phaseText}
            </output>
            {phase === 'staging' ? (
              <div className="flex items-center gap-3">
                <Progress
                  value={percent}
                  aria-label="Caricamento del file"
                  className="[&>*]:motion-reduce:transition-none"
                />
                <span aria-hidden="true" className="w-10 text-right text-xs tabular-nums">
                  {percent}%
                </span>
              </div>
            ) : null}
            <div>
              <Button type="submit" aria-disabled={busy || undefined}>
                {busy ? (
                  <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />
                ) : (
                  <UploadCloud aria-hidden="true" />
                )}
                {busy ? 'Caricamento in corso…' : 'Carica su audio.com'}
              </Button>
            </div>
          </div>

          {lastUpload ? (
            <p className="text-sm">
              Caricato: <strong>{lastUpload.audio.title}</strong>.{' '}
              {lastUpload.audio.pageUrl ? (
                <a
                  href={lastUpload.audio.pageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
                >
                  Apri la pagina su audio.com
                  <ExternalLink aria-hidden="true" className="size-3.5" />
                  <span className="sr-only"> (si apre in una nuova scheda)</span>
                </a>
              ) : (
                'Lo trovi tra i tuoi audio su audio.com.'
              )}
            </p>
          ) : null}
        </form>
      </Form>
    </Panel>
  );
}
