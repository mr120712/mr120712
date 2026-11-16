// @polsia:user-owned — client minimo di OpenAI Whisper (trascrizione audio) con fetch, senza SDK.
// Usato SOLO dalla trascrizione dei testi dei brani in evidenza dichiarati con "testo": true
// (lyrics-transcription.server.ts), dalla pagina admin. La chiave è OPENAI_API_KEY (variabile del
// server, mai nel bundle del browser): non finisce mai nei log né nei messaggi d'errore, e degli
// errori di OpenAI si restituisce solo un messaggio italiano generico, mai il testo della risposta.
//
// Richiesta: POST https://api.openai.com/v1/audio/transcriptions, multipart/form-data con `file`
// (i byte dell'audio, nome "audio.<estensione originale>" così il formato si riconosce e il nome
// del brano non esce), `model` whisper-1, `response_format` verbose_json,
// `timestamp_granularities[]` segment, `temperature` 0 e, se scelta, `language` (ISO-639-1).
// Risposta attesa: { text, language, duration, segments: [{ start, end, text, avg_logprob,
// no_speech_prob, compression_ratio, … }] }, letta con zod in modo tollerante (campi in più ok,
// segmenti malformati saltati).
//
// Verifica della chiave (probeWhisper, pulsante «Verifica chiave OpenAI» della pagina admin): la
// stessa richiesta con un secondo di silenzio WAV generato qui (nessun brano, costo di circa un
// centesimo di centesimo). Dice se la chiave è valida, se i crediti sono finiti (429
// insufficient_quota → no_credit) o se OpenAI non risponde, con gli stessi codici della trascrizione.
import 'server-only';
import { z } from 'zod';
import {
  TRANSCRIPTION_MAX_AUDIO_BYTES,
  type TranscriptionLanguage,
  WHISPER_EXTENSIONS,
  type WhisperExtension,
} from '@/lib/contracts/lyrics-transcription';
import { readUpTo } from '@/lib/music/featured-rights.server';

export const WHISPER_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
export const WHISPER_MODEL = 'whisper-1';
/** Tempo massimo di una trascrizione (la route ha 120 secondi in tutto). */
export const WHISPER_TIMEOUT_MS = 100_000;
/** Risposta di OpenAI letta al massimo (un brano di 25 MB ne produce molto meno). */
const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
/** Segmenti letti al massimo. */
const MAX_SEGMENTS = 5000;

const MIME_TYPES: Record<WhisperExtension, string> = {
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  mp4: 'audio/mp4',
  mpeg: 'audio/mpeg',
  mpga: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'audio/webm',
};

/** La chiave OpenAI dal server, o null se manca. Mai loggarla né restituirla. */
export function openAiApiKey(): string | null {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key ? key : null;
}

/** True se la trascrizione si può usare (chiave presente). */
export function isWhisperConfigured(): boolean {
  return openAiApiKey() !== null;
}

/** L'estensione del file se Whisper la accetta (maiuscole indifferenti), altrimenti null. */
export function whisperExtension(pathname: string): WhisperExtension | null {
  const base = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = base.slice(dot + 1).toLowerCase();
  return (WHISPER_EXTENSIONS as readonly string[]).includes(extension)
    ? (extension as WhisperExtension)
    : null;
}

export type WhisperSegment = {
  start: number;
  end: number;
  text: string;
  avgLogprob: number | null;
  noSpeechProb: number | null;
  compressionRatio: number | null;
};

export type WhisperTranscript = {
  text: string;
  /** Lingua riconosciuta (Whisper la dà per nome, es. "italian"), o null. */
  language: string | null;
  durationSeconds: number | null;
  segments: WhisperSegment[];
};

export type WhisperErrorCode =
  | 'invalid_key'
  | 'no_credit'
  | 'rate_limited'
  | 'too_large'
  | 'rejected'
  | 'unavailable'
  | 'no_response'
  | 'invalid_response';

export type WhisperFailure = {
  ok: false;
  error: WhisperErrorCode;
  message: string;
  /**
   * true = la richiesta NON è arrivata a OpenAI (annullata prima dell'invio, host non risolto o
   * connessione rifiutata): nessun costo, chi chiama può restituire i limiti.
   */
  notSent?: true;
};

export type WhisperResult = { ok: true; transcript: WhisperTranscript } | WhisperFailure;

/** Messaggi italiani: mai il testo della risposta di OpenAI, mai la chiave. */
export const WHISPER_ERROR_MESSAGES: Record<WhisperErrorCode, string> = {
  invalid_key:
    'Trascrizione non riuscita: chiave OpenAI non valida (controlla OPENAI_API_KEY su Vercel).',
  no_credit:
    'Trascrizione non riuscita: crediti OpenAI esauriti o fatturazione non attiva (controlla Billing su platform.openai.com).',
  rate_limited: 'Trascrizione non riuscita: limite OpenAI raggiunto, riprova più tardi.',
  too_large: 'Trascrizione non riuscita: file troppo grande per OpenAI (al massimo 25 MB).',
  rejected:
    'Trascrizione non riuscita: OpenAI non ha accettato il file audio (formato non riconosciuto o file danneggiato).',
  unavailable:
    'Trascrizione non riuscita: OpenAI ha un problema in questo momento, riprova tra poco.',
  no_response: 'Trascrizione non riuscita: OpenAI non risponde, riprova tra poco.',
  invalid_response: 'Trascrizione non riuscita: la risposta di OpenAI non è nel formato atteso.',
};

function failure(error: WhisperErrorCode): WhisperFailure {
  return { ok: false, error, message: WHISPER_ERROR_MESSAGES[error] };
}

/** Errori di connessione che avvengono PRIMA di inviare la richiesta (DNS, porta chiusa). */
const NOT_SENT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function failedBeforeSending(error: unknown): boolean {
  const cause =
    error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === 'string' && NOT_SENT_CODES.has(cause.code);
}

const finiteNumber = z.number().finite();

const SegmentSchema = z
  .object({
    start: finiteNumber.nonnegative(),
    end: finiteNumber.nonnegative(),
    text: z.string().max(20_000),
    avg_logprob: finiteNumber.optional(),
    no_speech_prob: finiteNumber.optional(),
    compression_ratio: finiteNumber.optional(),
  })
  .passthrough();

const ResponseSchema = z
  .object({
    text: z.string().optional(),
    language: z.string().optional(),
    duration: finiteNumber.nonnegative().optional(),
    segments: z.array(z.unknown()).optional(),
  })
  .passthrough();

/** Nome della lingua come lo dà Whisper: minuscole, solo lettere, spazi e trattini, corto. */
function cleanLanguage(value: string | undefined): string | null {
  const language = value?.trim().toLowerCase() ?? '';
  return /^[\p{L} -]{2,40}$/u.test(language) ? language : null;
}

/** La risposta di verbose_json → trascrizione, o null se non è nel formato atteso. */
export function parseWhisperResponse(raw: unknown): WhisperTranscript | null {
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success || !Array.isArray(parsed.data.segments)) return null;
  const segments: WhisperSegment[] = [];
  for (const item of parsed.data.segments.slice(0, MAX_SEGMENTS)) {
    const segment = SegmentSchema.safeParse(item);
    if (!segment.success) continue;
    segments.push({
      start: segment.data.start,
      end: segment.data.end,
      text: segment.data.text,
      avgLogprob: segment.data.avg_logprob ?? null,
      noSpeechProb: segment.data.no_speech_prob ?? null,
      compressionRatio: segment.data.compression_ratio ?? null,
    });
  }
  return {
    text: parsed.data.text ?? '',
    language: cleanLanguage(parsed.data.language),
    durationSeconds: parsed.data.duration ?? null,
    segments,
  };
}

/** True se il corpo di un errore (letto solo qui, mai restituito) contiene uno dei motivi. */
async function bodyMentions(response: Response, pattern: RegExp): Promise<boolean> {
  try {
    if (!response.body) return false;
    const bytes = await readUpTo(response.body, 16 * 1024);
    return pattern.test(new TextDecoder().decode(bytes));
  } catch {
    return false;
  }
}

/** Il corpo di un 400 parla della dimensione del file. */
const SIZE_PATTERN = /too large|maximum content size|size limit|file size|26214400|25 ?mb/i;
/**
 * Il corpo di un 429 parla di crediti finiti o fatturazione (OpenAI: code "insufficient_quota"),
 * non di un vero limite di richieste.
 */
const QUOTA_PATTERN = /insufficient_quota|exceeded your current quota|billing/i;

async function errorFromStatus(response: Response): Promise<WhisperFailure> {
  const { status } = response;
  if (status === 401 || status === 403) return failure('invalid_key');
  if (status === 429) {
    return failure((await bodyMentions(response, QUOTA_PATTERN)) ? 'no_credit' : 'rate_limited');
  }
  if (status === 413) return failure('too_large');
  if (status === 400 || status === 415 || status === 422) {
    return failure((await bodyMentions(response, SIZE_PATTERN)) ? 'too_large' : 'rejected');
  }
  return failure(status >= 500 ? 'unavailable' : 'rejected');
}

function combinedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal | undefined {
  const timeout =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  if (!signal) return timeout;
  if (!timeout) return signal;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout;
}

export type WhisperRequest = {
  audio: Uint8Array;
  extension: WhisperExtension;
  language?: TranscriptionLanguage;
  apiKey: string;
  timeoutMs?: number;
  /** Interruzione dal chiamante (es. la richiesta dell'admin annullata). */
  signal?: AbortSignal;
  /** fetch da usare (il monitoraggio inietta il suo); predefinito: quello globale. */
  fetcher?: typeof fetch;
};

type WhisperPost =
  | { ok: true; response: Response; abort: AbortSignal | undefined }
  | WhisperFailure;

/**
 * La richiesta multipart a Whisper, fino alla risposta HTTP (o a un codice di errore). Chi chiama
 * legge il corpo di una risposta 2xx; ogni altro stato è già un codice con il messaggio italiano,
 * e il corpo è stato chiuso.
 */
async function postToWhisper({
  audio,
  extension,
  language,
  apiKey,
  timeoutMs = WHISPER_TIMEOUT_MS,
  signal,
  fetcher = fetch,
}: WhisperRequest): Promise<WhisperPost> {
  if (audio.length === 0) return failure('rejected');
  if (audio.length > TRANSCRIPTION_MAX_AUDIO_BYTES) return failure('too_large');

  const form = new FormData();
  // Copia in un ArrayBuffer proprio: il Blob non dipende dal buffer di chi chiama.
  const bytes = new Uint8Array(audio.length);
  bytes.set(audio);
  form.append(
    'file',
    new Blob([bytes.buffer], { type: MIME_TYPES[extension] }),
    `audio.${extension}`,
  );
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('temperature', '0');
  if (language) form.append('language', language);

  // Già annullata (l'admin ha premuto «Annulla»): la richiesta non parte nemmeno.
  if (signal?.aborted) return { ...failure('no_response'), notSent: true };
  const abort = combinedSignal(timeoutMs, signal);
  let response: Response;
  try {
    response = await fetcher(WHISPER_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: abort,
      cache: 'no-store',
    });
  } catch (error) {
    // Rete, DNS, scadenza o annullamento: nessun dettaglio (potrebbe contenere l'indirizzo).
    return failedBeforeSending(error)
      ? { ...failure('no_response'), notSent: true }
      : failure('no_response');
  }

  if (!response.ok) {
    const result = await errorFromStatus(response);
    await response.body?.cancel().catch(() => undefined);
    return result;
  }
  return { ok: true, response, abort };
}

/**
 * Trascrive l'audio con Whisper. Non fa mai throw: ogni problema (rete, scadenza, errore HTTP,
 * risposta non valida) diventa un codice con un messaggio italiano generico.
 */
export async function transcribeWithWhisper(request: WhisperRequest): Promise<WhisperResult> {
  const posted = await postToWhisper(request);
  if (!posted.ok) return posted;
  const { response, abort } = posted;

  try {
    if (!response.body) return failure('invalid_response');
    const body = await readUpTo(response.body, RESPONSE_MAX_BYTES + 1);
    if (body.length > RESPONSE_MAX_BYTES) return failure('invalid_response');
    const transcript = parseWhisperResponse(JSON.parse(new TextDecoder().decode(body)));
    return transcript ? { ok: true, transcript } : failure('invalid_response');
  } catch {
    // Corpo interrotto (scadenza) o JSON non valido.
    return failure(abort?.aborted ? 'no_response' : 'invalid_response');
  }
}

// ─── Verifica della chiave ───────────────────────────────────────────────────────────────────────

/** Durata del silenzio inviato come prova: Whisper accetta file da 0,1 s in su. */
export const PROBE_SECONDS = 1;
const PROBE_SAMPLE_RATE = 16_000;
/** Tempo massimo della prova (la route ha 30 secondi in tutto). */
export const PROBE_TIMEOUT_MS = 20_000;

/**
 * Un file WAV di solo silenzio (PCM 16 bit, mono, 16 kHz): 44 byte di intestazione e campioni a
 * zero. Generato qui, così la verifica non tocca nessun brano dello store.
 */
export function silentWav(seconds = PROBE_SECONDS, sampleRate = PROBE_SAMPLE_RATE): Uint8Array {
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const dataBytes = samples * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      bytes[offset + index] = text.charCodeAt(index);
    }
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // dimensione del blocco fmt
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte al secondo
  view.setUint16(32, 2, true); // byte per campione
  view.setUint16(34, 16, true); // bit per campione
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return bytes;
}

export type WhisperProbe = {
  apiKey: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** fetch da usare (il monitoraggio inietta il suo); predefinito: quello globale. */
  fetcher?: typeof fetch;
};

/** I messaggi di Whisper parlano di «Trascrizione non riuscita»: nella prova si è provata solo la chiave. */
export function probeMessage(message: string): string {
  const text = message.replace(/^Trascrizione non riuscita:\s*/i, '').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : message;
}

export type WhisperProbeResult =
  | { ok: true; model: typeof WHISPER_MODEL; elapsedMs: number }
  | (WhisperFailure & { elapsedMs: number });

/**
 * Prova la chiave con la stessa richiesta della trascrizione, su un secondo di silenzio: una
 * risposta 2xx vale come chiave funzionante (il testo riconosciuto non interessa e non si legge);
 * gli errori sono gli stessi codici della trascrizione (invalid_key, no_credit, rate_limited,
 * unavailable, no_response…). Mai throw, mai la chiave né il testo di OpenAI.
 */
export async function probeWhisper({
  apiKey,
  timeoutMs = PROBE_TIMEOUT_MS,
  signal,
  fetcher,
}: WhisperProbe): Promise<WhisperProbeResult> {
  const startedAt = Date.now();
  const posted = await postToWhisper({
    audio: silentWav(),
    extension: 'wav',
    apiKey,
    timeoutMs,
    signal,
    fetcher,
  });
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  if (!posted.ok) return { ...posted, elapsedMs };
  await posted.response.body?.cancel().catch(() => undefined);
  return { ok: true, model: WHISPER_MODEL, elapsedMs };
}
