// @polsia:user-owned — "Riserva AI" connector: endpoint OpenAI-compatibile OSPITATO DA SOLCO
// (pubblico su Vercel), così la riserva gratuita (src/lib/business/ai-freellmapi.server.ts) NON ha
// più bisogno di un router FreeLLMAPI self-hosted su un altro URL. Si imposta semplicemente
// FREELLMAPI_BASE_URL = https://<sito>/api/ai-reserve/v1 e il connettore fa da router:
//   • autentica il Bearer in ingresso contro FREELLMAPI_API_KEY (il segreto condiviso che le due
//     metà di Solco — client riserva e connettore — hanno entrambe, confronto a tempo costante);
//   • inoltra le chat a Groq (free tier, GROQ_API_KEY, già usata e verde in solco_ai), che serve
//     modelli APERTI (Llama ecc.) con protocollo OpenAI.
// La chat primaria resta Claude: questo è solo la RISERVA best-effort, mai il motore primario.
// Non registra MAI la chiave, il prompt o la risposta.
import 'server-only';
import { timingSafeEqual } from 'node:crypto';

/** Base URL OpenAI-compatibile di Groq (stesso host già usato da solco_ai per Whisper). */
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
/** Modello di default quando il chiamante chiede "auto" o non specifica nulla. */
export const DEFAULT_RESERVE_MODEL = 'llama-3.3-70b-versatile';
/** Modello di ripiego se il primario è stato ritirato (HTTP 400/404 lato Groq). */
export const FALLBACK_RESERVE_MODEL = 'llama-3.1-8b-instant';
/** Sotto il limite della route che chiama (maxDuration = 60). */
export const RESERVE_UPSTREAM_TIMEOUT_MS = 55_000;

type Env = Record<string, string | undefined>;
export type FetchLike = typeof fetch;

/** Il segreto condiviso: il Bearer che il client riserva presenta e che il connettore verifica. */
export function reserveSecret(env: Env = process.env): string | undefined {
  return env.FREELLMAPI_API_KEY?.trim() || undefined;
}

/** La chiave upstream (Groq). Senza di essa il connettore non può inoltrare nulla. */
export function groqApiKey(env: Env = process.env): string | undefined {
  return env.GROQ_API_KEY?.trim() || undefined;
}

/** Modello di default configurabile; ricade su DEFAULT_RESERVE_MODEL. */
export function reserveDefaultModel(env: Env = process.env): string {
  return env.AI_RESERVE_MODEL?.trim() || env.GROQ_CHAT_MODEL?.trim() || DEFAULT_RESERVE_MODEL;
}

/** Confronto a tempo costante del Bearer presentato con il segreto configurato. */
export function bearerMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type AuthOutcome = { ok: true } | { ok: false; status: 401 | 503; error: string };

/**
 * Autorizzazione del connettore. È un endpoint macchina autenticato dal TOKEN (nessun cookie,
 * nessuna autorità ambientale), quindi NON usa sameOrigin: i chiamanti server-to-server non
 * mandano un header Origin e il Bearer È l'autenticazione. Fail-closed: senza segreto, 503.
 */
export function authorizeReserve(request: Request, env: Env = process.env): AuthOutcome {
  const secret = reserveSecret(env);
  if (!secret) return { ok: false, status: 503, error: 'reserve_not_configured' };
  const header = (request.headers.get('authorization') ?? '').trim();
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  if (!token || !bearerMatches(token, secret)) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true };
}

/** Mappa il modello richiesto su uno concreto di Groq. "auto"/vuoto → default configurato. */
export function resolveModel(requested: string | undefined, env: Env = process.env): string {
  const model = requested?.trim();
  if (!model || model.toLowerCase() === 'auto') return reserveDefaultModel(env);
  return model;
}

export interface ReserveChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ReserveChatBody {
  model?: string;
  messages: ReserveChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type?: string };
}

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** Un errore 400/404 su un modello preciso: candidato per il ripiego su un altro modello. */
function looksLikeModelError(status: number): boolean {
  return status === 400 || status === 404;
}

async function callGroqChat(
  model: string,
  body: ReserveChatBody,
  key: string,
  fetchImpl: FetchLike,
): Promise<Response> {
  const payload = {
    model,
    messages: body.messages,
    stream: false as const,
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.max_tokens === 'number' ? { max_tokens: body.max_tokens } : {}),
    ...(body.response_format?.type === 'json_object'
      ? { response_format: { type: 'json_object' as const } }
      : {}),
  };
  return fetchImpl(`${GROQ_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(payload),
    cache: 'no-store',
    signal: AbortSignal.timeout(RESERVE_UPSTREAM_TIMEOUT_MS),
  });
}

/**
 * Inoltra una chat completion a Groq e restituisce la risposta OpenAI-shaped così com'è
 * (choices[0].message.content), che è esattamente ciò che il client riserva legge. Se il modello
 * primario è stato ritirato (400/404), riprova UNA volta con il modello di ripiego.
 */
export async function forwardChat(
  body: ReserveChatBody,
  env: Env = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const key = groqApiKey(env);
  if (!key) return jsonResponse({ error: 'upstream_not_configured' }, 503);

  const primary = resolveModel(body.model, env);
  let upstream: Response;
  try {
    upstream = await callGroqChat(primary, body, key, fetchImpl);
  } catch {
    return jsonResponse({ error: 'upstream_unreachable' }, 502);
  }

  if (!upstream.ok && looksLikeModelError(upstream.status) && primary !== FALLBACK_RESERVE_MODEL) {
    await upstream.body?.cancel().catch(() => undefined);
    try {
      upstream = await callGroqChat(FALLBACK_RESERVE_MODEL, body, key, fetchImpl);
    } catch {
      return jsonResponse({ error: 'upstream_unreachable' }, 502);
    }
  }

  const text = await upstream.text().catch(() => '');
  if (!upstream.ok) {
    // Non inoltrare il corpo d'errore grezzo di Groq (può citare dettagli dell'account).
    return jsonResponse({ error: 'upstream_error', status: upstream.status }, 502);
  }
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * Proxy di GET /models verso Groq: 200 solo se Groq risponde 200 (chiave valida e raggiungibile).
 * È il controllo che il monitoraggio usa per dire "riserva pronta": un 200 qui significa che tutta
 * la catena connettore→Groq funziona. Qualsiasi errore upstream → 502 (riserva non pronta).
 */
export async function listModels(
  env: Env = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const key = groqApiKey(env);
  if (!key) return jsonResponse({ error: 'upstream_not_configured' }, 503);
  let upstream: Response;
  try {
    upstream = await fetchImpl(`${GROQ_BASE_URL}/models`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(RESERVE_UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return jsonResponse({ error: 'upstream_unreachable' }, 502);
  }
  const text = await upstream.text().catch(() => '');
  if (!upstream.ok) return jsonResponse({ error: 'upstream_error', status: upstream.status }, 502);
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** Etichetta di salute della riserva dallo status di listModels: 200 ok, 503 non configurata, resto giù. */
export function reserveStatusLabel(status: number): 'ok' | 'unconfigured' | 'down' {
  if (status === 200) return 'ok';
  if (status === 503) return 'unconfigured';
  return 'down';
}
