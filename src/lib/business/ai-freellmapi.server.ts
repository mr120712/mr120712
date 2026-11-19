// @polsia:user-owned — freellmapi: RISERVA AI GRATUITA delle funzioni di testo (Claude resta primario e
// di qualità; si ripiega qui senza costi solo se Claude manca, è rifiutato, è sopra il tetto di spesa o è
// occupato). Protocollo OpenAI-compatibile, modello APERTO (FREELLMAPI_MODEL). Dall'aggiornamento
// "connettore" la riserva è OSPITATA DENTRO SOLCO di default: il router è src/app/api/ai-reserve/v1, che
// inoltra a Groq (free tier, GROQ_API_KEY), raggiungibile sull'URL pubblico dell'app — quindi basta
// FREELLMAPI_API_KEY (segreto condiviso tra client riserva e connettore). FREELLMAPI_BASE_URL è un
// OVERRIDE opzionale per un router esterno; un valore `freellmapi.co` (solo il sito, 404, non un'API) è
// ignorato e si usa il connettore interno. Non logga mai la chiave, il prompt o la risposta. Best-effort.
import 'server-only';
import { createHash } from 'node:crypto';

/** Il segreto condiviso con il connettore interno (o il token di un router esterno), server-side. */
export function freellmapiApiKey(env: Record<string, string | undefined> = process.env) {
  return env.FREELLMAPI_API_KEY?.trim() || undefined;
}

/** Percorso del connettore interno (router ospitato da Solco) sull'URL pubblico dell'app. */
export const RESERVE_CONNECTOR_PATH = '/api/ai-reserve/v1';

/** `freellmapi.co` è solo il sito (404), mai un'API: un override che punta qui va ignorato. */
function isNonApiFreellmapiHost(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === 'freellmapi.co' || host.endsWith('.freellmapi.co');
  } catch {
    return false;
  }
}

/** Il connettore interno su NEXT_PUBLIC_APP_URL; null solo se l'URL pubblico dell'app manca. */
export function builtInReserveBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const appUrl = env.NEXT_PUBLIC_APP_URL?.trim();
  if (!appUrl) return null;
  return `${appUrl.replace(/\/+$/, '')}${RESERVE_CONNECTOR_PATH}`;
}

/**
 * Base URL OpenAI-compatibile della riserva. Di DEFAULT è il connettore interno di Solco
 * (builtInReserveBaseUrl): nessun router esterno da pubblicare. FREELLMAPI_BASE_URL resta un OVERRIDE
 * per un router esterno valido; se è assente, non è un URL http(s), o punta a `freellmapi.co` (solo il
 * sito, non un'API), si usa il connettore interno. Null solo se manca anche NEXT_PUBLIC_APP_URL.
 */
export function freellmapiBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env.FREELLMAPI_BASE_URL?.trim();
  if (raw && /^https?:\/\//i.test(raw) && !isNonApiFreellmapiHost(raw)) {
    return raw.replace(/\/+$/, '');
  }
  return builtInReserveBaseUrl(env);
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

/**
 * La riserva è configurata quando ci sono SIA la chiave (ben formata) SIA l'URL del router
 * (FREELLMAPI_BASE_URL): freellmapi è self-hosted, senza un endpoint pubblico esplicito non c'è nulla da
 * chiamare. Non prova che il router accetti la chiave: quello lo dice una chiamata.
 */
export function freellmapiConfigured(env: Record<string, string | undefined> = process.env) {
  const key = freellmapiApiKey(env);
  if (!key) return false;
  if (!KEY_SHAPE.test(key)) {
    const print = fingerprint(key);
    if (loggedShapeFor !== print) {
      loggedShapeFor = print;
      logKeyShape('[solco] chiave freellmapi malformata; riserva AI spenta');
    }
    return false;
  }
  return freellmapiBaseUrl(env) !== null;
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
  const base = freellmapiBaseUrl(env);
  if (!base) throw new FreellmapiError('not_configured', null, 'FREELLMAPI_BASE_URL mancante');

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
    res = await fetch(`${base}/chat/completions`, {
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
      logKeyShape('[solco] il router freellmapi ha rifiutato la chiave', { status: 401 });
    }
    throw new FreellmapiError(
      classifyFreellmapiStatus(res.status),
      res.status,
      `freellmapi HTTP ${res.status}`,
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
  const base = freellmapiBaseUrl(env);
  if (!base) {
    return {
      status: 'warn',
      detail:
        'Riserva non disponibile: manca NEXT_PUBLIC_APP_URL, quindi il connettore interno ' +
        '(/api/ai-reserve/v1) non ha un URL pubblico su cui essere chiamato.',
      httpStatus: null,
    };
  }
  let res: Response;
  try {
    res = await fetch(`${base}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return { status: 'fail', detail: 'Router freellmapi non raggiungibile.', httpStatus: null };
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
    detail:
      res.status === 404
        ? `Il router freellmapi non ha /v1 (HTTP 404): FREELLMAPI_BASE_URL non punta a un'API freellmapi valida.`
        : `Il router freellmapi ha risposto con un errore (HTTP ${res.status}).`,
    httpStatus: res.status,
  };
}
