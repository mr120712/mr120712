// @polsia:user-owned — lato browser di «Carica su audio.com» (pagina admin /admin/audiocom): il file
// va DIRETTO dal browser nello staging di Vercel Blob (client upload, token da
// /api/admin/audiocom/uploads/blob, con l'avanzamento), poi POST /api/admin/audiocom/uploads lo
// manda dal server all'account audio.com collegato e cancella la copia di staging. Il browser non
// parla mai con audio.com: niente CORS né CSP da aprire verso host sconosciuti.
'use client';

import { upload } from '@vercel/blob/client';
import { apiFetch } from '@/lib/api-client';
import {
  AUDIOCOM_UPLOAD_FORMATS,
  AUDIOCOM_UPLOAD_MAX_BYTES,
  AUDIOCOM_UPLOAD_MESSAGES,
  AUDIOCOM_UPLOAD_NAME_MAX,
  AUDIOCOM_UPLOAD_STAGING_PREFIX,
  AUDIOCOM_UPLOAD_TITLE_MAX,
  type AudioComUploadFormValues,
  type AudioComUploadMime,
  type AudioComUploadResponse,
  AudioComUploadResponseSchema,
} from '@/lib/contracts/audiocom-upload';

export const AUDIOCOM_UPLOAD_ENDPOINT = '/api/admin/audiocom/uploads';
export const AUDIOCOM_UPLOAD_TOKEN_ENDPOINT = '/api/admin/audiocom/uploads/blob';

/** Oltre questa dimensione il file va su Blob a pezzi (ritentati uno per uno se la rete cade). */
const MULTIPART_FROM_BYTES = 32 * 1024 * 1024;
/** Tetto del caricamento su Blob: se resta appeso, fallisce invece di bloccare il modulo. */
const STAGING_TIMEOUT_MS = 15 * 60_000;
/** Un po' più del tempo massimo della route di invio (120 s). */
const SEND_TIMEOUT_MS = 150_000;

/** MIME mandato ad audio.com per estensione (vince sul tipo dichiarato dal browser). */
const MIME_BY_EXTENSION: Record<string, AudioComUploadMime> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  wave: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  wv: 'audio/x-wavpack',
};

/** Tipi dichiarati dai browser (anche alias) → il MIME mandato ad audio.com. */
const MIME_BY_DECLARED_TYPE: Record<string, AudioComUploadMime> = {
  'audio/mpeg': 'audio/mpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/mpa': 'audio/mpeg',
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/flac': 'audio/flac',
  'audio/x-flac': 'audio/flac',
  'audio/ogg': 'audio/ogg',
  'audio/vorbis': 'audio/ogg',
  'application/ogg': 'audio/ogg',
  'audio/mp4': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4',
  'audio/aiff': 'audio/aiff',
  'audio/x-aiff': 'audio/aiff',
  'audio/x-wavpack': 'audio/x-wavpack',
};

/** Valore dell'attributo `accept` del selettore dei file. */
export const AUDIOCOM_UPLOAD_ACCEPT = [
  'audio/*',
  ...Object.keys(MIME_BY_EXTENSION).map((extension) => `.${extension}`),
].join(',');

const EXTENSION_BY_MIME = new Map<string, string>(
  AUDIOCOM_UPLOAD_FORMATS.map((format) => [format.mime, format.extension]),
);

// biome-ignore lint/suspicious/noControlCharactersInRegex: toglie i caratteri di controllo.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Il MIME da dichiarare ad audio.com per un file, o null se audio.com non lo accetta. */
export function audioComUploadMime(file: {
  name: string;
  type: string;
}): AudioComUploadMime | null {
  const byExtension = MIME_BY_EXTENSION[fileExtension(file.name)];
  if (byExtension) return byExtension;
  const declared = (file.type || '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return MIME_BY_DECLARED_TYPE[declared] ?? null;
}

/** Il problema del file scelto (formato, vuoto, oltre 100 MB), o null se va bene. */
export function audioComUploadFileProblem(file: {
  name: string;
  type: string;
  size: number;
}): string | null {
  if (!audioComUploadMime(file)) return AUDIOCOM_UPLOAD_MESSAGES.fileFormat;
  if (file.size <= 0) return AUDIOCOM_UPLOAD_MESSAGES.fileEmpty;
  if (file.size > AUDIOCOM_UPLOAD_MAX_BYTES) return AUDIOCOM_UPLOAD_MESSAGES.fileTooLarge;
  return null;
}

/** Titolo proposto dal nome del file (senza estensione, trattini bassi come spazi). */
export function audioComTitleFromFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return base
    .replace(CONTROL_CHARS, ' ')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, AUDIOCOM_UPLOAD_TITLE_MAX);
}

/** Nome originale mandato ad audio.com: senza caratteri di controllo, estensione tenuta. */
export function audioComOriginalName(name: string): string {
  const clean = name.replace(CONTROL_CHARS, ' ').trim() || 'brano';
  if (clean.length <= AUDIOCOM_UPLOAD_NAME_MAX) return clean;
  const extension = fileExtension(clean);
  const tail = extension && extension.length < 10 ? `.${extension}` : '';
  return `${clean.slice(0, AUDIOCOM_UPLOAD_NAME_MAX - tail.length).trimEnd()}${tail}`;
}

/** Percorso di staging su Blob: audiocom-staging/<nome-semplice>.<estensione del formato>. */
export function audioComStagingPathname(fileName: string, mime: AudioComUploadMime): string {
  const dot = fileName.lastIndexOf('.');
  const slug =
    (dot > 0 ? fileName.slice(0, dot) : fileName)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
      .replace(/-+$/g, '') || 'brano';
  return `${AUDIOCOM_UPLOAD_STAGING_PREFIX}${slug}.${EXTENSION_BY_MIME.get(mime) ?? 'mp3'}`;
}

/** Errore del passo nel browser (file non adatto o caricamento su Blob non riuscito). */
export class AudioComUploadClientError extends Error {
  constructor(
    message: string,
    /** 'file': il problema è il file scelto (si mostra sotto il campo). */
    readonly field: 'file' | null = null,
  ) {
    super(message);
    this.name = 'AudioComUploadClientError';
  }
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

/** Messaggio in italiano per un errore del client di Vercel Blob. */
function stagingErrorMessage(error: unknown): AudioComUploadClientError {
  const message = error instanceof Error ? error.message : '';
  const name = error instanceof Error ? error.name : '';
  if (/client token/i.test(message)) {
    return new AudioComUploadClientError(
      'Il caricamento non è stato autorizzato (sessione scaduta, troppi caricamenti nell’ultima ora o storage non configurato). Riprova più tardi.',
    );
  }
  if (/content type/i.test(message)) {
    return new AudioComUploadClientError(AUDIOCOM_UPLOAD_MESSAGES.fileFormat, 'file');
  }
  if (/too large/i.test(message)) {
    return new AudioComUploadClientError(AUDIOCOM_UPLOAD_MESSAGES.fileTooLarge, 'file');
  }
  if (name === 'TimeoutError' || name === 'AbortError' || /aborted|expired/i.test(message)) {
    return new AudioComUploadClientError(
      'Il caricamento del file ha impiegato troppo tempo: riprova con una connessione più stabile.',
    );
  }
  return new AudioComUploadClientError(
    'Caricamento del file non riuscito: controlla la connessione e riprova.',
  );
}

/**
 * Carica `file` su audio.com con i dati del modulo: prima nello staging di Vercel Blob
 * (`onProgress` in percentuale), poi `onSending` e l'invio dal server. Lancia
 * AudioComUploadClientError per i problemi del passo nel browser; gli errori della route arrivano
 * da apiFetch (con il corpo della risposta in `cause`).
 */
export async function uploadToAudioCom(
  file: File,
  values: AudioComUploadFormValues,
  options: { onProgress?: (percent: number) => void; onSending?: () => void } = {},
): Promise<AudioComUploadResponse> {
  const problem = audioComUploadFileProblem(file);
  const mime = audioComUploadMime(file);
  if (problem || !mime) {
    throw new AudioComUploadClientError(problem ?? AUDIOCOM_UPLOAD_MESSAGES.fileFormat, 'file');
  }

  let staged: Awaited<ReturnType<typeof upload>>;
  try {
    staged = await upload(audioComStagingPathname(file.name, mime), file, {
      access: 'public',
      handleUploadUrl: AUDIOCOM_UPLOAD_TOKEN_ENDPOINT,
      contentType: mime,
      multipart: file.size > MULTIPART_FROM_BYTES,
      onUploadProgress: options.onProgress
        ? ({ percentage }) => options.onProgress?.(Math.round(percentage))
        : undefined,
      abortSignal: timeoutSignal(STAGING_TIMEOUT_MS),
    });
  } catch (error) {
    throw stagingErrorMessage(error);
  }

  options.onSending?.();
  return apiFetch(AUDIOCOM_UPLOAD_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify({
      blobUrl: staged.url,
      name: audioComOriginalName(file.name),
      size: file.size,
      mime,
      title: values.title,
      ...(values.description ? { description: values.description } : {}),
      license: values.license,
      category: values.category,
      isListed: values.isListed,
      isDownloadable: values.isDownloadable,
      ...(values.collectionId ? { collectionId: values.collectionId } : {}),
      rightsConfirmed: values.rightsConfirmed,
    }),
    schema: AudioComUploadResponseSchema,
    signal: timeoutSignal(SEND_TIMEOUT_MS),
  });
}
