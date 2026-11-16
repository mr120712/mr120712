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
// Account: CLOUDFLARE_ACCOUNT_ID se c'è; altrimenti il primo account che GET /accounts elenca per il
// token, ricordato per il processo (impronta del token come chiave, mai il token).
import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readUpTo } from '@/lib/music/featured-rights.server';
import {
  cloudflareEndpoint,
  type TranscriptionProvider,
} from '@/lib/music/transcription-provider.server';
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

/** Dove Cloudflare elenca gli account a cui il token ha accesso. */
export const CLOUDFLARE_ACCOUNTS_URL = 'https://api.cloudflare.com/client/v4/accounts?per_page=5';
/** Tempo massimo per chiedere l'elenco degli account. */
const ACCOUNT_LOOKUP_TIMEOUT_MS = 10_000;
/** Risposta dell'elenco degli account letta al massimo. */
const ACCOUNTS_MAX_BYTES = 64 * 1024;

const AccountsSchema = z
  .object({
    success: z.boolean().optional(),
    result: z.array(z.object({ id: z.string().min(8).max(64) }).passthrough()).optional(),
  })
  .passthrough();

/** Account già scoperti, per processo: chiave = impronta del token (mai il token). */
const knownAccounts = new Map<string, string>();

function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Solo per i test: dimentica gli account scoperti. */
export function forgetCloudflareAccountsForTests(): void {
  knownAccounts.clear();
}

export type CloudflareAccount = { ok: true; accountId: string } | WhisperFailure;

/**
 * L'account su cui eseguire Workers AI: CLOUDFLARE_ACCOUNT_ID se c'è, altrimenti il primo account
 * che Cloudflare elenca per questo token, ricordato per il processo. Un token rifiutato o senza
 * accesso a nessun account vale come chiave non valida. Mai throw, mai il token.
 */
export async function cloudflareAccount(
  provider: TranscriptionProvider,
  {
    timeoutMs = WHISPER_TIMEOUT_MS,
    signal,
    fetcher = fetch,
  }: Pick<EngineRequest, 'timeoutMs' | 'signal' | 'fetcher'>,
): Promise<CloudflareAccount> {
  if (provider.accountId) return { ok: true, accountId: provider.accountId };
  const fingerprint = tokenFingerprint(provider.apiKey);
  const known = knownAccounts.get(fingerprint);
  if (known) return { ok: true, accountId: known };
  let response: Response;
  try {
    response = await fetcher(CLOUDFLARE_ACCOUNTS_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${provider.apiKey}` },
      signal: combinedSignal(Math.min(timeoutMs, ACCOUNT_LOOKUP_TIMEOUT_MS), signal),
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
  try {
    if (!response.body) return failure('invalid_response', provider);
    const bytes = await readUpTo(response.body, ACCOUNTS_MAX_BYTES);
    const parsed = AccountsSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    const accountId = parsed.success ? parsed.data.result?.[0]?.id : undefined;
    if (!accountId) return failure('invalid_key', provider, response.status);
    knownAccounts.set(fingerprint, accountId);
    return { ok: true, accountId };
  } catch {
    return failure('invalid_response', provider);
  }
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
  const account = await cloudflareAccount(provider, { timeoutMs, signal, fetcher });
  if (!account.ok) return account;
  const abort = combinedSignal(timeoutMs, signal);
  let response: Response;
  try {
    response = await fetcher(cloudflareEndpoint(account.accountId), {
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
