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
/**
 * Modello di default di Groq quando il chiamante chiede "auto" o non specifica nulla.
 * Nov 2026: Groq ha ritirato la famiglia Llama 3.x; l'allegato di default ora è gpt-oss-120b,
 * un modello OpenAI open-weight a 131k di contesto su LPU. Sovrascrivibile via
 * GROQ_CHAT_MODEL / AI_RESERVE_MODEL quando la disponibilità cambia.
 */
export const DEFAULT_RESERVE_MODEL = 'openai/gpt-oss-120b';
/**
 * Modello di ripiego di Groq se il primario sparisce (HTTP 400/404 lato upstream). gpt-oss-20b è
 * la versione 20B della stessa famiglia: più veloce/più economica, utile quando il 120b è saturo.
 */
export const FALLBACK_RESERVE_MODEL = 'openai/gpt-oss-20b';
/**
 * Budget dell'INTERA catena di failover di una chat (tutti i provider e modelli insieme): sotto il
 * limite della route che chiama (maxDuration = 60), così Vercel non taglia la richiesta a metà.
 */
export const RESERVE_CHAIN_BUDGET_MS = 50_000;
/**
 * Massimo per UN tentativo (un provider, un modello). Prima era 55 s: un provider lento si mangiava
 * tutto il budget e il failover non arrivava mai al successivo. Con 20 s restano almeno due altri
 * provider dentro il budget della catena.
 */
export const RESERVE_ATTEMPT_TIMEOUT_MS = 20_000;
/** Massimo per UN /models (verifica di salute, nessun token speso): breve, è solo un ping. */
export const RESERVE_MODELS_TIMEOUT_MS = 8_000;
/** Sotto questo margine non si inizia un altro tentativo: non farebbe in tempo a rispondere. */
const MIN_ATTEMPT_MS = 2_000;
/** Compatibilità: il vecchio nome del timeout di un tentativo. */
export const RESERVE_UPSTREAM_TIMEOUT_MS = RESERVE_ATTEMPT_TIMEOUT_MS;

/** Durate sovrascrivibili via env (ms interi positivi), per tarare la catena senza un deploy di codice. */
function durationFrom(env: Record<string, string | undefined>, key: string, fallback: number) {
  const value = Number.parseInt(env[key]?.trim() ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

type Env = Record<string, string | undefined>;
export type FetchLike = typeof fetch;

const clean = (value: string | undefined): string | undefined =>
  value?.trim() ? value.trim() : undefined;

/**
 * Il segreto condiviso: il Bearer che il client riserva presenta e che il connettore verifica.
 * FREELLMAPI_API_KEY, con FREELLMAPI_TOKEN come alias (precedenza a API_KEY). Entrambe le metà usano
 * questa funzione, quindi il Bearer inviato e quello atteso restano sempre identici.
 */
export function reserveSecret(env: Env = process.env): string | undefined {
  return clean(env.FREELLMAPI_API_KEY) ?? clean(env.FREELLMAPI_TOKEN);
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
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Stringa, array di parti (vision/tool_use/tool_result), o null (tool-call pura). */
  content?: string | unknown[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface ReserveChatBody {
  model?: string;
  messages: ReserveChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  response_format?: { type?: string };
  /** Definizioni degli strumenti (OpenAI function calling). */
  tools?: unknown[];
  tool_choice?: string | Record<string, unknown>;
  parallel_tool_calls?: boolean;
  /** Groq gpt-oss reasoning effort: "low" | "medium" | "high". */
  reasoning_effort?: string;
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
  /**
   * URL OpenAI-compatibile del provider. Stringa fissa per i provider hosted (Groq, Gemini, …) o
   * funzione per i provider il cui indirizzo è configurabile via env (local LLM: Ollama/vLLM/LM
   * Studio su una porta a scelta). Se la funzione restituisce undefined il provider è INATTIVO,
   * esattamente come se mancasse la chiave.
   */
  baseUrl: string | ((env: Env) => string | undefined);
  keyVar: string;
  /**
   * Chiave usata quando `env[keyVar]` è assente. Vale solo per provider che non richiedono
   * autenticazione (Ollama di default, vLLM senza `--api-key`, llama.cpp, LM Studio): si invia un
   * Bearer fittizio che il server ignora. Senza questo campo il provider resta inattivo se la
   * chiave non è impostata, come per gli hosted.
   */
  dummyApiKey?: string;
  /** Dove ottenere una chiave gratuita (mostrato nel pannello admin per i provider non configurati). */
  signupUrl: string;
  models: (env: Env) => string[];
  extraHeaders?: Record<string, string>;
  /** Variabile che può sostituire baseUrl (validata da baseUrlFrom: stesso dominio del provider). */
  baseUrlVar?: string;
  /** Dominio ammesso per l'override: la chiave del provider viene mandata solo lì (anti-SSRF). */
  baseUrlDomain?: string;
}

/**
 * Il baseUrl di un provider, con l'override opzionale da env (es. OPENROUTER_BASE_URL =
 * https://eu.openrouter.ai/api/v1). L'override è accettato solo se HTTPS e sul dominio del provider o
 * un suo sottodominio: la chiave API viaggia verso quell'indirizzo, quindi mai verso un host qualsiasi.
 * Valore assente o non valido → il baseUrl di registro. Per i provider il cui indirizzo è esso stesso
 * configurabile via env (local LLM: baseUrl è una funzione), restituisce `undefined` quando la funzione
 * non trova l'indirizzo — segnale di "provider spento" per i chiamanti.
 */
export function baseUrlFrom(
  def: Pick<ProviderDef, 'baseUrl' | 'baseUrlVar' | 'baseUrlDomain'>,
  env: Env,
): string | undefined {
  // Per i provider hosted baseUrl è una stringa; per il local LLM è una funzione che legge
  // LOCAL_LLM_BASE_URL. In quest'ultimo caso, assenza dell'env = provider spento.
  const staticBase = typeof def.baseUrl === 'function' ? def.baseUrl(env) : def.baseUrl;
  if (!staticBase) return undefined;
  const raw = def.baseUrlVar ? clean(env[def.baseUrlVar]) : undefined;
  if (!raw || !def.baseUrlDomain) return staticBase;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const domain = def.baseUrlDomain.toLowerCase();
    const sameDomain = host === domain || host.endsWith(`.${domain}`);
    if (url.protocol !== 'https:' || !sameDomain || url.username || url.password || url.port) {
      return staticBase;
    }
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return staticBase;
  }
}

/** MWAPI (entrambe le chiavi servono modelli Claude): Sonnet 5, poi Haiku 4.5 come scorta. */
const MWAPI_DEFAULT_MODEL = 'claude-sonnet-5';
const MWAPI_FALLBACK_MODEL = 'claude-haiku-4-5-20251001';
function mwapiModels(env: Env): string[] {
  const primary = clean(env.MWAPI_MODEL) ?? MWAPI_DEFAULT_MODEL;
  const fallback = clean(env.MWAPI_FALLBACK_MODEL) ?? MWAPI_FALLBACK_MODEL;
  return primary === fallback ? [primary] : [primary, fallback];
}

/** Ordine di priorità del failover. Groq per primo: già configurato, veloce e verde in solco_ai. */
const PROVIDER_DEFS: ProviderDef[] = [
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: GROQ_BASE_URL,
    keyVar: 'GROQ_API_KEY',
    signupUrl: 'https://console.groq.com/keys',
    models: (env) => [reserveDefaultModel(env), FALLBACK_RESERVE_MODEL],
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyVar: 'CEREBRAS_API_KEY',
    signupUrl: 'https://cloud.cerebras.ai',
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
    signupUrl: 'https://aistudio.google.com/apikey',
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
    signupUrl: 'https://console.mistral.ai/api-keys',
    models: (env) => [clean(env.MISTRAL_CHAT_MODEL) ?? 'mistral-small-latest'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    // OPENROUTER_BASE_URL=https://eu.openrouter.ai/api/v1 → solo provider ospitati nell'UE.
    baseUrlVar: 'OPENROUTER_BASE_URL',
    baseUrlDomain: 'openrouter.ai',
    keyVar: 'OPENROUTER_API_KEY',
    signupUrl: 'https://openrouter.ai/keys',
    // Default: NVIDIA Nemotron 3 Ultra (gratis su OpenRouter, 550B MoE, contesto 1M). Attenzione:
    // free tier basso (~50 richieste/giorno), disponibilità ~80% e NON supporta response_format
    // (json_object); se rifiuta (400/404/429) il failover passa al modello di scorta — Llama 3.3 70B,
    // che il JSON lo regge — e poi agli altri provider. Sovrascrivibili via OPENROUTER_MODEL /
    // OPENROUTER_FALLBACK_MODEL.
    models: (env) => [
      clean(env.OPENROUTER_MODEL) ?? 'nvidia/nemotron-3-ultra-550b-a55b:free',
      clean(env.OPENROUTER_FALLBACK_MODEL) ?? 'meta-llama/llama-3.3-70b-instruct:free',
    ],
    extraHeaders: { 'HTTP-Referer': 'https://www.solcomusic.online', 'X-Title': 'Solco' },
  },
  // MWAPI (api.mwapi.dev): gateway AI di terze parti, OpenAI-compatibile su /v1/chat/completions.
  // ULTIMO nella catena di proposito: è un intermediario senza documentazione pubblica né termini
  // verificabili, quindi il testo degli utenti ci passa solo se i provider gratuiti sopra falliscono
  // (l'ordine si cambia con AI_RESERVE_PROVIDERS). Due chiavi = due anelli: se una è limitata o
  // esaurita, prova l'altra. Entrambe servono modelli Claude: si chiede claude-sonnet-5 (MWAPI_MODEL lo
  // sovrascrive) e, se non risponde, claude-haiku-4-5 come scorta (MWAPI_FALLBACK_MODEL).
  {
    id: 'mwapi',
    label: 'MWAPI',
    baseUrl: 'https://api.mwapi.dev/v1',
    keyVar: 'MWAPI_API_KEY',
    signupUrl: 'https://api.mwapi.dev',
    models: mwapiModels,
  },
  {
    id: 'mwapi-2',
    label: 'MWAPI (chiave 2)',
    baseUrl: 'https://api.mwapi.dev/v1',
    keyVar: 'MWAPI_API_KEY_2',
    signupUrl: 'https://api.mwapi.dev',
    models: mwapiModels,
  },
  // LOCAL LLM: un server OpenAI-compatibile OSPITATO DALL'UTENTE (Ollama, vLLM, LM Studio,
  // llama.cpp server). ATTIVO solo quando LOCAL_LLM_BASE_URL è impostata (es.
  // "http://localhost:11434/v1" per Ollama, "http://localhost:8000/v1" per vLLM). L'autenticazione
  // è OPZIONALE: se il server non la richiede (Ollama di default) la chiave si lascia vuota e il
  // connettore manda il Bearer fittizio "local" che il server ignora; se invece hai attivato
  // l'auth (p.es. vLLM con `--api-key`) imposta LOCAL_LLM_API_KEY. I modelli da provare in «auto»
  // si scelgono con LOCAL_LLM_MODEL e LOCAL_LLM_FALLBACK_MODEL (default pensati per Ollama con
  // Llama/Qwen scaricati). Ultimo nella catena: i provider hosted sopra sono preferiti quando
  // disponibili perché la riserva è pensata per girare in cloud.
  {
    id: 'local-llm',
    label: 'Local LLM',
    baseUrl: (env) => {
      const raw = clean(env.LOCAL_LLM_BASE_URL);
      if (!raw) return undefined;
      try {
        const url = new URL(raw);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        ) {
          return undefined;
        }
        return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
      } catch {
        return undefined;
      }
    },
    keyVar: 'LOCAL_LLM_API_KEY',
    dummyApiKey: 'local',
    signupUrl: 'https://ollama.com/download',
    models: (env) => [
      clean(env.LOCAL_LLM_MODEL) ?? 'llama3.1',
      clean(env.LOCAL_LLM_FALLBACK_MODEL) ?? 'qwen2.5',
    ],
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
    // Indirizzo: stringa fissa per gli hosted, o LOCAL_LLM_BASE_URL per il local LLM (funzione).
    // baseUrlFrom applica anche l'override anti-SSRF (baseUrlVar + baseUrlDomain, es. OpenRouter EU).
    // undefined = provider spento (nessun indirizzo configurato), come per una chiave assente.
    const baseUrl = baseUrlFrom(def, env);
    if (!baseUrl) continue;
    // Chiave: prima l'env dichiarata, poi la chiave fittizia quando il provider la ammette
    // (Ollama e amici: il server ignora il Bearer). Senza né l'una né l'altra, il provider è spento.
    const apiKey = clean(env[def.keyVar]) ?? def.dummyApiKey;
    if (!apiKey) continue;
    seen.add(def.id);
    providers.push({
      id: def.id,
      label: def.label,
      baseUrl,
      apiKey,
      models: dedupe(def.models(env)),
      ...(def.extraHeaders ? { extraHeaders: def.extraHeaders } : {}),
    });
  }
  return providers;
}

// ──────────────────────────────────────────────────────────────────────────────
// Rotazione dei provider (round-robin «smart routing» in stile FreeLLMAPI/FreeLLM).
// I tier gratuiti hanno tetti GIORNALIERI bassi (es. OpenRouter ~50 richieste/giorno): colpire sempre
// lo stesso provider per primo ne esaurisce la quota mentre gli altri restano inattivi. La rotazione fa
// avanzare di una posizione il provider di TESTA della catena di failover a ogni finestra temporale,
// così il carico (e il consumo di token) si distribuisce. È a FINESTRA TEMPORALE, quindi deterministica
// e adatta al serverless (nessuno stato condiviso da tenere fra invocazioni effimere su Vercel): dentro
// la stessa finestra la testa è stabile, alla finestra dopo avanza. Il failover resta intatto: la
// rotazione cambia solo DA DOVE parte, non il fatto che tutti i provider vengano comunque provati.
// Spenta di default (ordine di priorità rigido, Groq per primo); si accende con AI_RESERVE_ROTATE=1.
// ──────────────────────────────────────────────────────────────────────────────

/** Finestra di rotazione predefinita: la testa della catena avanza di uno ogni minuto. */
export const DEFAULT_ROTATE_WINDOW_MS = 60_000;

const ROTATE_ON = new Set([
  '1',
  'true',
  'on',
  'yes',
  'time',
  'timed',
  'rotate',
  'round-robin',
  'roundrobin',
  'rr',
]);

/** True quando AI_RESERVE_ROTATE è un valore «acceso». Default (assente/0/off/false) → spenta. */
export function rotationEnabled(env: Env = process.env): boolean {
  const raw = clean(env.AI_RESERVE_ROTATE)?.toLowerCase();
  return raw !== undefined && ROTATE_ON.has(raw);
}

/** Durata della finestra di rotazione in ms (AI_RESERVE_ROTATE_MS). Default 60s; minimo 1 (no /0). */
export function rotateWindowMs(env: Env = process.env): number {
  const raw = clean(env.AI_RESERVE_ROTATE_MS);
  if (raw === undefined) return DEFAULT_ROTATE_WINDOW_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_ROTATE_WINDOW_MS;
  return Math.trunc(value);
}

/**
 * Rotazione PURA di una lista di `offset` posizioni verso sinistra (round-robin). Non muta l'input e
 * gestisce lista vuota o di un solo elemento (invariata) e offset negativi o non interi. È il cuore
 * di «rotate ai agents»: ruota la catena di provider così che a guidarla sia di volta in volta un altro.
 */
export function rotateProviders<T>(providers: readonly T[], offset: number): T[] {
  const n = providers.length;
  if (n <= 1) return providers.slice();
  const shift = ((Math.trunc(offset) % n) + n) % n;
  if (shift === 0) return providers.slice();
  return [...providers.slice(shift), ...providers.slice(0, shift)];
}

/**
 * I provider attivi con la rotazione APPLICATA (se accesa): la stessa catena di `activeProviders`, ma
 * ruotata in base alla finestra temporale corrente, così la testa cambia nel tempo. Con rotazione
 * spenta, o con 0/1 provider, è identica ad `activeProviders`. La usa l'inoltro delle chat (forwardChat)
 * per spalmare il consumo; il pannello, le sonde e la salute restano sull'ordine stabile del registro.
 */
export function rotatedProviders(
  env: Env = process.env,
  now: Date = new Date(),
): ReserveProvider[] {
  const providers = activeProviders(env);
  if (!rotationEnabled(env) || providers.length <= 1) return providers;
  const offset = Math.floor(now.getTime() / rotateWindowMs(env));
  return rotateProviders(providers, offset);
}

/** Le etichette dei provider attivi, per i messaggi di stato (nessun segreto). */
export function reserveProviderLabels(env: Env = process.env): string[] {
  return activeProviders(env).map((provider) => provider.label);
}

/** I nomi delle variabili-chiave di tutti i provider conosciuti (per i messaggi "non configurato"). */
export function reserveProviderKeyNames(): string[] {
  return PROVIDER_DEFS.map((def) => def.keyVar);
}

/** Scheda statica di un provider conosciuto (nessun segreto): per il pannello admin. */
export interface ReserveKnownProvider {
  id: string;
  label: string;
  baseUrl: string;
  keyVar: string;
  signupUrl: string;
  models: string[];
}

/** Il registro COMPLETO dei provider conosciuti (attivi o no), con modelli e dove prendere la chiave. */
export function reserveKnownProviders(env: Env = process.env): ReserveKnownProvider[] {
  return PROVIDER_DEFS.map((def) => ({
    id: def.id,
    label: def.label,
    // Per un provider configurabile via env (local LLM) mostriamo l'URL attuale, se c'è; altrimenti
    // stringa vuota, come segnale che il provider esiste ma manca l'indirizzo.
    baseUrl: baseUrlFrom(def, env) ?? '',
    keyVar: def.keyVar,
    signupUrl: def.signupUrl,
    models: dedupe(def.models(env)),
  }));
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
  timeoutMs: number,
): Promise<Response> {
  // Il campo response_format passa com'è SE porta un type: tipicamente `json_object` (JSON mode)
  // o `json_schema` (structured outputs OpenAI). Gli upstream che non lo supportano rispondono con
  // un errore → la catena prova il provider successivo. tools/tool_choice sono inoltrati così come
  // sono: quando ARTEX o un altro agent fa tool-use, qui li vuole vedere l'LLM upstream.
  const payload = {
    model,
    messages: body.messages,
    stream: false as const,
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(typeof body.max_tokens === 'number' ? { max_tokens: body.max_tokens } : {}),
    ...(typeof body.parallel_tool_calls === 'boolean'
      ? { parallel_tool_calls: body.parallel_tool_calls }
      : {}),
    ...(body.response_format && typeof body.response_format.type === 'string'
      ? { response_format: body.response_format }
      : {}),
    ...(Array.isArray(body.tools) && body.tools.length > 0 ? { tools: body.tools } : {}),
    ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
    ...(typeof body.reasoning_effort === 'string' && body.reasoning_effort.length > 0
      ? { reasoning_effort: body.reasoning_effort }
      : {}),
  };
  return fetchImpl(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: providerHeaders(provider, { 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Inoltra una chat completion ai provider gratuiti e restituisce la PRIMA risposta OpenAI-shaped
 * riuscita così com'è (choices[0].message.content), che è esattamente ciò che il client riserva
 * legge. Failover: per «auto» ogni provider prova il suo modello di default e poi quello di scorta;
 * un errore di modello (400/404) passa al modello successivo, qualunque altro errore (401/403/429/
 * 5xx) o caduta di rete passa al PROVIDER successivo. Un modello esplicito è provato tale e quale su
 * ogni provider, finché uno lo riconosce. Senza alcun provider configurato → 503; se tutti falliscono
 * → 502 (upstream_error con l'ultimo status, o upstream_unreachable se nessuno ha mai risposto);
 * se il budget della catena (RESERVE_CHAIN_BUDGET_MS) finisce o i provider sono solo lenti → 504
 * upstream_timeout. Ogni tentativo dura al più RESERVE_ATTEMPT_TIMEOUT_MS e mai più del tempo che resta.
 * Se la rotazione è accesa (AI_RESERVE_ROTATE), la catena parte da un provider diverso a ogni finestra
 * temporale (rotatedProviders), per spalmare il consumo sui tier gratuiti; il failover resta identico.
 */
export async function forwardChat(
  body: ReserveChatBody,
  env: Env = process.env,
  fetchImpl: FetchLike = fetch,
  now: Date = new Date(),
): Promise<Response> {
  const providers = rotatedProviders(env, now);
  if (providers.length === 0) return jsonResponse({ error: 'upstream_not_configured' }, 503);

  const requested = body.model?.trim();
  const explicit = requested && requested.toLowerCase() !== 'auto' ? requested : null;
  // Una sola scadenza per tutta la catena: ogni tentativo ha al più RESERVE_ATTEMPT_TIMEOUT_MS e mai
  // più del tempo che resta, così un provider lento cede il posto al successivo invece di esaurire
  // il limite della route.
  const deadline =
    Date.now() + durationFrom(env, 'AI_RESERVE_CHAIN_BUDGET_MS', RESERVE_CHAIN_BUDGET_MS);
  const attemptCap = durationFrom(env, 'AI_RESERVE_ATTEMPT_TIMEOUT_MS', RESERVE_ATTEMPT_TIMEOUT_MS);

  let sawHttpError = false;
  let lastStatus = 0;
  let lastDetail: string | null = null;
  // Opt-in (solo chi lo chiede, es. la chat DeepSeek): conserva il messaggio d'errore del provider.
  const wantDetail = clean(env.AI_RESERVE_ERROR_DETAIL) === '1';
  let outOfTime = false;
  let sawTimeout = false;
  chain: for (const provider of providers) {
    const candidates = explicit ? [explicit] : provider.models;
    for (const model of candidates) {
      const left = deadline - Date.now();
      if (left < Math.min(MIN_ATTEMPT_MS, attemptCap)) {
        outOfTime = true;
        break chain;
      }
      let upstream: Response;
      let text: string | null = null;
      try {
        upstream = await callProviderChat(
          provider,
          model,
          body,
          fetchImpl,
          Math.min(attemptCap, left),
        );
        // Anche la lettura del corpo sta dentro il timeout del tentativo (stesso segnale).
        if (upstream.ok) text = await upstream.text();
      } catch (error) {
        // Provider lento (il tentativo ha superato il suo tempo) o rete caduta → provider successivo.
        if (
          error instanceof Error &&
          (error.name === 'TimeoutError' || error.name === 'AbortError')
        ) {
          sawTimeout = true;
        }
        continue chain;
      }
      if (upstream.ok) return passthrough(text ?? '');
      sawHttpError = true;
      lastStatus = upstream.status;
      if (wantDetail) {
        lastDetail = providerErrorDetail(
          provider.label,
          upstream.status,
          await upstream.text().catch(() => ''),
        );
      } else {
        await upstream.body?.cancel().catch(() => undefined);
      }
      if (looksLikeModelError(upstream.status)) continue; // modello ritirato → prova lo scorta
      break; // 401/403/429/5xx → provider successivo
    }
  }
  if (!sawHttpError && (outOfTime || sawTimeout)) {
    return jsonResponse({ error: 'upstream_timeout' }, 504);
  }
  return jsonResponse(
    sawHttpError
      ? {
          error: 'upstream_error',
          status: lastStatus,
          ...(wantDetail && lastDetail ? { detail: lastDetail } : {}),
        }
      : { error: 'upstream_unreachable' },
    502,
  );
}

/**
 * Il messaggio d'errore di un provider, leggibile e sicuro da mostrare all'admin: una riga, al più
 * 200 caratteri, con ogni cosa che somigli a una chiave mascherata. Formati OpenAI/OpenRouter
 * ({error:{message}} o {error:"…"}) o testo semplice.
 */
export function providerErrorDetail(label: string, status: number, raw: string): string {
  let message = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    const err = parsed?.error;
    message =
      (err && typeof err === 'object' && 'message' in err ? String(err.message) : null) ??
      (typeof err === 'string' ? err : null) ??
      (typeof parsed?.message === 'string' ? parsed.message : null) ??
      raw;
  } catch {
    // testo semplice
  }
  const safe = message
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[chiave]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[…]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return `${label} ${status}${safe ? `: ${safe}` : ''}`;
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
        signal: AbortSignal.timeout(
          durationFrom(env, 'AI_RESERVE_MODELS_TIMEOUT_MS', RESERVE_MODELS_TIMEOUT_MS),
        ),
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

// ──────────────────────────────────────────────────────────────────────────────
// Scoperta automatica degli «AI agents» (cerca automatica dei modelli serviti ADESSO da ogni provider).
// I modelli hardcoded nel registro sono solo IPOTESI: i tier gratuiti ritirano modelli e azzerano quote
// di continuo (vedi i commenti su Gemini 2.0/1.5). Invece di indovinare, interroghiamo /models di ogni
// provider attivo e scopriamo cosa serve davvero ora. Sola lettura, nessun token speso, nessun segreto:
// alimenta il pannello admin, così un modello ritirato si vede subito e i modelli reali sono sempre a
// vista. NON tocca l'inoltro delle chat (forwardChat resta sui modelli «auto» del registro col failover).
// ──────────────────────────────────────────────────────────────────────────────

/** Quanti modelli al massimo riportare per provider; gli altri contano solo in modelCount. */
export const DISCOVER_MODELS_SAMPLE = 24;

/**
 * Estrae gli id dei modelli da una risposta /models OpenAI-shaped ({ data: [{ id }] }), in modo
 * tollerante: ignora voci senza id stringa, deduplica e ordina. Qualsiasi forma inattesa → lista vuota.
 */
export function parseModelIds(payload: unknown): string[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const entry of data) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && id.trim()) ids.push(id.trim());
  }
  return dedupe(ids).sort((a, b) => a.localeCompare(b));
}

/** Esito della scoperta /models di un provider: stato della sonda + modelli serviti ora (senza segreti). */
export interface ProviderDiscovery {
  id: string;
  label: string;
  status: number | null;
  ok: boolean;
  /** Id dei modelli serviti ora dal provider (ordinati, deduplicati; campione se sono molti). */
  models: string[];
  /** Quanti modelli ha restituito in tutto (models può essere solo un campione). */
  modelCount: number;
}

/**
 * «Cerca automatica di AI agents»: interroga /models di OGNI provider ATTIVO in parallelo e scopre i
 * modelli che ciascuno serve ADESSO. Sola lettura, nessun token speso, nessun segreto nel risultato.
 * Se un provider non risponde (o non ha chiave) → ok:false e lista vuota, senza rompere gli altri.
 * Alimenta il pannello admin; non partecipa all'inoltro delle chat.
 */
export async function discoverProviderModels(
  env: Env = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<ProviderDiscovery[]> {
  const providers = activeProviders(env);
  return Promise.all(
    providers.map(async (provider): Promise<ProviderDiscovery> => {
      try {
        const res = await fetchImpl(`${provider.baseUrl}/models`, {
          headers: providerHeaders(provider),
          cache: 'no-store',
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          return {
            id: provider.id,
            label: provider.label,
            status: res.status,
            ok: false,
            models: [],
            modelCount: 0,
          };
        }
        const payload = (await res.json().catch(() => null)) as unknown;
        const all = parseModelIds(payload);
        return {
          id: provider.id,
          label: provider.label,
          status: res.status,
          ok: true,
          models: all.slice(0, DISCOVER_MODELS_SAMPLE),
          modelCount: all.length,
        };
      } catch {
        return {
          id: provider.id,
          label: provider.label,
          status: null,
          ok: false,
          models: [],
          modelCount: 0,
        };
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
