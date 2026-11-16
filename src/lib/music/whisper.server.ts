// @polsia:user-owned — client minimo (fetch, senza SDK) dell'API di trascrizione in stile Whisper
// (OpenAI): il protocollo condiviso dai motori Groq, OpenAI, Fireworks e Mistral di «Solco AI»
// (transcription-provider.server.ts). Deepgram, ElevenLabs e Cloudflare hanno i loro moduli e
// riusano da qui tipi, codici d'errore, messaggi, la mappa degli stati HTTP e la lettura del corpo;
// il passaggio da un motore all'altro sta in transcription-engines.server.ts. Usato SOLO dalla
// trascrizione dei testi dei brani in evidenza dichiarati con "testo": true
// (lyrics-transcription.server.ts), dalla pagina admin. La chiave resta sul server: non finisce mai
// nei log né nei messaggi d'errore, e degli errori del servizio si restituisce solo un messaggio
// italiano generico, mai il testo della risposta.
//
// Richiesta: POST <endpoint>/audio/transcriptions, multipart/form-data con `file` (i byte
// dell'audio, nome "audio.<estensione originale>" così il formato si riconosce e il nome del brano
// non esce), `model`, `response_format` verbose_json, `timestamp_granularities[]` segment,
// `temperature` 0 e, se scelta, `language` (ISO-639-1).
// Risposta attesa: { text, language, duration, segments: [{ start, end, text, avg_logprob,
// no_speech_prob, compression_ratio, … }] }, letta con zod in modo tollerante (campi in più ok,
// segmenti malformati saltati). Groq e OpenAI rispondono nello stesso formato.
//
// Prova del motore (probeTranscription, pulsante «Verifica Solco AI» della pagina admin e
// monitoraggio): la stessa richiesta con un secondo di silenzio WAV generato qui (nessun brano,
// costo irrisorio). Dice se la chiave è valida, se i crediti sono finiti (429 con
// insufficient_quota → no_credit) o se il servizio non risponde, con gli stessi codici della
// trascrizione.
import 'server-only';
import { z } from 'zod';
import {
  type TranscriptionLanguage,
  WHISPER_EXTENSIONS,
  type WhisperExtension,
} from '@/lib/contracts/lyrics-transcription';
import { readUpTo } from '@/lib/music/featured-rights.server';
import {
  OPENAI_TARGET,
  type TranscriptionProvider,
  type TranscriptionTarget,
  transcriptionEngineLabel,
} from '@/lib/music/transcription-provider.server';

/** Endpoint e modello di OpenAI: il bersaglio predefinito del client (compatibilità). */
export const WHISPER_ENDPOINT = OPENAI_TARGET.endpoint;
export const WHISPER_MODEL = OPENAI_TARGET.model;
/** Tempo massimo di una trascrizione (la route ha 120 secondi in tutto). */
export const WHISPER_TIMEOUT_MS = 100_000;
/** Risposta del servizio letta al massimo (un brano di 25 MB ne produce molto meno). */
export const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
/** Segmenti letti al massimo. */
export const MAX_SEGMENTS = 5000;
/** Parole con tempo lette al massimo (un brano di 25 MB ne ha qualche migliaio). */
export const MAX_WORDS = 20_000;
/** Suggerimento al modello (titolo e artista) al massimo così lungo. */
export const MAX_PROMPT_CHARS = 400;

export const MIME_TYPES: Record<WhisperExtension, string> = {
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

/** Una parola con inizio e fine in secondi (timestamp_granularities[] word). */
export type WhisperWord = { start: number; end: number; text: string };

export type WhisperTranscript = {
  text: string;
  /** Lingua riconosciuta (Whisper la dà per nome, es. "italian"), o null. */
  language: string | null;
  durationSeconds: number | null;
  segments: WhisperSegment[];
  /** Parole con tempo, se chieste (wordTimestamps) e restituite; altrimenti vuoto. */
  words: WhisperWord[];
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
   * true = la richiesta NON è arrivata al servizio (annullata prima dell'invio, host non risolto o
   * connessione rifiutata): nessun costo, chi chiama può restituire i limiti.
   */
  notSent?: true;
  /** Stato HTTP della risposta del servizio, se ha risposto (es. 401): utile per la diagnosi. */
  status?: number;
};

export type WhisperResult = { ok: true; transcript: WhisperTranscript } | WhisperFailure;

export type MessageTarget = Pick<TranscriptionTarget, 'vendor' | 'envName' | 'billingHost'>;

/** Messaggi italiani per il servizio indicato: mai il testo della sua risposta, mai la chiave. */
export function whisperErrorMessage(code: WhisperErrorCode, target: MessageTarget): string {
  const { vendor, envName, billingHost } = target;
  switch (code) {
    case 'invalid_key':
      return `Trascrizione non riuscita: chiave ${vendor} non valida (controlla ${envName} su Vercel).`;
    case 'no_credit':
      return `Trascrizione non riuscita: crediti ${vendor} esauriti o fatturazione non attiva (controlla il piano su ${billingHost}).`;
    case 'rate_limited':
      return `Trascrizione non riuscita: limite ${vendor} raggiunto, riprova più tardi.`;
    case 'too_large':
      return `Trascrizione non riuscita: file troppo grande per ${vendor} (al massimo 25 MB).`;
    case 'rejected':
      return `Trascrizione non riuscita: ${vendor} non ha accettato il file audio (formato non riconosciuto o file danneggiato).`;
    case 'unavailable':
      return `Trascrizione non riuscita: ${vendor} ha un problema in questo momento, riprova tra poco.`;
    case 'no_response':
      return `Trascrizione non riuscita: ${vendor} non risponde, riprova tra poco.`;
    default:
      return `Trascrizione non riuscita: la risposta di ${vendor} non è nel formato atteso.`;
  }
}

const WHISPER_ERROR_CODES: readonly WhisperErrorCode[] = [
  'invalid_key',
  'no_credit',
  'rate_limited',
  'too_large',
  'rejected',
  'unavailable',
  'no_response',
  'invalid_response',
];

/** I messaggi per OpenAI (bersaglio predefinito del client). */
export const WHISPER_ERROR_MESSAGES: Record<WhisperErrorCode, string> = Object.fromEntries(
  WHISPER_ERROR_CODES.map((code) => [code, whisperErrorMessage(code, OPENAI_TARGET)]),
) as Record<WhisperErrorCode, string>;

export function failure(
  error: WhisperErrorCode,
  target: MessageTarget,
  status?: number,
): WhisperFailure {
  const result: WhisperFailure = { ok: false, error, message: whisperErrorMessage(error, target) };
  if (status !== undefined) result.status = status;
  return result;
}

/** Errori di connessione che avvengono PRIMA di inviare la richiesta (DNS, porta chiusa). */
const NOT_SENT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export function failedBeforeSending(error: unknown): boolean {
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

const WordSchema = z
  .object({
    word: z.string().max(200),
    start: finiteNumber.nonnegative(),
    end: finiteNumber.nonnegative(),
  })
  .passthrough();

const ResponseSchema = z
  .object({
    text: z.string().optional(),
    language: z.string().optional(),
    duration: finiteNumber.nonnegative().optional(),
    segments: z.array(z.unknown()).optional(),
    words: z.array(z.unknown()).optional(),
  })
  .passthrough();

/** Nome (o codice) della lingua come lo dà il servizio: minuscole, solo lettere, spazi e trattini. */
export function cleanLanguage(value: string | null | undefined): string | null {
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
  const words: WhisperWord[] = [];
  for (const item of (parsed.data.words ?? []).slice(0, MAX_WORDS)) {
    const word = WordSchema.safeParse(item);
    if (!word.success) continue;
    const text = word.data.word.trim();
    if (text === '') continue;
    words.push({ start: word.data.start, end: word.data.end, text });
  }
  return {
    text: parsed.data.text ?? '',
    language: cleanLanguage(parsed.data.language),
    durationSeconds: parsed.data.duration ?? null,
    segments,
    words,
  };
}

/** Una parola con tempo e, se il servizio la dà, la sua log-probabilità. */
export type TimedWordWithLogprob = WhisperWord & { logprob?: number };
/** Pausa fra due parole che apre una riga nuova. */
export const SEGMENT_GAP_SECONDS = 0.9;
/** Dopo un segno di fine frase basta una pausa più breve. */
export const SEGMENT_SENTENCE_GAP_SECONDS = 0.25;
/** Parole al massimo in una riga ricavata dalle parole. */
export const SEGMENT_MAX_WORDS = 16;

/**
 * Segmenti (righe) dalle sole parole con tempo, per i servizi che non li danno (ElevenLabs) o non
 * sempre (Deepgram): una riga nuova dopo una pausa di SEGMENT_GAP_SECONDS, dopo un segno di fine
 * frase seguito da una pausa più breve, o oltre SEGMENT_MAX_WORDS parole. avg_logprob = media delle
 * log-probabilità delle parole quando il servizio le dà, così le righe incerte funzionano uguale.
 */
export function segmentsFromWords(words: readonly TimedWordWithLogprob[]): WhisperSegment[] {
  const segments: WhisperSegment[] = [];
  let current: TimedWordWithLogprob[] = [];
  const flush = () => {
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) return;
    const logprobs = current
      .map((word) => word.logprob)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    segments.push({
      start: first.start,
      end: Math.max(first.start, last.end),
      text: current.map((word) => word.text).join(' '),
      avgLogprob:
        logprobs.length === current.length && logprobs.length > 0
          ? logprobs.reduce((sum, value) => sum + value, 0) / logprobs.length
          : null,
      noSpeechProb: null,
      compressionRatio: null,
    });
    current = [];
  };
  for (const word of words.slice(0, MAX_WORDS)) {
    const previous = current[current.length - 1];
    if (previous) {
      const gap = word.start - previous.end;
      const sentenceEnd = /[.!?…]$/.test(previous.text);
      if (
        gap >= SEGMENT_GAP_SECONDS ||
        (sentenceEnd && gap >= SEGMENT_SENTENCE_GAP_SECONDS) ||
        current.length >= SEGMENT_MAX_WORDS
      ) {
        flush();
      }
    }
    current.push(word);
    if (segments.length >= MAX_SEGMENTS) break;
  }
  flush();
  return segments;
}

/** True se il corpo di un errore (letto solo qui, mai restituito) contiene uno dei motivi. */
export async function bodyMentions(response: Response, pattern: RegExp): Promise<boolean> {
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
 * Il corpo di un 429 parla di crediti finiti o fatturazione (OpenAI: code "insufficient_quota",
 * "credit_balance_exhausted"), non di un vero limite di richieste.
 */
const QUOTA_PATTERN =
  /insufficient_quota|exceeded your current quota|credit_balance_exhausted|quota_exceeded|insufficient[ _]credits|billing/i;
/**
 * Il corpo di un 401/403 parla di quota o crediti finiti (ElevenLabs risponde 401 con
 * detail.status "quota_exceeded"): non è la chiave a essere sbagliata.
 */
const KEY_QUOTA_PATTERN =
  /quota_exceeded|insufficient[ _]credits|credit_balance_exhausted|payment required/i;

/** Lo stato HTTP di un errore → codice e messaggio italiano, uguali per tutti i motori. */
export async function errorFromStatus(
  response: Response,
  target: MessageTarget,
): Promise<WhisperFailure> {
  const { status } = response;
  if (status === 401 || status === 403) {
    return failure(
      (await bodyMentions(response, KEY_QUOTA_PATTERN)) ? 'no_credit' : 'invalid_key',
      target,
      status,
    );
  }
  if (status === 402) return failure('no_credit', target, status);
  if (status === 429) {
    return failure(
      (await bodyMentions(response, QUOTA_PATTERN)) ? 'no_credit' : 'rate_limited',
      target,
      status,
    );
  }
  if (status === 413) return failure('too_large', target, status);
  if (status === 400 || status === 415 || status === 422) {
    return failure(
      (await bodyMentions(response, SIZE_PATTERN)) ? 'too_large' : 'rejected',
      target,
      status,
    );
  }
  return failure(status >= 500 ? 'unavailable' : 'rejected', target, status);
}

export function combinedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal | undefined {
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
  /** Servizio, endpoint e modello; predefinito: OpenAI whisper-1 (compatibilità). */
  target?: TranscriptionTarget;
  /** Suggerimento al modello (titolo e artista: nomi scritti giusti). Mai il testo del brano. */
  prompt?: string;
  /** true = chiede anche i tempi delle singole parole (timestamp_granularities[] word). */
  wordTimestamps?: boolean;
  timeoutMs?: number;
  /** Interruzione dal chiamante (es. la richiesta dell'admin annullata). */
  signal?: AbortSignal;
  /** fetch da usare (il monitoraggio inietta il suo); predefinito: quello globale. */
  fetcher?: typeof fetch;
};

/** La richiesta a un motore qualunque: chiave ed endpoint li mette il motore (TranscriptionProvider). */
export type EngineRequest = Omit<WhisperRequest, 'apiKey' | 'target'>;

/** La risposta HTTP 2xx di un motore (corpo da leggere), oppure un errore già tradotto. */
export type WhisperPost =
  | { ok: true; response: Response; abort: AbortSignal | undefined }
  | WhisperFailure;

/**
 * La richiesta multipart al servizio, fino alla risposta HTTP (o a un codice di errore). Chi
 * chiama legge il corpo di una risposta 2xx; ogni altro stato è già un codice con il messaggio
 * italiano, e il corpo è stato chiuso.
 */
async function postToWhisper({
  audio,
  extension,
  language,
  apiKey,
  target = OPENAI_TARGET,
  prompt,
  wordTimestamps = false,
  timeoutMs = WHISPER_TIMEOUT_MS,
  signal,
  fetcher = fetch,
}: WhisperRequest): Promise<WhisperPost> {
  if (audio.length === 0) return failure('rejected', target);
  if (audio.length > target.maxAudioBytes) return failure('too_large', target);

  const form = new FormData();
  // Copia in un ArrayBuffer proprio: il Blob non dipende dal buffer di chi chiama.
  const bytes = new Uint8Array(audio.length);
  bytes.set(audio);
  form.append(
    'file',
    new Blob([bytes.buffer], { type: MIME_TYPES[extension] }),
    `audio.${extension}`,
  );
  form.append('model', target.model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  // Solo i servizi che danno i tempi delle parole (Mistral no: la bozza esce riga per riga).
  if (wordTimestamps && target.wordTimestamps) form.append('timestamp_granularities[]', 'word');
  form.append('temperature', '0');
  if (language) form.append('language', language);
  const hint = prompt?.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_CHARS);
  if (hint) form.append('prompt', hint);

  // Già annullata (l'admin ha premuto «Annulla»): la richiesta non parte nemmeno.
  if (signal?.aborted) return { ...failure('no_response', target), notSent: true };
  const abort = combinedSignal(timeoutMs, signal);
  let response: Response;
  try {
    response = await fetcher(target.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: abort,
      cache: 'no-store',
    });
  } catch (error) {
    // Rete, DNS, scadenza o annullamento: nessun dettaglio (potrebbe contenere l'indirizzo).
    return failedBeforeSending(error)
      ? { ...failure('no_response', target), notSent: true }
      : failure('no_response', target);
  }

  if (!response.ok) {
    const result = await errorFromStatus(response, target);
    await response.body?.cancel().catch(() => undefined);
    return result;
  }
  return { ok: true, response, abort };
}

/**
 * Trascrive l'audio. Non fa mai throw: ogni problema (rete, scadenza, errore HTTP, risposta non
 * valida) diventa un codice con un messaggio italiano generico.
 */
export async function transcribeWithWhisper(request: WhisperRequest): Promise<WhisperResult> {
  const target = request.target ?? OPENAI_TARGET;
  const posted = await postToWhisper(request);
  if (!posted.ok) return posted;
  return readJsonTranscript(posted, target, parseWhisperResponse);
}

/**
 * Legge il corpo JSON di una risposta 2xx (al massimo RESPONSE_MAX_BYTES) e lo traduce con `parse`
 * (il formato del motore): ogni problema (corpo interrotto, JSON non valido, formato inatteso) è un
 * codice con il messaggio italiano, mai un throw. Condiviso da tutti i motori.
 */
export async function readJsonTranscript(
  posted: Extract<WhisperPost, { ok: true }>,
  target: MessageTarget,
  parse: (raw: unknown) => WhisperTranscript | null,
): Promise<WhisperResult> {
  const { response, abort } = posted;
  try {
    if (!response.body) return failure('invalid_response', target);
    const body = await readUpTo(response.body, RESPONSE_MAX_BYTES + 1);
    if (body.length > RESPONSE_MAX_BYTES) return failure('invalid_response', target);
    const transcript = parse(JSON.parse(new TextDecoder().decode(body)));
    return transcript ? { ok: true, transcript } : failure('invalid_response', target);
  } catch {
    // Corpo interrotto (scadenza) o JSON non valido.
    return failure(abort?.aborted ? 'no_response' : 'invalid_response', target);
  }
}

// ─── Prova del motore ────────────────────────────────────────────────────────────────────────────

/** Durata del silenzio inviato come prova: Whisper accetta file da 0,1 s in su. */
export const PROBE_SECONDS = 1;
const PROBE_SAMPLE_RATE = 16_000;
/** Tempo massimo della prova (la route ha 30 secondi in tutto). */
export const PROBE_TIMEOUT_MS = 20_000;

/**
 * Un file WAV di solo silenzio (PCM 16 bit, mono, 16 kHz): 44 byte di intestazione e campioni a
 * zero. Generato qui, così la prova non tocca nessun brano dello store.
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

export type TranscriptionProbe = {
  provider: TranscriptionProvider;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** fetch da usare (il monitoraggio inietta il suo); predefinito: quello globale. */
  fetcher?: typeof fetch;
};

/** I messaggi parlano di «Trascrizione non riuscita»: nella prova si è provata solo la chiave. */
export function probeMessage(message: string): string {
  const text = message.replace(/^Trascrizione non riuscita:\s*/i, '').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : message;
}

export type WhisperProbeResult =
  | { ok: true; model: string; engine: string; elapsedMs: number }
  | (WhisperFailure & { elapsedMs: number });

/**
 * Prova il motore con la stessa richiesta della trascrizione, su un secondo di silenzio: una
 * risposta 2xx vale come chiave funzionante (il testo riconosciuto non interessa e non si legge);
 * gli errori sono gli stessi codici della trascrizione (invalid_key, no_credit, rate_limited,
 * unavailable, no_response…). Mai throw, mai la chiave né il testo della risposta.
 */
export async function probeTranscription({
  provider,
  timeoutMs = PROBE_TIMEOUT_MS,
  signal,
  fetcher,
}: TranscriptionProbe): Promise<WhisperProbeResult> {
  const startedAt = Date.now();
  const posted = await postToWhisper({
    audio: silentWav(),
    extension: 'wav',
    apiKey: provider.apiKey,
    target: provider,
    timeoutMs,
    signal,
    fetcher,
  });
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  if (!posted.ok) return { ...posted, elapsedMs };
  await posted.response.body?.cancel().catch(() => undefined);
  return {
    ok: true,
    model: provider.model,
    engine: transcriptionEngineLabel(provider),
    elapsedMs,
  };
}
