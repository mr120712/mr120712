// @polsia:user-owned — freellmapi: RISERVA AI GRATUITA delle funzioni di testo (Claude resta primario e
// di qualità; si ripiega qui senza costi solo se Claude manca, è rifiutato, è sopra il tetto di spesa o è
// occupato). Protocollo OpenAI-compatibile, modello APERTO (FREELLMAPI_MODEL). La rete gira SOLO SU
// SOLCO: il router multi-provider è ospitato dentro l'app (/api/ai-reserve/v1) e Solco lo chiama
// IN-PROCESS (src/lib/business/ai-reserve-connector.server), senza alcun giro HTTP. Non esistono router
// esterni: FREELLMAPI_BASE_URL non può portare la riserva fuori da Solco ed è ignorata. Le chiavi dei
// provider (GROQ_API_KEY, …) restano sul server. Non logga mai chiave/prompt/risposta.
import 'server-only';
import { createHash } from 'node:crypto';
import {
  forwardChat,
  listModels,
  reserveProviderKeyNames,
  reserveProviderLabels,
} from '@/lib/business/ai-reserve-connector.server';

/**
 * Il segreto condiviso dell'endpoint pubblico della riserva (/api/ai-reserve/v1), server-side.
 * Accetta il valore sotto FREELLMAPI_API_KEY oppure, come alias, FREELLMAPI_TOKEN — così il "token"
 * configurato sotto l'uno o l'altro nome funziona lo stesso. FREELLMAPI_API_KEY ha la precedenza.
 */
export function freellmapiApiKey(env: Record<string, string | undefined> = process.env) {
  return env.FREELLMAPI_API_KEY?.trim() || env.FREELLMAPI_TOKEN?.trim() || undefined;
}

/** Percorso del connettore interno (router ospitato da Solco) sull'URL pubblico dell'app. */
export const RESERVE_CONNECTOR_PATH = '/api/ai-reserve/v1';

/** Il connettore interno su NEXT_PUBLIC_APP_URL; null solo se l'URL pubblico dell'app manca. */
export function builtInReserveBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const appUrl = env.NEXT_PUBLIC_APP_URL?.trim();
  if (!appUrl) return null;
  return `${appUrl.replace(/\/+$/, '')}${RESERVE_CONNECTOR_PATH}`;
}

/**
 * Base URL OpenAI-compatibile della riserva: SEMPRE il router ospitato da Solco su NEXT_PUBLIC_APP_URL
 * (lo stesso indirizzo che usano i client esterni con il Bearer). FREELLMAPI_BASE_URL è ignorata: la
 * rete non esce da Solco. Null solo se manca NEXT_PUBLIC_APP_URL.
 */
export function freellmapiBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return builtInReserveBaseUrl(env);
}

/**
 * True quando la riserva è disponibile: gira sempre sul connettore INTERNO (provider chiamati
 * in-process), mai via HTTP sull'app (niente loopback, firewall, redirect, cold-start o header persi).
 */
export function usesBuiltInConnector(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return builtInReserveBaseUrl(env) !== null;
}

/**
 * Il modello da usare. Predefinito «auto»: lascia che il router interno scelga, per ogni provider
 * gratuito, un suo modello disponibile (default, poi scorta) con failover automatico. Imposta
 * FREELLMAPI_MODEL a un id preciso solo se vuoi forzare un singolo modello: verrà provato tale e
 * quale su ogni provider finché uno lo riconosce (preferisci un modello APERTO, non OpenAI). Se l'id
 * non è valido ovunque la riserva fallisce in silenzio e resta l'errore di Claude: la verifica admin
 * e il monitoraggio mostrano il modello configurato e l'eventuale errore.
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
 * La riserva è configurata quando c'è la chiave (ben formata) e Solco ha il suo URL pubblico
 * (NEXT_PUBLIC_APP_URL), su cui è ospitato il router. Che ci sia almeno un provider lo dice una chiamata.
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
  if (!base) throw new FreellmapiError('not_configured', null, 'NEXT_PUBLIC_APP_URL mancante');

  // Connettore INTERNO, sempre: chiamata diretta ai provider gratuiti, nessun giro HTTP sull'app.
  // forwardChat non autentica: il Bearer serve solo ai chiamanti ESTERNI dell'endpoint pubblico.
  const res = await forwardChat(
    {
      messages: opts.messages,
      model: opts.model ?? freellmapiModel(env),
      ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
      ...(typeof opts.maxTokens === 'number' ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.responseFormat === 'json_object'
        ? { response_format: { type: 'json_object' } }
        : {}),
    },
    env,
  );

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
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
  // Sempre in-process: il router di Solco interroga i provider gratuiti direttamente (nessun loopback).
  const probe = await listModels(env);
  await probe.body?.cancel().catch(() => undefined);
  if (probe.status === 200) {
    const labels = reserveProviderLabels(env);
    const chain = labels.length > 0 ? labels.join(', ') : 'provider gratuiti';
    return {
      status: 'ok',
      detail: `Riserva pronta su Solco (${chain}; modello: ${freellmapiModel(env)}).`,
      httpStatus: 200,
    };
  }
  if (probe.status === 503) {
    return {
      status: 'warn',
      detail: `Riserva spenta: nessun provider gratuito configurato (${reserveProviderKeyNames().join(', ')}).`,
      httpStatus: 503,
    };
  }
  return {
    status: 'fail',
    detail: `La riserva interna ha risposto con un errore (HTTP ${probe.status}).`,
    httpStatus: probe.status,
  };
}
