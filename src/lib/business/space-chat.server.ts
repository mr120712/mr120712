// @polsia:user-owned — endpoint chat per lo Space statico privato su Hugging Face
// (Solcomusic/deepseek-static-chat). La pagina gira nel browser e chiama Solco direttamente:
//  • autenticazione: cancello (vedi sotto) — chiave SPACE_CHAT_API_KEY scambiata per un pass di
//    sessione firmato, legato all'origine; la chiave lunga non resta nel browser;
//  • CORS: solo le origini in SPACE_CHAT_ORIGINS (CSV), default l'origine dello Space;
//  • modello: la stessa catena di /ds e /admin/deepseek (askDeepseek → MWAPI chiave 1, poi 2).
// Nessun cookie: il pass (o la chiave) nell'header Authorization è l'autorizzazione.
import 'server-only';
import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { bearerMatches } from '@/lib/business/ai-reserve-connector.server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';

type Env = Record<string, string | undefined>;

export const SPACE_CHAT_DEFAULT_ORIGINS = [
  'https://solcomusic-deepseek-static-chat.static.hf.space',
];

export function spaceChatOrigins(env: Env = process.env): string[] {
  const listed = (env.SPACE_CHAT_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin));
  return listed.length > 0 ? listed : SPACE_CHAT_DEFAULT_ORIGINS;
}

/** Header CORS per l'origine della richiesta, solo se è fra quelle ammesse. */
export function spaceChatCors(request: Request, env: Env = process.env): Record<string, string> {
  const origin = request.headers.get('origin');
  const base = { Vary: 'Origin' };
  if (!origin || !spaceChatOrigins(env).includes(origin)) return base;
  return {
    ...base,
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '600',
  };
}

// ------------------------------------------------------------------ cancello (gate)
//
// La chiave lunga (SPACE_CHAT_API_KEY) non resta nel browser: la pagina la scambia una volta su
// POST /gate con un pass di sessione firmato (HMAC-SHA256), valido SPACE_CHAT_SESSION_TTL_MS e
// legato all'origine dello Space. Il pass funziona solo con quell'Origin; ruotare la chiave revoca
// tutti i pass. Una richiesta con un Origin non ammesso è rifiutata (403) anche con la chiave
// giusta; senza Origin (curl, strumenti del proprietario) vale solo la chiave lunga.

export const SPACE_CHAT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_PREFIX = 'ssg1';

export type SpaceChatAuth =
  | { ok: true; via: 'key' | 'session'; origin: string | null }
  | { ok: false; status: 401 | 403 | 503; error: string };

function secretOf(env: Env): string | null {
  const secret = env.SPACE_CHAT_API_KEY?.trim();
  return secret && secret.length >= 24 ? secret : null;
}

function presentedToken(request: Request): string | null {
  const token = /^Bearer\s+(.+)$/i.exec((request.headers.get('authorization') ?? '').trim())?.[1];
  return token?.trim() || null;
}

/** Chiave di firma derivata: la chiave lunga non firma mai direttamente. */
function signingKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('space-chat-gate:v1').digest();
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', signingKey(secret)).update(payload).digest('base64url');
}

export function issueSpaceChatSession(
  origin: string,
  env: Env = process.env,
  now = Date.now(),
): { token: string; expiresAt: number } | null {
  const secret = secretOf(env);
  if (!secret || !spaceChatOrigins(env).includes(origin)) return null;
  const expiresAt = now + SPACE_CHAT_SESSION_TTL_MS;
  const nonce = randomBytes(12).toString('base64url');
  const payload = `${SESSION_PREFIX}.${expiresAt}.${nonce}`;
  return { token: `${payload}.${sign(secret, `${payload}|${origin}`)}`, expiresAt };
}

export function verifySpaceChatSession(
  token: string,
  origin: string,
  secret: string,
  now = Date.now(),
): boolean {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== SESSION_PREFIX) return false;
  const [, exp, nonce, sig] = parts as [string, string, string, string];
  if (!/^\d{13}$/.test(exp) || !/^[\w-]{16}$/.test(nonce) || !/^[\w-]{43}$/.test(sig)) return false;
  const expiresAt = Number(exp);
  if (expiresAt <= now || expiresAt > now + SPACE_CHAT_SESSION_TTL_MS) return false;
  return bearerMatches(sig, sign(secret, `${SESSION_PREFIX}.${exp}.${nonce}|${origin}`));
}

/**
 * Il cancello di ogni endpoint dello Space. `allowSession: false` (solo /gate) pretende la chiave
 * lunga e un Origin ammesso.
 */
export function authorizeSpaceChat(
  request: Request,
  env: Env = process.env,
  { allowSession = true, requireOrigin = false, now = Date.now() } = {},
): SpaceChatAuth {
  const secret = secretOf(env);
  if (!secret) return { ok: false, status: 503, error: 'not_configured' };
  const origin = request.headers.get('origin');
  if (origin !== null && !spaceChatOrigins(env).includes(origin)) {
    return { ok: false, status: 403, error: 'origin_not_allowed' };
  }
  if (requireOrigin && origin === null) return { ok: false, status: 403, error: 'origin_required' };
  const token = presentedToken(request);
  if (!token) return { ok: false, status: 401, error: 'unauthorized' };
  if (bearerMatches(token, secret)) return { ok: true, via: 'key', origin };
  if (allowSession && origin !== null && verifySpaceChatSession(token, origin, secret, now)) {
    return { ok: true, via: 'session', origin };
  }
  return {
    ok: false,
    status: 401,
    error: token.startsWith(`${SESSION_PREFIX}.`) ? 'session_expired' : 'unauthorized',
  };
}

/** Identità per i limiti: l'IP scritto da Vercel (x-real-ip), mai un header del client. */
export function spaceChatClientId(request: Request): string {
  const ip = request.headers.get('x-real-ip')?.trim();
  return ip && isIP(ip) ? `ip:${ip.toLowerCase()}` : 'ip:unknown';
}

/**
 * Risposta a un accesso negato. Chiavi o pass sbagliati contano per IP ('space.auth-fail'):
 * oltre la soglia si riceve 429 invece di 401, così indovinare la chiave non è praticabile.
 */
export async function rejectSpaceChat(
  request: Request,
  auth: Extract<SpaceChatAuth, { ok: false }>,
  headers: Record<string, string>,
): Promise<Response> {
  if (auth.status !== 503) {
    const limited = await enforceRateLimit('space.auth-fail', spaceChatClientId(request));
    if (limited) {
      for (const [name, value] of Object.entries(headers)) limited.headers.set(name, value);
      return limited;
    }
  }
  return Response.json(
    { error: { message: auth.error, type: auth.error } },
    { status: auth.status, headers },
  );
}

/** Risposta in formato SSE di OpenAI (un solo pezzo): la pagina dello Space legge lo stream. */
export function sseReply(reply: string, model: string): string {
  const chunk = {
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

// ------------------------------------------------------------------ OBLITERATUS via Hugging Face

/** Modello OBLITERATUS servito da un provider di Hugging Face (Featherless). */
export const SPACE_CHAT_DEFAULT_HF_MODEL = 'OBLITERATUS/Qwen3.8-27B-OBLITERATED:featherless-ai';
const HF_ROUTER = 'https://router.huggingface.co/v1/chat/completions';

export type SpaceChatRequest = {
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  temperature?: number;
  maxTokens?: number;
};

export type SpaceChatOutcome =
  | { status: 'ok'; reply: string; model: string }
  | { status: 'failed'; error: string; httpStatus: number; detail?: string };

/**
 * Configurato se c'è HF_INFERENCE_TOKEN (segreto su Vercel). Il modello è SPACE_CHAT_HF_MODEL
 * (default Qwen3.8-27B-OBLITERATED su Featherless), fatturato a HF_BILL_TO (default Solcomusic,
 * collegata a Google Cloud). Senza token lo Space resta su MWAPI.
 */
export function huggingFaceConfig(env: Env = process.env) {
  const token = env.HF_INFERENCE_TOKEN?.trim();
  if (!token || token.length < 20 || /\s/.test(token)) return null;
  const model = env.SPACE_CHAT_HF_MODEL?.trim() || SPACE_CHAT_DEFAULT_HF_MODEL;
  const billTo = env.HF_BILL_TO?.trim() || 'Solcomusic';
  if (!/^[\w.-]+\/[\w.-]+(?::[\w.-]+)?$/.test(model) || !/^[\w.-]{1,96}$/.test(billTo)) return null;
  return { token, model, billTo };
}

function hfFailure(status: number, body: unknown, token: string): SpaceChatOutcome {
  const raw =
    body && typeof body === 'object' && 'error' in body ? (body as { error: unknown }).error : body;
  const message =
    typeof raw === 'string'
      ? raw
      : raw && typeof raw === 'object' && 'message' in raw
        ? String((raw as { message: unknown }).message)
        : `HTTP ${status}`;
  const detail = message.split(token).join('***').replace(/\s+/g, ' ').slice(0, 200);
  const error =
    status === 401 || status === 403
      ? 'provider_auth'
      : status === 402
        ? 'provider_credit'
        : status === 404 || status === 400
          ? 'model_not_found'
          : status === 429
            ? 'provider_rate_limited'
            : 'model_error';
  const httpStatus = status === 429 ? 503 : 502;
  return { status: 'failed', error, httpStatus, detail: `Hugging Face ${status}: ${detail}` };
}

export async function askHuggingFace(
  request: SpaceChatRequest,
  config: NonNullable<ReturnType<typeof huggingFaceConfig>>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 110_000,
): Promise<SpaceChatOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(HF_ROUTER, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        'x-hf-bill-to': config.billTo,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          ...(request.system ? [{ role: 'system', content: request.system }] : []),
          ...request.messages,
        ],
        temperature: request.temperature ?? 0.6,
        max_tokens: request.maxTokens ?? 2048,
        stream: false,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: 'failed', error: 'timeout', httpStatus: 504 };
  }
  const body = (await res.json().catch(() => null)) as {
    model?: string;
    choices?: { message?: { content?: string | null } }[];
  } | null;
  if (!res.ok) return hfFailure(res.status, body, config.token);
  const reply = body?.choices?.[0]?.message?.content ?? '';
  if (!reply.trim()) return { status: 'failed', error: 'bad_response', httpStatus: 502 };
  return { status: 'ok', reply, model: config.model.split(':')[0] ?? config.model };
}
