// @polsia:user-owned — motore ElevenLabs di «Solco AI» (Scribe v1): protocollo suo. Richiesta: POST
// https://api.elevenlabs.io/v1/speech-to-text, multipart con `file` (i byte dell'audio, nome
// "audio.<estensione>"), `model_id`, `timestamps_granularity` word, `tag_audio_events` false,
// `diarize` false e, se scelta, `language_code`; intestazione "xi-api-key". Risposta:
// { language_code (ISO-639-3, es. "ita"), text, words: [{ text, start, end, type: word|spacing|
// audio_event, logprob? }] }: le parole diventano la trascrizione comune e i segmenti (righe) si
// ricavano dalle pause e dalla punteggiatura (segmentsFromWords). Errori: stessi codici e messaggi
// degli altri motori; ElevenLabs risponde 401 anche a quota finita (detail.status
// "quota_exceeded") e la mappa comune lo riconosce come crediti finiti. Mai la chiave né il testo.
import 'server-only';
import { z } from 'zod';
import type { TranscriptionProvider } from '@/lib/music/transcription-provider.server';
import {
  cleanLanguage,
  combinedSignal,
  type EngineRequest,
  errorFromStatus,
  failedBeforeSending,
  failure,
  MAX_WORDS,
  MIME_TYPES,
  readJsonTranscript,
  segmentsFromWords,
  type TimedWordWithLogprob,
  WHISPER_TIMEOUT_MS,
  type WhisperPost,
  type WhisperResult,
  type WhisperTranscript,
} from '@/lib/music/whisper.server';

/** Codici ISO-639-3 di ElevenLabs → ISO-639-1 (quelli che il player sa mostrare per nome). */
const ISO3_TO_ISO1: Readonly<Record<string, string>> = {
  ita: 'it',
  eng: 'en',
  spa: 'es',
  fra: 'fr',
  deu: 'de',
  por: 'pt',
  nld: 'nl',
  pol: 'pl',
  rus: 'ru',
  ukr: 'uk',
  tur: 'tr',
  ell: 'el',
  swe: 'sv',
  dan: 'da',
  nor: 'no',
  fin: 'fi',
  ces: 'cs',
  hun: 'hu',
  ron: 'ro',
  cat: 'ca',
  jpn: 'ja',
  zho: 'zh',
  cmn: 'zh',
  kor: 'ko',
  ara: 'ar',
  heb: 'he',
  hin: 'hi',
  ind: 'id',
  vie: 'vi',
  tha: 'th',
};

/** La lingua di ElevenLabs ("ita") nel codice che il player conosce ("it"), o null. */
export function elevenLabsLanguage(code: string | undefined): string | null {
  const value = code?.trim().toLowerCase() ?? '';
  if (!value) return null;
  return cleanLanguage(ISO3_TO_ISO1[value] ?? value);
}

const finiteNumber = z.number().finite();

const WordSchema = z
  .object({
    text: z.string().max(200),
    start: finiteNumber.nonnegative(),
    end: finiteNumber.nonnegative(),
    type: z.string().max(40).optional(),
    logprob: finiteNumber.optional(),
  })
  .passthrough();

const ResponseSchema = z
  .object({
    language_code: z.string().optional(),
    text: z.string().optional(),
    words: z.array(z.unknown()).optional(),
  })
  .passthrough();

/** La risposta di Scribe → trascrizione comune, o null se non è nel formato atteso. */
export function parseElevenLabsResponse(raw: unknown): WhisperTranscript | null {
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success || !Array.isArray(parsed.data.words)) return null;
  const words: TimedWordWithLogprob[] = [];
  for (const item of parsed.data.words.slice(0, MAX_WORDS)) {
    const word = WordSchema.safeParse(item);
    if (!word.success) continue;
    // Spazi ed eventi sonori (risate, musica) non sono parole.
    if ((word.data.type ?? 'word') !== 'word') continue;
    const text = word.data.text.trim();
    if (text === '') continue;
    const timed: TimedWordWithLogprob = { start: word.data.start, end: word.data.end, text };
    if (word.data.logprob !== undefined) timed.logprob = word.data.logprob;
    words.push(timed);
  }
  const last = words[words.length - 1];
  return {
    text: parsed.data.text ?? '',
    language: elevenLabsLanguage(parsed.data.language_code),
    durationSeconds: last ? last.end : null,
    segments: segmentsFromWords(words),
    words: words.map(({ start, end, text }) => ({ start, end, text })),
  };
}

/** La richiesta a ElevenLabs fino alla risposta HTTP (o a un codice di errore). Mai throw. */
export async function postToElevenLabs(
  provider: TranscriptionProvider,
  {
    audio,
    extension,
    language,
    timeoutMs = WHISPER_TIMEOUT_MS,
    signal,
    fetcher = fetch,
  }: EngineRequest,
): Promise<WhisperPost> {
  if (audio.length === 0) return failure('rejected', provider);
  if (audio.length > provider.maxAudioBytes) return failure('too_large', provider);
  if (signal?.aborted) return { ...failure('no_response', provider), notSent: true };
  const bytes = new Uint8Array(audio.length);
  bytes.set(audio);
  const form = new FormData();
  form.append(
    'file',
    new Blob([bytes.buffer], { type: MIME_TYPES[extension] }),
    `audio.${extension}`,
  );
  form.append('model_id', provider.model);
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'false');
  form.append('diarize', 'false');
  if (language) form.append('language_code', language);
  const abort = combinedSignal(timeoutMs, signal);
  let response: Response;
  try {
    response = await fetcher(provider.endpoint, {
      method: 'POST',
      headers: { 'xi-api-key': provider.apiKey },
      body: form,
      signal: abort,
      cache: 'no-store',
    });
  } catch (error) {
    return failedBeforeSending(error)
      ? { ...failure('no_response', provider), notSent: true }
      : failure('no_response', provider);
  }
  if (!response.ok) {
    const result = await errorFromStatus(response, provider);
    await response.body?.cancel().catch(() => undefined);
    return result;
  }
  return { ok: true, response, abort };
}

/** Trascrive con ElevenLabs Scribe. Mai throw. */
export async function transcribeWithElevenLabs(
  provider: TranscriptionProvider,
  request: EngineRequest,
): Promise<WhisperResult> {
  const posted = await postToElevenLabs(provider, request);
  if (!posted.ok) return posted;
  return readJsonTranscript(posted, provider, parseElevenLabsResponse);
}
