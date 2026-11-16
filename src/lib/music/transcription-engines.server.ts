// @polsia:user-owned — «Solco AI» con più motori: la richiesta giusta per il protocollo di ogni
// motore (transcribeWithProvider), la prova con un secondo di silenzio per qualunque motore
// (probeProvider) e il PASSAGGIO AUTOMATICO (transcribeWithFailover): i motori configurati si
// provano nell'ordine scelto (transcription-provider.server.ts) e si passa al successivo quando uno
// rifiuta la chiave, non ha crediti, limita le richieste, è giù, non risponde o risponde in un
// formato strano. Non si passa oltre quando il problema è l'audio stesso (troppo grande o rifiutato
// dal servizio): sarebbe uguale per tutti. Un passaggio parte solo se restano almeno
// FAILOVER_MIN_ATTEMPT_MS prima della scadenza della richiesta, e mai dopo un annullamento
// dell'admin. L'esito dice quale motore ha trascritto; quando falliscono tutti, il messaggio elenca
// il motivo di ciascuno (senza chiavi né testi delle risposte) e il codice è quello del primo.
import 'server-only';
import { postToCloudflare, transcribeWithCloudflare } from '@/lib/music/cloudflare-ai.server';
import { postToDeepgram, transcribeWithDeepgram } from '@/lib/music/deepgram.server';
import { postToElevenLabs, transcribeWithElevenLabs } from '@/lib/music/elevenlabs.server';
import {
  type TranscriptionProvider,
  transcriptionEngineLabel,
} from '@/lib/music/transcription-provider.server';
import {
  type EngineRequest,
  PROBE_TIMEOUT_MS,
  probeMessage,
  probeTranscription,
  silentWav,
  transcribeWithWhisper,
  WHISPER_TIMEOUT_MS,
  type WhisperErrorCode,
  type WhisperFailure,
  type WhisperProbeResult,
  type WhisperResult,
  type WhisperTranscript,
} from '@/lib/music/whisper.server';

/** Sotto questo tempo residuo non si passa a un altro motore (non farebbe in tempo). */
export const FAILOVER_MIN_ATTEMPT_MS = 15_000;

/** Trascrive con il motore indicato, col protocollo giusto. Mai throw. */
export function transcribeWithProvider(
  provider: TranscriptionProvider,
  request: EngineRequest,
): Promise<WhisperResult> {
  switch (provider.protocol) {
    case 'deepgram':
      return transcribeWithDeepgram(provider, request);
    case 'elevenlabs':
      return transcribeWithElevenLabs(provider, request);
    case 'cloudflare':
      return transcribeWithCloudflare(provider, request);
    default:
      return transcribeWithWhisper({ ...request, apiKey: provider.apiKey, target: provider });
  }
}

export type ProviderProbeOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** fetch da usare (il monitoraggio inietta il suo); predefinito: quello globale. */
  fetcher?: typeof fetch;
};

/**
 * Prova il motore con un secondo di silenzio generato sul server (nessun brano, costo irrisorio):
 * una risposta 2xx vale come chiave funzionante, il corpo non si legge; gli errori hanno i codici
 * della trascrizione. Mai throw, mai la chiave.
 */
export async function probeProvider(
  provider: TranscriptionProvider,
  { timeoutMs = PROBE_TIMEOUT_MS, signal, fetcher }: ProviderProbeOptions = {},
): Promise<WhisperProbeResult> {
  if (provider.protocol === 'openai') {
    return probeTranscription({ provider, timeoutMs, signal, fetcher });
  }
  const post =
    provider.protocol === 'deepgram'
      ? postToDeepgram
      : provider.protocol === 'elevenlabs'
        ? postToElevenLabs
        : postToCloudflare;
  const startedAt = Date.now();
  const posted = await post(provider, {
    audio: silentWav(),
    extension: 'wav',
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

/** True se dopo questo errore ha senso provare un altro motore (il problema non è l'audio). */
export function failsOver(code: WhisperErrorCode): boolean {
  return code !== 'too_large' && code !== 'rejected';
}

/** Il motore di un tentativo fallito, SENZA la chiave: il risultato può finire in un log o in un test. */
export type AttemptedProvider = Pick<TranscriptionProvider, 'id' | 'vendor' | 'label' | 'model'>;

export type FailoverAttempt = {
  provider: AttemptedProvider;
  failure: WhisperFailure;
  elapsedMs: number;
};

function attemptedProvider(provider: TranscriptionProvider): AttemptedProvider {
  return { id: provider.id, vendor: provider.vendor, label: provider.label, model: provider.model };
}

export type FailoverResult =
  | {
      ok: true;
      transcript: WhisperTranscript;
      /** Il motore che ha trascritto. */
      provider: TranscriptionProvider;
      /** I motori provati prima, falliti. */
      attempts: FailoverAttempt[];
    }
  | { ok: false; failure: WhisperFailure; attempts: FailoverAttempt[] };

export type FailoverOptions = {
  /** Istante (ms, Date.now) entro cui la trascrizione deve finire; senza, nessun tetto. */
  deadline?: number;
};

function lowerFirst(text: string): string {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/** Un solo motore: il suo errore. Più motori: il codice del primo, i motivi di tutti. */
export function combinedFailure(attempts: readonly FailoverAttempt[]): WhisperFailure {
  const first = attempts[0];
  if (!first) {
    return {
      ok: false,
      error: 'unavailable',
      message: 'Trascrizione non riuscita: nessun motore disponibile.',
    };
  }
  if (attempts.length === 1) return first.failure;
  const reasons = attempts
    .map(
      (attempt) =>
        `${attempt.provider.vendor}: ${lowerFirst(probeMessage(attempt.failure.message)).replace(/\.$/, '')}`,
    )
    .join('; ');
  const result: WhisperFailure = {
    ok: false,
    error: first.failure.error,
    message: `Trascrizione non riuscita con tutti i motori (${reasons}).`,
  };
  if (attempts.every((attempt) => attempt.failure.notSent)) result.notSent = true;
  if (first.failure.status !== undefined) result.status = first.failure.status;
  return result;
}

/**
 * Trascrive con il primo motore che riesce, nell'ordine dato. Ogni tentativo ha al massimo il tempo
 * residuo prima della scadenza; dopo un errore che non dipende dall'audio si passa al motore dopo,
 * se c'è e se resta tempo. Mai throw.
 */
export async function transcribeWithFailover(
  providers: readonly TranscriptionProvider[],
  request: EngineRequest,
  { deadline }: FailoverOptions = {},
): Promise<FailoverResult> {
  const attempts: FailoverAttempt[] = [];
  for (const [index, provider] of providers.entries()) {
    const remaining = deadline === undefined ? Number.POSITIVE_INFINITY : deadline - Date.now();
    if (index > 0 && remaining < FAILOVER_MIN_ATTEMPT_MS) break;
    const timeoutMs = Math.max(1_000, Math.min(request.timeoutMs ?? WHISPER_TIMEOUT_MS, remaining));
    const startedAt = Date.now();
    const result = await transcribeWithProvider(provider, { ...request, timeoutMs });
    if (result.ok) return { ok: true, transcript: result.transcript, provider, attempts };
    attempts.push({
      provider: attemptedProvider(provider),
      failure: result,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    });
    if (request.signal?.aborted || !failsOver(result.error)) break;
  }
  return { ok: false, failure: combinedFailure(attempts), attempts };
}
