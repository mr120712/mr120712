// @polsia:user-owned — motore Cloudflare Workers AI di «Solco AI» (@cf/openai/whisper-large-v3-turbo,
// con una quota gratuita giornaliera). Richiesta: POST https://api.cloudflare.com/client/v4/accounts/
// <account>/ai/run/@cf/openai/whisper-large-v3-turbo, JSON { audio: <base64>, task: "transcribe",
// vad_filter: false, language?, initial_prompt? }, intestazione "Authorization: Bearer <token>".
// Risposta: { success, result: { text, transcription_info: { language, duration }, segments:
// [{ start, end, text, avg_logprob, compression_ratio, no_speech_prob, words: [{ word, start,
// end }] }] }, errors }: lo stesso formato di Whisper, con le parole dentro i segmenti, quindi si
// rimette nella forma verbose_json e si legge con il parser comune. Errori: Cloudflare risponde 400
// con errors[].code 10000 anche a un token non valido (→ chiave non valida); per il resto la mappa
// comune (403 chiave, 429 quota o limite, 5xx servizio). Mai il token né il testo della risposta.
import 'server-only';
import { z } from 'zod';
import type { TranscriptionProvider } from '@/lib/music/transcription-provider.server';
import {
  bodyMentions,
  combinedSignal,
  type EngineRequest,
  errorFromStatus,
  failedBeforeSending,
  failure,
  MAX_PROMPT_CHARS,
  MAX_SEGMENTS,
  parseWhisperResponse,
  readJsonTranscript,
  WHISPER_TIMEOUT_MS,
  type WhisperFailure,
  type WhisperPost,
  type WhisperResult,
  type WhisperTranscript,
} from '@/lib/music/whisper.server';

const finiteNumber = z.number().finite();

const ResultSchema = z
  .object({
    text: z.string().optional(),
    transcription_info: z
      .object({
        language: z.string().optional(),
        duration: finiteNumber.nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    segments: z.array(z.unknown()).optional(),
  })
  .passthrough();

const EnvelopeSchema = z
  .object({
    success: z.boolean().optional(),
    result: z.unknown().optional(),
    errors: z.array(z.unknown()).optional(),
  })
  .passthrough();

/** Le parole dentro i segmenti di Workers AI, in un solo elenco (forma verbose_json di Whisper). */
function wordsOf(segments: readonly unknown[]): unknown[] {
  const words: unknown[] = [];
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') continue;
    const inner = (segment as { words?: unknown }).words;
    if (Array.isArray(inner)) words.push(...inner);
  }
  return words;
}

/** La risposta di Workers AI → trascrizione comune, o null se non è nel formato atteso. */
export function parseCloudflareResponse(raw: unknown): WhisperTranscript | null {
  const envelope = EnvelopeSchema.safeParse(raw);
  if (!envelope.success || envelope.data.success === false) return null;
  const result = ResultSchema.safeParse(envelope.data.result);
  if (!result.success) return null;
  const segments = (result.data.segments ?? []).slice(0, MAX_SEGMENTS);
  return parseWhisperResponse({
    text: result.data.text,
    language: result.data.transcription_info?.language,
    duration: result.data.transcription_info?.duration,
    segments,
    words: wordsOf(segments),
  });
}

/** Un 400 di Cloudflare può essere un token non valido (code 10000) o un audio rifiutato. */
const AUTH_PATTERN = /authentication|"code"\s*:\s*10000|invalid[^"]{0,40}token|unauthorized/i;

async function cloudflareError(
  response: Response,
  target: TranscriptionProvider,
): Promise<WhisperFailure> {
  if (response.status === 400) {
    const auth = await bodyMentions(response, AUTH_PATTERN);
    return failure(auth ? 'invalid_key' : 'rejected', target, 400);
  }
  return errorFromStatus(response, target);
}

/** La richiesta a Workers AI fino alla risposta HTTP (o a un codice di errore). Mai throw. */
export async function postToCloudflare(
  provider: TranscriptionProvider,
  {
    audio,
    language,
    prompt,
    timeoutMs = WHISPER_TIMEOUT_MS,
    signal,
    fetcher = fetch,
  }: EngineRequest,
): Promise<WhisperPost> {
  if (audio.length === 0) return failure('rejected', provider);
  if (audio.length > provider.maxAudioBytes) return failure('too_large', provider);
  if (signal?.aborted) return { ...failure('no_response', provider), notSent: true };
  const hint = prompt?.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_CHARS);
  const body = JSON.stringify({
    audio: Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength).toString('base64'),
    task: 'transcribe',
    vad_filter: false,
    ...(language ? { language } : {}),
    ...(hint ? { initial_prompt: hint } : {}),
  });
  const abort = combinedSignal(timeoutMs, signal);
  let response: Response;
  try {
    response = await fetcher(provider.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        'content-type': 'application/json',
      },
      body,
      signal: abort,
      cache: 'no-store',
    });
  } catch (error) {
    return failedBeforeSending(error)
      ? { ...failure('no_response', provider), notSent: true }
      : failure('no_response', provider);
  }
  if (!response.ok) {
    const result = await cloudflareError(response, provider);
    await response.body?.cancel().catch(() => undefined);
    return result;
  }
  return { ok: true, response, abort };
}

/** Trascrive con Cloudflare Workers AI. Mai throw. */
export async function transcribeWithCloudflare(
  provider: TranscriptionProvider,
  request: EngineRequest,
): Promise<WhisperResult> {
  const posted = await postToCloudflare(provider, request);
  if (!posted.ok) return posted;
  return readJsonTranscript(posted, provider, parseCloudflareResponse);
}
