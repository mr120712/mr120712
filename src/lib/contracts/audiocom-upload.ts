// @polsia:user-owned — contratto condiviso (client + route) di «Carica su audio.com» nella pagina
// admin /admin/audiocom: l'amministratore manda un file audio dal suo dispositivo al SUO account
// audio.com (API pubblica, POST /v1/audio/create).
//
// Il file passa da Vercel Blob (staging): il browser lo carica direttamente nello store di Solco
// sotto AUDIOCOM_UPLOAD_STAGING_PREFIX (token da /api/admin/audiocom/uploads/blob), poi
// POST /api/admin/audiocom/uploads lo scarica dallo store, lo manda ad audio.com e cancella sempre
// la copia di staging. Qui stanno i limiti, i formati, le licenze, il modulo del client, il corpo
// della richiesta e la risposta: un cambio di forma diventa un errore di tipo o uno ZodError.
import { z } from 'zod';
import { AudioComCollectionIdSchema } from '@/lib/contracts/audiocom-collections';
import {
  AUDIOCOM_ID_PATTERN,
  AUDIOCOM_LICENSE_VALUES,
  isAudioComPageUrl,
} from '@/lib/music/audiocom-license';

/** Dimensione massima di un file (audio.com ne accetta fino a 1 GiB; Solco si ferma a 100 MB). */
export const AUDIOCOM_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
/** Prefisso dei file di staging su Vercel Blob (lo impone anche il token di caricamento). */
export const AUDIOCOM_UPLOAD_STAGING_PREFIX = 'audiocom-staging/';
export const AUDIOCOM_UPLOAD_TITLE_MAX = 200;
/** Limite di audio.com per la descrizione. */
export const AUDIOCOM_UPLOAD_DESCRIPTION_MAX = 500;
export const AUDIOCOM_UPLOAD_NAME_MAX = 255;

/**
 * Formati mandati ad audio.com, uno per tipo di file (il client sceglie questo MIME dall'estensione
 * o dal tipo dichiarato dal browser): tutti nell'elenco dei MIME accettati da POST /v1/audio/create
 * (wav, mp3, flac, ogg, m4a, aiff, wavpack). Dopo il caricamento audio.com riconosce il formato vero
 * e scarta il file se non corrisponde a quello dichiarato.
 */
export const AUDIOCOM_UPLOAD_FORMATS = [
  { mime: 'audio/mpeg', extension: 'mp3', label: 'MP3' },
  { mime: 'audio/wav', extension: 'wav', label: 'WAV' },
  { mime: 'audio/flac', extension: 'flac', label: 'FLAC' },
  { mime: 'audio/ogg', extension: 'ogg', label: 'OGG' },
  { mime: 'audio/mp4', extension: 'm4a', label: 'M4A' },
  { mime: 'audio/aiff', extension: 'aiff', label: 'AIFF' },
  { mime: 'audio/x-wavpack', extension: 'wv', label: 'WavPack' },
] as const;
export type AudioComUploadMime = (typeof AUDIOCOM_UPLOAD_FORMATS)[number]['mime'];
export const AUDIOCOM_UPLOAD_MIME_TYPES = AUDIOCOM_UPLOAD_FORMATS.map(
  (format) => format.mime,
) as unknown as readonly [AudioComUploadMime, ...AudioComUploadMime[]];

/** Licenze proponibili al caricamento (`none`, «nessuna licenza scelta», non si propone). */
export const AUDIOCOM_UPLOAD_LICENSES = [
  'arr',
  'cc-0',
  'cc-by',
  'cc-by-sa',
  'cc-by-nd',
  'cc-by-nc',
  'cc-by-nc-sa',
  'cc-by-nc-nd',
] as const;
export type AudioComUploadLicense = (typeof AUDIOCOM_UPLOAD_LICENSES)[number];

/** Categorie di audio.com proposte (quelle musicali, più «altro»). */
export const AUDIOCOM_UPLOAD_CATEGORIES = ['music', 'beats', 'cover', 'other'] as const;
export type AudioComUploadCategory = (typeof AUDIOCOM_UPLOAD_CATEGORIES)[number];

/** Messaggi dei campi, uguali sul client e dal server. */
export const AUDIOCOM_UPLOAD_MESSAGES = {
  rights:
    'Conferma che è musica tua o di cui hai i diritti di pubblicazione: niente brani commerciali di altri artisti.',
  title: 'Scrivi il titolo del brano.',
  titleTooLong: `Il titolo è troppo lungo: al massimo ${AUDIOCOM_UPLOAD_TITLE_MAX} caratteri.`,
  descriptionTooLong: `La descrizione è troppo lunga: al massimo ${AUDIOCOM_UPLOAD_DESCRIPTION_MAX} caratteri.`,
  control: 'Il testo contiene caratteri non ammessi.',
  license: 'Scegli una licenza.',
  category: 'Scegli una categoria.',
  collection: 'Collection non valida.',
  file: 'Scegli un file audio da caricare.',
  fileName: 'Il nome del file non è valido: rinomina il file e riprova.',
  fileFormat: `Formato non accettato da audio.com: scegli un file ${AUDIOCOM_UPLOAD_FORMATS.map((format) => format.label).join(', ')}.`,
  fileEmpty: 'Il file è vuoto.',
  fileSize: 'Dimensione del file non valida.',
  fileTooLarge: 'Il file supera i 100 MB.',
  blobUrl: 'Il file caricato non è valido: sceglilo e caricalo di nuovo.',
} as const;

// biome-ignore lint/suspicious/noControlCharactersInRegex: rifiuta proprio i caratteri di controllo.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: come sopra, ma a capo e tab sono ammessi.
const CONTROL_CHARS_EXCEPT_NEWLINES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Percorso di staging chiesto dal client (prima del suffisso casuale aggiunto da Vercel Blob). */
const STAGING_PATHNAME = new RegExp(
  `^${AUDIOCOM_UPLOAD_STAGING_PREFIX}[a-z0-9][a-z0-9-]{0,59}\\.(?:${AUDIOCOM_UPLOAD_FORMATS.map((format) => format.extension).join('|')})$`,
);
/** Percorso dell'oggetto salvato (con il suffisso casuale): un solo livello, caratteri semplici. */
const STAGED_URL_PATH = new RegExp(
  `^/${AUDIOCOM_UPLOAD_STAGING_PREFIX}[A-Za-z0-9][A-Za-z0-9._-]{0,200}$`,
);
/** Suffisso degli host pubblici di Vercel Blob (il server controlla poi l'host esatto dello store). */
const BLOB_PUBLIC_HOST_SUFFIX = '.public.blob.vercel-storage.com';

/** True per il percorso che il client chiede al token di staging (es. audiocom-staging/brano.mp3). */
export function isAudioComStagingPathname(pathname: string): boolean {
  return STAGING_PATHNAME.test(pathname);
}

/**
 * URL di un file di staging: https, host pubblico di Vercel Blob, senza credenziali, porta, query
 * né frammento, sotto AUDIOCOM_UPLOAD_STAGING_PREFIX. Controllo di forma (anche nel client): il
 * server verifica in più che l'host sia quello dello store di Solco.
 */
export function parseAudioComStagingUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (url.search || url.hash || raw.includes('#') || raw.includes('?')) return null;
  if (!url.hostname.endsWith(BLOB_PUBLIC_HOST_SUFFIX)) return null;
  return STAGED_URL_PATH.test(url.pathname) ? url : null;
}

const titleField = z
  .string()
  .trim()
  .min(1, AUDIOCOM_UPLOAD_MESSAGES.title)
  .max(AUDIOCOM_UPLOAD_TITLE_MAX, AUDIOCOM_UPLOAD_MESSAGES.titleTooLong)
  .refine((value) => !CONTROL_CHARS.test(value), AUDIOCOM_UPLOAD_MESSAGES.control);

const descriptionField = z
  .string()
  .trim()
  .max(AUDIOCOM_UPLOAD_DESCRIPTION_MAX, AUDIOCOM_UPLOAD_MESSAGES.descriptionTooLong)
  .refine((value) => !CONTROL_CHARS_EXCEPT_NEWLINES.test(value), AUDIOCOM_UPLOAD_MESSAGES.control);

const licenseField = z.enum(AUDIOCOM_UPLOAD_LICENSES, {
  errorMap: () => ({ message: AUDIOCOM_UPLOAD_MESSAGES.license }),
});

const categoryField = z.enum(AUDIOCOM_UPLOAD_CATEGORIES, {
  errorMap: () => ({ message: AUDIOCOM_UPLOAD_MESSAGES.category }),
});

/** Modulo del client (il file si controlla a parte): '' = nessuna collection. */
export const AudioComUploadFormSchema = z.object({
  title: titleField,
  description: descriptionField,
  license: licenseField,
  category: categoryField,
  isListed: z.boolean(),
  isDownloadable: z.boolean(),
  collectionId: z
    .string()
    .refine(
      (value) => value === '' || AUDIOCOM_ID_PATTERN.test(value),
      AUDIOCOM_UPLOAD_MESSAGES.collection,
    ),
  rightsConfirmed: z.boolean().refine((value) => value, AUDIOCOM_UPLOAD_MESSAGES.rights),
});
export type AudioComUploadFormValues = z.infer<typeof AudioComUploadFormSchema>;

/** POST /api/admin/audiocom/uploads: il file già su Vercel Blob (staging) e i dati del brano. */
export const AudioComUploadInputSchema = z
  .object({
    blobUrl: z
      .string()
      .max(2048, AUDIOCOM_UPLOAD_MESSAGES.blobUrl)
      .refine((value) => parseAudioComStagingUrl(value) !== null, AUDIOCOM_UPLOAD_MESSAGES.blobUrl),
    /** Nome originale del file (audio.com ne ricava l'indirizzo del brano se serve). */
    name: z
      .string()
      .trim()
      .min(1, AUDIOCOM_UPLOAD_MESSAGES.fileName)
      .max(AUDIOCOM_UPLOAD_NAME_MAX, AUDIOCOM_UPLOAD_MESSAGES.fileName)
      .refine((value) => !CONTROL_CHARS.test(value), AUDIOCOM_UPLOAD_MESSAGES.fileName),
    /** Dimensione ESATTA in byte (audio.com scarta il file se non corrisponde). */
    size: z
      .number({ invalid_type_error: AUDIOCOM_UPLOAD_MESSAGES.fileSize })
      .int(AUDIOCOM_UPLOAD_MESSAGES.fileSize)
      .min(1, AUDIOCOM_UPLOAD_MESSAGES.fileEmpty)
      .max(AUDIOCOM_UPLOAD_MAX_BYTES, AUDIOCOM_UPLOAD_MESSAGES.fileTooLarge),
    mime: z.enum(AUDIOCOM_UPLOAD_MIME_TYPES, {
      errorMap: () => ({ message: AUDIOCOM_UPLOAD_MESSAGES.fileFormat }),
    }),
    title: titleField,
    description: descriptionField.optional(),
    license: licenseField,
    category: categoryField,
    isListed: z.boolean(),
    isDownloadable: z.boolean(),
    collectionId: AudioComCollectionIdSchema.optional(),
    /** Deve essere proprio `true`: musica dell'amministratore o di cui ha i diritti. */
    rightsConfirmed: z.literal(true, {
      errorMap: () => ({ message: AUDIOCOM_UPLOAD_MESSAGES.rights }),
    }),
  })
  .strict();
export type AudioComUploadInput = z.infer<typeof AudioComUploadInputSchema>;

/** Risposta 201: il brano creato su audio.com (la pagina può mancare se audio.com non la indica). */
export const AudioComUploadResponseSchema = z.object({
  audio: z.object({
    id: z.string().regex(AUDIOCOM_ID_PATTERN),
    title: z.string().min(1).max(300),
    pageUrl: z
      .string()
      .max(600)
      .refine(isAudioComPageUrl, 'Pagina audio.com non valida')
      .nullable(),
    license: z.enum(AUDIOCOM_LICENSE_VALUES),
    isListed: z.boolean(),
  }),
  /** null: nessuna collection scelta; true: aggiunto; false: caricato ma NON aggiunto. */
  collectionAdded: z.boolean().nullable(),
});
export type AudioComUploadResponse = z.infer<typeof AudioComUploadResponseSchema>;
