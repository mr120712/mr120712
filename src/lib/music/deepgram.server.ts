// @polsia:user-owned — motore Deepgram di «Solco AI» (modello nova-3): protocollo suo, non in stile
// OpenAI. Richiesta: POST https://api.deepgram.com/v1/listen?model=…&smart_format=true&punctuate=true
// &utterances=true più language=xx (lingua scelta) oppure detect_language=true, intestazione
// "Authorization: Token <chiave>", corpo = i byte dell'audio con il suo content-type (nessun nome
// di file: il titolo del brano non esce). Risposta: results.channels[0].alternatives[0] (transcript,
// words con start/end/confidence/punctuated_word), results.utterances (segmenti con start/end/
// transcript/confidence), metadata.duration, channels[0].detected_language. Si traduce nella
// trascrizione comune (segmenti + parole); la confidenza diventa un avg_logprob approssimato (ln),
// così le righe incerte della bozza funzionano uguale. Errori: stessi codici e messaggi degli altri
// motori (401/403 chiave, 402 crediti, 429 limite, 413 dimensione…), mai la chiave né il testo
// della risposta.
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
  MAX_SEGMENTS,
  MAX_WORDS,
  MIME_TYPES,
  readJsonTranscript,
  segmentsFromWords,
  WHISPER_TIMEOUT_MS,
  type WhisperPost,
  type WhisperResult,
  type WhisperSegment,
  type WhisperTranscript,
  type WhisperWord,
} from '@/lib/music/whisper.server';

const finiteNumber = z.number().finite();

const WordSchema = z
  .object({
    word: z.string().max(200),
    start: finiteNumber.nonnegative(),
    end: finiteNumber.nonnegative(),
    confidence: finiteNumber.optional(),
    punctuated_word: z.string().max(200).optional(),
  })
  .passthrough();

const UtteranceSchema = z
  .object({
    start: finiteNumber.nonnegative(),
    end: finiteNumber.nonnegative(),
    transcript: z.string().max(20_000),
    confidence: finiteNumber.optional(),
  })
  .passthrough();

const ResponseSchema = z
  .object({
    metadata: z
      .object({ duration: finiteNumber.nonnegative().optional() })
      .passthrough()
      .optional(),
    results: z
      .object({
        channels: z
          .array(
            z
              .object({
                detected_language: z.string().optional(),
                alternatives: z
                  .array(
                    z
                      .object({
                        transcript: z.string().optional(),
                        words: z.array(z.unknown()).optional(),
                      })
                      .passthrough(),
                  )
                  .optional(),
              })
              .passthrough(),
          )
          .optional(),
        utterances: z.array(z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Confidenza (0-1) → log-probabilità approssimata, così le righe incerte usano la stessa soglia. */
export function logprobFromConfidence(confidence: number | undefined): number | null {
  if (confidence === undefined || !Number.isFinite(confidence)) return null;
  return Math.log(Math.min(1, Math.max(1e-6, confidence)));
}

/** L'indirizzo della richiesta: modello, punteggiatura, segmenti e lingua (scelta o riconosciuta). */
export function deepgramUrl(
  provider: Pick<TranscriptionProvider, 'endpoint' | 'model'>,
  language?: string,
): string {
  const url = new URL(provider.endpoint);
  url.searchParams.set('model', provider.model);
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('utterances', 'true');
  if (language) url.searchParams.set('language', language);
  else url.searchParams.set('detect_language', 'true');
  return url.toString();
}

/** La risposta di Deepgram → trascrizione comune, o null se non è nel formato atteso. */
export function parseDeepgramResponse(raw: unknown): WhisperTranscript | null {
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const channel = parsed.data.results?.channels?.[0];
  const alternative = channel?.alternatives?.[0];
  if (!alternative) return null;
  const words: WhisperWord[] = [];
  for (const item of (alternative.words ?? []).slice(0, MAX_WORDS)) {
    const word = WordSchema.safeParse(item);
    if (!word.success) continue;
    const text = (word.data.punctuated_word ?? word.data.word).trim();
    if (text !== '') words.push({ start: word.data.start, end: word.data.end, text });
  }
  const segments: WhisperSegment[] = [];
  for (const item of (parsed.data.results?.utterances ?? []).slice(0, MAX_SEGMENTS)) {
    const utterance = UtteranceSchema.safeParse(item);
    if (!utterance.success) continue;
    segments.push({
      start: utterance.data.start,
      end: utterance.data.end,
      text: utterance.data.transcript,
      avgLogprob: logprobFromConfidence(utterance.data.confidence),
      noSpeechProb: null,
      compressionRatio: null,
    });
  }
  return {
    text: alternative.transcript ?? '',
    language: cleanLanguage(channel?.detected_language),
    durationSeconds: parsed.data.metadata?.duration ?? null,
    segments: segments.length > 0 ? segments : segmentsFromWords(words),
    words,
  };
}

/** La richiesta a Deepgram fino alla risposta HTTP (o a un codice di errore). Mai throw. */
export async function postToDeepgram(
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
  const abort = combinedSignal(timeoutMs, signal);
  let response: Response;
  try {
    response = await fetcher(deepgramUrl(provider, language), {
      method: 'POST',
      headers: {
        authorization: `Token ${provider.apiKey}`,
        'content-type': MIME_TYPES[extension],
      },
      body: bytes,
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

/** Trascrive con Deepgram. Mai throw. */
export async function transcribeWithDeepgram(
  provider: TranscriptionProvider,
  request: EngineRequest,
): Promise<WhisperResult> {
  const posted = await postToDeepgram(provider, request);
  if (!posted.ok) return posted;
  return readJsonTranscript(posted, provider, parseDeepgramResponse);
}
