// @polsia:user-owned — "Riserva AI" connector: un router OpenAI-compatibile OSPITATO DA SOLCO
// (pubblico su Vercel), in stile FreeLLMAPI. Un solo endpoint (/api/ai-reserve/v1) davanti a PIÙ
// provider gratuiti con protocollo OpenAI (Groq, Cerebras, Google Gemini, Mistral, OpenRouter),
// scelti in ordine di priorità e con FAILOVER automatico: se un provider è assente, limitato,
// in errore o irraggiungibile, si passa al successivo; dentro ogni provider si prova prima il
// modello di default e poi quello di scorta. Un provider è ATTIVO solo se la sua chiave è presente
// nell'ambiente, quindi la riserva funziona già con la sola GROQ_API_KEY e si arricchisce da sola
// quando aggiungi altre chiavi. A differenza di FreeLLMAPI (software self-hosted su localhost:3001),
// questo gira DENTRO Solco: nessun server esterno sempre acceso da gestire.
//   • autentica il Bearer in ingresso contro FREELLMAPI_API_KEY (segreto condiviso fra le due metà
//     di Solco — client riserva e connettore — confronto a tempo costante);
//   • inoltra le chat al primo provider gratuito disponibile che risponde.
// La chat primaria resta Claude: questa è solo la RISERVA best-effort, mai il motore primario.
// Non registra MAI la chiave, il prompt o la risposta.
import 'server-only';
import { timingSafeEqual } from 'node:crypto';

/** Base URL OpenAI-compatibile di Groq (stesso host già usato da solco_ai per Whisper). */
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
/** Modello di default di Groq quando il chiamante chiede "auto" o non specifica nulla. */
export const DEFAULT_RESERVE_MODEL = 'llama-3.3-70b-versatile';
/** Modello di ripiego di Groq se il primario è stato ritirato (HTTP 400/404 lato upstream). */
export const FALLBACK_RESERVE_MODEL = 'llama-3.1-8b-instant';
/** Sotto il limite della route che chiama (maxDuration = 60). */
export const RESERVE_UPSTREAM_TIMEOUT_MS = 55_000;

type Env = Record<string, string | undefined>;
export type FetchLike = typeof fetch;

const clean = (value: string | undefined): string | undefined =>
  value?.trim() ? value.trim() : undefined;

/** Il segreto condiviso: il Bearer che il client riserva presenta e che il connettore verifica. */
export function reserveSecret(env: Env = process.env): string | undefined {
  return clean(env.FREELLMAPI_API_KEY);
}

/** La chiave upstream di Groq (il provider di default della riserva). */
export function groqApiKey(env: Env = process.env): string | undefined {
  return clean(env.GROQ_API_KEY);
}

/** Modello di default di Groq configurabile; ricade su DEFAULT_RESERVE_MODEL. */
export function reserveDefaultModel(env: Env = process.env): string {
  return clean(env.AI_RESERVE_MODEL) ?? clean(env.GROQ_CHAT_MODEL) ?? DEFAULT_RESERVE_MODEL;
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

// ──────────────────────────────────────────────────────────────────────────────
// Registro dei provider gratuiti (lo "smart routing" in stile FreeLLMAPI).
// Ogni provider è OpenAI-compatibile su /chat/completions e /models. L'ordine è la priorità
// di failover. Un provider entra nella catena solo se la sua chiave è nell'ambiente; i modelli
// di «auto» sono sovrascrivibili per provider via env quando la disponibilità gratuita cambia.
// ──────────────────────────────────────────────────────────────────────────────

/** Un provider attivo e pronto all'uso (chiave già risolta, modelli «auto» già calcolati). */
export interface ReserveProvider {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  /** Modelli da provare in ordine quando il chiamante chiede «auto» (default, poi scorta). */
  models: string[];
  extraHeaders?: Record<string, string>;
}

interface ProviderDef {
  id: string;
  label: string;
  baseUrl: string;
  keyVar: string;
  models: (env: Env) => string[];
  extraHeaders?: Record<string, string>;
}

/** Ordine di priorità del failover. Groq per primo: già configurato, veloce e verde in solco_ai. */
const PROVIDER_DEFS: ProviderDef[] = [
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: GROQ_BASE_URL,
    keyVar: 'GROQ_API_KEY',
    models: (env) => [reserveDefaultModel(env), FALLBACK_RESERVE_MODEL],
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyVar: 'CEREBRAS_API_KEY',
    models: (env) => [
      clean(env.CEREBRAS_MODEL) ?? 'llama-3.3-70b',
      clean(env.CEREBRAS_FALLBACK_MODEL) ?? 'llama3.1-8b',
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyVar: 'GEMINI_API_KEY',
    // gemini-2.0-flash/1.5-flash sono stati ritirati nel 2026 (quota free azzerata): si usano i
    // Flash correnti, gratuiti nel free tier. Sovrascrivibili con GEMINI_MODEL/GEMINI_FALLBACK_MODEL.
    models: (env) => [
      clean(env.GEMINI_MODEL) ?? 'gemini-2.5-flash',
      clean(env.GEMINI_FALLBACK_MODEL) ?? 'gemini-2.5-flash-lite',
    ],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyVar: 'MISTRAL_API_KEY',
    models: (env) => [clean(env.MISTRAL_CHAT_MODEL) ?? 'mistral-small-latest'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyVar: 'OPENROUTER_API_KEY',
    models: (env) => [
      clean(env.OPENROUTER_MODEL) ?? 'meta-llama/llama-3.3-70b-instruct:free',
      clean(env.OPENROUTER_FALLBACK_MODEL) ?? 'meta-llama/llama-3.1-8b-instruct:free',
    ],
    extraHeaders: { 'HTTP-Referer': 'https://www.solcomusic.online', 'X-Title': 'Solco' },
  },
];

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/**
 * I provider ATTIVI (chiave presente), in ordine di failover. AI_RESERVE_PROVIDERS, se impostato
 * (CSV di id, es. "groq,gemini"), limita e riordina la catena; altrimenti vale l'ordine del registro.
 */
export function activeProviders(env: Env = process.env): ReserveProvider[] {
  const requested = clean(env.AI_RESERVE_PROVIDERS)
    ?.split(',')
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
  const ordered =
    requested && requested.length > 0
      ? requested
          .map((id) => PROVIDER_DEFS.find((def) => def.id === id))
          .filter((def): def is ProviderDef => Boolean(def))
      : PROVIDER_DEFS;

  const seen = new Set<string>();
  const providers: ReserveProvider[] = [];
  for (const def of ordered) {
    if (seen.has(def.id)) continue;
    const apiKey = clean(env[def.keyVar]);
    if (!apiKey) continue;
    seen.add(def.id);
    providers.push({
      id: def.id,
      label: def.label,
      baseUrl: def.baseUrl,
      apiKey,
      models: dedupe(def.models(env)),
      ...(def.extraHeaders ? { extraHeaders: def.extraHeaders } : {}),
    });
  }
  return providers;
}

/** Le etichette dei provider attivi, per i messaggi di stato (nessun segreto). */
export function reserveProviderLabels(env: Env = process.env): string[] {
  return activeProviders(env).map((provider) => provider.label);
}

/** I nomi delle variabili-chiave di tutti i provider conosciuti (per i messaggi "non configurato"). */
export function reserveProviderKeyNames(): string[] {
  return PROVIDER_DEFS.map((def) => def.keyVar);
}

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function passthrough(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** Un errore 400/404 su un modello preciso: candidato per il ripiego su un altro modello. */
function looksLikeModelError(status: number): boolean {
  return status === 400 || status === 404;
}

function providerHeaders(
  provider: ReserveProvider,
  extra: Record<string, string> = {},
): HeadersInit {
  return {
    authorization: `Bearer ${provider.apiKey}`,
    accept: 'application/json',
    ...(provider.extraHeaders ?? {}),
    ...extra,
  };
}

async function callProviderChat(
  provider: ReserveProvider,
  model: string,
  body: ReserveChatBody,
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
  return fetchImpl(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: providerHeaders(provider, { 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
    cache: 'no-store',
    signal: AbortSignal.timeout(RESERVE_UPSTREAM_TIMEOUT_MS),
  });
}

/**
 * Inoltra una chat completion ai provider gratuiti e restituisce la PRIMA risposta OpenAI-shaped
 * riuscita così com'è (choices[0].message.content), che è esattamente ciò che il client riserva
 * legge. Failover: per «auto» ogni provider prova il suo modello di default e poi quello di scorta;
 * un errore di modello (400/404) passa al modello successivo, qualunque altro errore (401/403/429/
 * 5xx) o caduta di rete passa al PROVIDER successivo. Un modello esplicito è provato tale e quale su
 * ogni provider, finché uno lo riconosce. Senza alcun provider configurato → 503; se tutti falliscono
 * → 502 (upstream_error con l'ultimo status, o upstream_unreachable se nessuno ha mai risposto).
 */
export async function forwardChat(
  body: ReserveChatBody,
  env: Env = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const providers = activeProviders(env);
  if (providers.length === 0) return jsonResponse({ error: 'upstream_not_configured' }, 503);

  const requested = body.model?.trim();
  const explicit = requested && requested.toLowerCase() !== 'auto' ? requested : null;

  let sawHttpError = false;
  let lastStatus = 0;
  for (const provider of providers) {
    const candidates = explicit ? [explicit] : provider.models;
    for (const model of candidates) {
      let upstream: Response;
      try {
        upstream = await callProviderChat(provider, model, body, fetchImpl);
      } catch {
        break; // rete caduta su questo provider → provider successivo
      }
      if (upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return passthrough(text);
      }
      sawHttpError = true;
      lastStatus = upstream.status;
      await upstream.body?.cancel().catch(() => undefined);
      if (looksLikeModelError(upstream.status)) continue; // modello ritirato → prova lo scorta
      break; // 401/403/429/5xx → provider successivo
    }
  }
  return jsonResponse(
    sawHttpError
      ? { error: 'upstream_error', status: lastStatus }
      : { error: 'upstream_unreachable' },
    502,
  );
}

/**
 * Proxy di GET /models: 200 appena UN provider gratuito risponde 200 (chiave valida e raggiungibile).
 * È il controllo che il monitoraggio usa per dire "riserva pronta": un 200 qui significa che almeno
 * un anello della catena funziona. 503 se nessun provider è configurato; 502 se tutti falliscono.
 */
export async function listModels(
  env: Env = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const providers = activeProviders(env);
  if (providers.length === 0) return jsonResponse({ error: 'upstream_not_configured' }, 503);

  let sawHttpError = false;
  let lastStatus = 0;
  for (const provider of providers) {
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${provider.baseUrl}/models`, {
        headers: providerHeaders(provider),
        cache: 'no-store',
        signal: AbortSignal.timeout(RESERVE_UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      continue; // provider irraggiungibile → prova il successivo
    }
    if (upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return passthrough(text);
    }
    sawHttpError = true;
    lastStatus = upstream.status;
    await upstream.body?.cancel().catch(() => undefined);
  }
  return jsonResponse(
    sawHttpError
      ? { error: 'upstream_error', status: lastStatus }
      : { error: 'upstream_unreachable' },
    502,
  );
}

/** Esito della sonda /models di un singolo provider (per la diagnostica pubblica, senza segreti). */
export interface ReserveProviderProbe {
  id: string;
  label: string;
  status: number | null;
  ok: boolean;
}

/**
 * Interroga /models di OGNI provider attivo in parallelo e riporta il suo stato (senza chiave né
 * elenco modelli): alimenta l'endpoint di salute pubblico. Non spende token.
 */
export async function probeProviders(
  env: Env = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<ReserveProviderProbe[]> {
  const providers = activeProviders(env);
  return Promise.all(
    providers.map(async (provider) => {
      try {
        const res = await fetchImpl(`${provider.baseUrl}/models`, {
          headers: providerHeaders(provider),
          cache: 'no-store',
          signal: AbortSignal.timeout(20_000),
        });
        await res.body?.cancel().catch(() => undefined);
        return {
          id: provider.id,
          label: provider.label,
          status: res.status,
          ok: res.status === 200,
        };
      } catch {
        return { id: provider.id, label: provider.label, status: null, ok: false };
      }
    }),
  );
}

/** Etichetta di salute della riserva dallo status di listModels: 200 ok, 503 non configurata, resto giù. */
export function reserveStatusLabel(status: number): 'ok' | 'unconfigured' | 'down' {
  if (status === 200) return 'ok';
  if (status === 503) return 'unconfigured';
  return 'down';
}
