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

/** True se il corpo di un 400 parla della dimensione del file (letto solo qui, mai restituito). */
async function mentionsSize(response: Response): Promise<boolean> {
  try {
    if (!response.body) return false;
    const bytes = await readUpTo(response.body, 16 * 1024);
    return /too large|maximum content size|size limit|file size|26214400|25 ?mb/i.test(
      new TextDecoder().decode(bytes),
    );
  } catch {
    return false;
  }
}

async function errorFromStatus(response: Response): Promise<WhisperResult> {
  const { status } = response;
  if (status === 401 || status === 403) return failure('invalid_key');
  if (status === 429) return failure('rate_limited');
  if (status === 413) return failure('too_large');
  if (status === 400 || status === 415 || status === 422) {
    return failure((await mentionsSize(response)) ? 'too_large' : 'rejected');
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
};

/**
 * Trascrive l'audio con Whisper. Non fa mai throw: ogni problema (rete, scadenza, errore HTTP,
 * risposta non valida) diventa un codice con un messaggio italiano generico.
 */
export async function transcribeWithWhisper({
  audio,
  extension,
  language,
  apiKey,
  timeoutMs = WHISPER_TIMEOUT_MS,
  signal,
}: WhisperRequest): Promise<WhisperResult> {
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
    response = await fetch(WHISPER_ENDPOINT, {
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
