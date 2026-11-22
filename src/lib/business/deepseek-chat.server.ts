// @polsia:user-owned — backend della chat «DeepSeek» (admin /admin/deepseek e /deepseek del bot).
// DEEPSEEK_BACKEND sceglie dove va la richiesta:
//   • "solco" (default): la Riserva AI di Solco, IN-PROCESS su Vercel (forwardChat), ristretta ai
//     provider DEEPSEEK_SOLCO_PROVIDERS (CSV di id; default "mwapi,mwapi-2" = le due chiavi MWAPI, con
//     failover fra loro). Solo per questa chat: il resto della Riserva non cambia. Modello:
//     DEEPSEEK_SOLCO_MODEL, default "auto" (= MWAPI_MODEL, poi MWAPI_FALLBACK_MODEL).
//   • "worker": POST /chat del worker yt-dlp (che inoltra a DEEPSEEK_ENDPOINT_URL), con
//     YTDLP_SERVICE_URL (HTTPS pubblico, anti-SSRF) e YTDLP_SERVICE_KEY(2) (Bearer, mai loggata).
import 'server-only';
import { z } from 'zod';
import { forwardChat } from '@/lib/business/ai-reserve-connector.server';
import { ytdlpServiceKey, ytdlpServiceUrl } from '@/lib/business/bot-video.server';
import type { DeepseekChatRequest } from '@/lib/contracts/deepseek-chat';

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;

/** Il worker gratuito può svegliarsi (~20 s) e il modello è grande: margine ampio, sotto maxDuration. */
export const DEEPSEEK_WORKER_TIMEOUT_MS = 110_000;

const WorkerChatSchema = z.object({
  reply: z.string(),
  model: z.string().optional(),
});

export type DeepseekOutcome =
  | { status: 'ok'; reply: string; model: string }
  | { status: 'not_configured' }
  | { status: 'failed'; error: DeepseekFailure };

export type DeepseekFailure =
  | 'worker_unauthorized'
  | 'chat_not_configured'
  | 'busy'
  | 'model_unreachable'
  | 'model_error'
  | 'timeout'
  | 'bad_response'
  // Rifiuti del provider (Riserva AI), dal codice HTTP che il provider ha restituito:
  | 'provider_auth' // 401/403: chiave rifiutata
  | 'provider_credit' // 402: credito esaurito / account senza pagamento
  | 'model_not_found' // 400/404: ID modello errato o non servito da quel provider
  | 'provider_rate_limited'; // 429

async function workerFailure(res: Response): Promise<DeepseekFailure> {
  if (res.status === 401) return 'worker_unauthorized';
  const detail = await res
    .json()
    .then((body: unknown) =>
      body && typeof body === 'object' && 'detail' in body ? String(body.detail) : '',
    )
    .catch(() => '');
  if (res.status === 503 && detail === 'busy') return 'busy';
  if (res.status === 503 && detail.startsWith('chat not configured')) return 'chat_not_configured';
  if (res.status === 503) return 'worker_unauthorized'; // worker senza WORKER_API_KEY: rifiuta tutto
  if (res.status === 504) return 'model_unreachable';
  return 'model_error';
}

/** Il budget della Riserva AI (catena di provider) deve restare sotto il maxDuration della route. */
export const DEEPSEEK_SOLCO_BUDGET_MS = 100_000;

/**
 * Tempi della Riserva per questa chat. Il default della Riserva (20 s per tentativo) è troppo poco per
 * MWAPI/Claude con risposte lunghe: ogni tentativo veniva troncato e la chat dava sempre «timeout».
 * Qui un tentativo può usare quasi tutto il budget (5 s di margine); un rifiuto rapido (401/429) passa
 * comunque subito alla seconda chiave.
 */
export function deepseekSolcoBudgets(timeoutMs: number): { chainMs: number; attemptMs: number } {
  const chainMs = Math.max(10_000, Math.min(timeoutMs, DEEPSEEK_SOLCO_BUDGET_MS));
  const attemptMs = Math.max(8_000, chainMs - 5_000);
  return { chainMs, attemptMs };
}

/** Provider della Riserva usati da questa chat, se DEEPSEEK_SOLCO_PROVIDERS non dice altro. */
export const DEEPSEEK_SOLCO_DEFAULT_PROVIDERS = 'mwapi,mwapi-2';

function clean(value: string | undefined): string | undefined {
  return value?.trim() ? value.trim() : undefined;
}

export function deepseekBackend(env: Env = process.env): 'solco' | 'worker' {
  return clean(env.DEEPSEEK_BACKEND)?.toLowerCase() === 'worker' ? 'worker' : 'solco';
}

function outgoingMessages(request: DeepseekChatRequest) {
  return [
    ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
    ...request.messages.map(({ role, content }) => ({ role, content })),
  ];
}

const ReserveReplySchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable().optional() }) }))
    .min(1),
});

/** Riserva AI di Solco, in-process: nessuna rete verso Solco stesso, nessuna chiave in più. */
async function askViaSolco(
  request: DeepseekChatRequest,
  env: Env,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<DeepseekOutcome> {
  const res = await forwardChat(
    {
      model: solcoModel(env),
      messages: outgoingMessages(request),
      temperature: request.temperature ?? 0.6,
      max_tokens: request.maxTokens ?? 2048,
    },
    {
      ...env,
      AI_RESERVE_PROVIDERS: clean(env.DEEPSEEK_SOLCO_PROVIDERS) ?? DEEPSEEK_SOLCO_DEFAULT_PROVIDERS,
      AI_RESERVE_CHAIN_BUDGET_MS: String(deepseekSolcoBudgets(timeoutMs).chainMs),
      AI_RESERVE_ATTEMPT_TIMEOUT_MS: String(deepseekSolcoBudgets(timeoutMs).attemptMs),
    },
    fetchImpl,
  );
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    if (res.status === 503) return { status: 'not_configured' };
    if (res.status === 504) return { status: 'failed', error: 'timeout' };
    if (res.status === 429) return { status: 'failed', error: 'busy' };
    return { status: 'failed', error: reserveFailure(body) };
  }
  const parsed = ReserveReplySchema.safeParse(body);
  const reply = parsed.success ? (parsed.data.choices[0]?.message.content ?? '') : '';
  if (!reply.trim()) return { status: 'failed', error: 'bad_response' };
  return { status: 'ok', reply, model: parsed.success ? (parsed.data.model ?? 'solco') : 'solco' };
}

/**
 * DEEPSEEK_SOLCO_MODEL ripulito: accetta anche il link della pagina del modello (es.
 * https://openrouter.ai/deepseek/deepseek-v4.1-flash) o un ID fra virgolette, e lo riduce all'ID
 * nudo che il provider si aspetta. Vuoto → "auto" (i modelli di default del provider).
 */
export function solcoModel(env: Env = process.env): string {
  let value = clean(env.DEEPSEEK_SOLCO_MODEL);
  if (!value) return 'auto';
  value = value.replace(/^["'`]+|["'`]+$/g, '').trim();
  const url = /^https?:\/\/(?:www\.)?openrouter\.ai\/(?:models\/)?([^?#]+)/i.exec(value);
  if (url?.[1]) value = url[1];
  return value.replace(/\/+$/, '') || 'auto';
}

/** La Riserva risponde {error:"upstream_error", status:<codice del provider>}: lo si rende leggibile. */
export function reserveFailure(body: unknown): DeepseekFailure {
  const status =
    body && typeof body === 'object' && 'status' in body
      ? Number((body as { status: unknown }).status)
      : 0;
  if (status === 401 || status === 403) return 'provider_auth';
  if (status === 402) return 'provider_credit';
  if (status === 400 || status === 404) return 'model_not_found';
  if (status === 429) return 'provider_rate_limited';
  return 'model_error';
}

export async function askDeepseek(
  request: DeepseekChatRequest,
  env: Env = process.env,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEEPSEEK_WORKER_TIMEOUT_MS,
): Promise<DeepseekOutcome> {
  if (deepseekBackend(env) === 'solco') return askViaSolco(request, env, fetchImpl, timeoutMs);
  return askViaWorker(request, env, fetchImpl, timeoutMs);
}

async function askViaWorker(
  request: DeepseekChatRequest,
  env: Env,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<DeepseekOutcome> {
  const base = ytdlpServiceUrl(env);
  const key = ytdlpServiceKey(env);
  if (!base || !key) return { status: 'not_configured' };

  const messages = outgoingMessages(request);

  let res: Response;
  try {
    res = await fetchImpl(`${base}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        messages,
        temperature: request.temperature ?? 0.6,
        max_tokens: request.maxTokens ?? 2048,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: 'failed', error: 'timeout' };
  }

  if (!res.ok) return { status: 'failed', error: await workerFailure(res) };

  const parsed = WorkerChatSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success || !parsed.data.reply.trim()) {
    return { status: 'failed', error: 'bad_response' };
  }
  return { status: 'ok', reply: parsed.data.reply, model: parsed.data.model ?? 'deepseek' };
}
