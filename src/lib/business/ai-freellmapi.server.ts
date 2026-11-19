// @polsia:user-owned — freellmapi.co: proxy OpenAI-compatibile verso le free-tier di molti provider
// LLM. In Solco è la RISERVA GRATUITA delle funzioni AI di testo: Claude resta primario e di qualità,
// ma se la chiave Claude manca, è rifiutata, è sopra il tetto di spesa o il servizio è occupato, si
// ripiega qui senza far pagare nulla al proprietario. Usa un modello APERTO (non OpenAI): il modello è
// configurabile con FREELLMAPI_MODEL (elenco su freellmapi.co/models). La chiave è FREELLMAPI_API_KEY
// (token «freellmapi-…» dalla dashboard), segreto server-side. Non logga mai la chiave, il prompt o la
// risposta. Nota: freellmapi.co dichiara di non essere un substrato di inferenza stabile/garantito,
// perciò è solo riserva best-effort, mai il motore primario.
import 'server-only';
import { createHash } from 'node:crypto';

/** Il token della dashboard freellmapi.co (formato «freellmapi-…»). */
export function freellmapiApiKey(env: Record<string, string | undefined> = process.env) {
  return env.FREELLMAPI_API_KEY?.trim() || undefined;
}

/** Base URL OpenAI-compatibile (self-hosting: imposta FREELLMAPI_BASE_URL sul tuo router). */
export function freellmapiBaseUrl(env: Record<string, string | undefined> = process.env) {
  const raw = env.FREELLMAPI_BASE_URL?.trim() || 'https://freellmapi.co/v1';
  return raw.replace(/\/+$/, '');
}

/**
 * Il modello da usare. Predefinito «auto»: lascia scegliere al proxy un modello gratuito disponibile.
 * Imposta FREELLMAPI_MODEL a un id preciso da freellmapi.co/models (preferisci un modello APERTO, non
 * OpenAI). Se l'id non è valido la riserva fallisce in silenzio e resta l'errore di Claude: la verifica
 * admin e il monitoraggio mostrano il modello configurato e l'eventuale errore.
 */
export function freellmapiModel(env: Record<string, string | undefined> = process.env) {
  return env.FREELLMAPI_MODEL?.trim() || 'auto';
}

/** Una sola fonte di verità per il deadline (sotto il limite della route che chiama). */
export const FREELLMAPI_TIMEOUT_MS = 90_000;

/** Solo ASCII visibile: una chiave con spazi, a capo o virgolette tipografiche non autentica mai. */
const KEY_SHAPE = /^[\x21-\x7e]+$/;

let loggedShapeFor: string | null = null;

function fingerprint(key: string) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function logKeyShape(message: string, extra: Record<string, unknown> = {}) {
  const key = freellmapiApiKey() ?? '';
  // biome-ignore lint/suspicious/noConsole: log della FORMA della chiave per il proprietario, mai il valore.
  console.error(message, {
    length: key.length,
    expectedPrefix: key.startsWith('freellmapi-'),
    hasSpaces: /\s/.test(key),
    hasQuotes: /["'‘’“”«»]/.test(key),
    nonAscii: /[^\x20-\x7e]/.test(key),
    ...extra,
  });
}

/** La chiave è presente e ben formata (non prova che il proxy la accetti: quello lo dice una chiamata). */
export function freellmapiConfigured(env: Record<string, string | undefined> = process.env) {
  const key = freellmapiApiKey(env);
  if (!key) return false;
  if (!KEY_SHAPE.test(key)) {
    const print = fingerprint(key);
    if (loggedShapeFor !== print) {
      loggedShapeFor = print;
      logKeyShape('[solco] chiave freellmapi.co malformata; riserva AI spenta');
    }
    return false;
  }
  return true;
}

export type FreellmapiOutcome = 'not_configured' | 'busy' | 'failed';

/** Mappa un errore HTTP/di rete sulla stessa semantica di Claude (not_configured/busy/failed). */
export function classifyFreellmapiStatus(status: number | null): FreellmapiOutcome {
  if (status === 401 || status === 403) return 'not_configured'; // chiave rifiutata: solo il proprietario la sistema
  if (status === null) return 'busy'; // rete/timeout: transitorio
  if (status === 429 || status >= 500) return 'busy'; // sovraccarico o errore del proxy: riprovabile
  return 'failed';
}

export interface FreellmapiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface FreellmapiChatOptions {
  messages: FreellmapiMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json_object';
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}

export class FreellmapiError extends Error {
  readonly outcome: FreellmapiOutcome;
  readonly status: number | null;
  constructor(outcome: FreellmapiOutcome, status: number | null, message: string) {
    super(message);
    this.name = 'FreellmapiError';
    this.outcome = outcome;
    this.status = status;
  }
}

/** Chat completion non in streaming. Ritorna il testo del messaggio dell'assistente. */
export async function freellmapiChat(opts: FreellmapiChatOptions): Promise<string> {
  const env = opts.env ?? process.env;
  const key = freellmapiApiKey(env);
  if (!key) throw new FreellmapiError('not_configured', null, 'FREELLMAPI_API_KEY mancante');

  const body = JSON.stringify({
    model: opts.model ?? freellmapiModel(env),
    messages: opts.messages,
    stream: false,
    ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
    ...(typeof opts.maxTokens === 'number' ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.responseFormat === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
  });

  const timeout = AbortSignal.timeout(FREELLMAPI_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(`${freellmapiBaseUrl(env)}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body,
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    // DNS/reset/TLS/timeout: transitorio.
    throw new FreellmapiError('busy', null, error instanceof Error ? error.name : 'network');
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 401) {
      logKeyShape('[solco] freellmapi.co ha rifiutato la chiave', { status: 401 });
    }
    throw new FreellmapiError(
      classifyFreellmapiStatus(res.status),
      res.status,
      `freellmapi.co HTTP ${res.status}`,
    );
  }

  const data = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
  } | null;
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.length === 0) {
    throw new FreellmapiError('failed', res.status, 'risposta vuota o non valida');
  }
  return text;
}

/**
 * Output JSON strutturato: forza response_format json_object, estrae il JSON (anche se avvolto in
 * ``` o testo), e riprova una volta con un'istruzione più severa su errore di parsing.
 */
export async function freellmapiJson<T = unknown>(opts: FreellmapiChatOptions): Promise<T> {
  const first = await freellmapiChat({ ...opts, responseFormat: 'json_object' });
  const parsedFirst = extractJson<T>(first);
  if (parsedFirst !== undefined) return parsedFirst;
  const retry = await freellmapiChat({
    ...opts,
    responseFormat: 'json_object',
    messages: [
      ...opts.messages,
      {
        role: 'system',
        content: 'Rispondi SOLO con JSON valido. Nessun testo, nessun blocco ```.',
      },
    ],
  });
  const parsedRetry = extractJson<T>(retry);
  if (parsedRetry !== undefined) return parsedRetry;
  throw new FreellmapiError('failed', null, 'JSON non valido dalla riserva');
}

/** Estrae un oggetto JSON dal testo (tollera ``` o prosa attorno). undefined se non trovato. */
function extractJson<T>(text: string): T | undefined {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Cerca il primo oggetto { … } bilanciato.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as T;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

export interface FreellmapiVerifyResult {
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  httpStatus: number | null;
}

/**
 * Verifica che la chiave sia accettata dal proxy, senza spendere token: GET /models. Usata dalla
 * pagina admin e dal monitoraggio. Non ritorna mai la chiave né i corpi di risposta.
 */
export async function verifyFreellmapi(
  env: Record<string, string | undefined> = process.env,
): Promise<FreellmapiVerifyResult> {
  const key = freellmapiApiKey(env);
  if (!key) {
    return {
      status: 'warn',
      detail: 'Non configurata (FREELLMAPI_API_KEY): la riserva AI gratuita è spenta.',
      httpStatus: null,
    };
  }
  if (!KEY_SHAPE.test(key)) {
    return { status: 'fail', detail: 'La chiave non ha un formato valido.', httpStatus: null };
  }
  let res: Response;
  try {
    res = await fetch(`${freellmapiBaseUrl(env)}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return { status: 'fail', detail: 'freellmapi.co non raggiungibile.', httpStatus: null };
  }
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 200) {
    return {
      status: 'ok',
      detail: `Chiave valida (modello: ${freellmapiModel(env)}).`,
      httpStatus: 200,
    };
  }
  if (res.status === 401 || res.status === 403) {
    return { status: 'fail', detail: 'Chiave non valida o revocata.', httpStatus: res.status };
  }
  return {
    status: 'fail',
    detail: `freellmapi.co ha risposto con un errore (HTTP ${res.status}).`,
    httpStatus: res.status,
  };
}
