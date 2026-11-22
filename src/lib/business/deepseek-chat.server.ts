// @polsia:user-owned — chiama POST /chat del worker yt-dlp (che inoltra al server DeepSeek dell'owner).
// Riusa YTDLP_SERVICE_URL (HTTPS pubblico, anti-SSRF) e YTDLP_SERVICE_KEY (Bearer, mai loggata).
import 'server-only';
import { z } from 'zod';
import { ytdlpServiceKey, ytdlpServiceUrl } from '@/lib/business/bot-video.server';
import type { DeepseekChatRequest } from '@/lib/contracts/deepseek-chat';

type Env = Record<string, string | undefined>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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
  | 'bad_response';

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

export async function askDeepseek(
  request: DeepseekChatRequest,
  env: Env = process.env,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEEPSEEK_WORKER_TIMEOUT_MS,
): Promise<DeepseekOutcome> {
  const base = ytdlpServiceUrl(env);
  const key = ytdlpServiceKey(env);
  if (!base || !key) return { status: 'not_configured' };

  const messages = [
    ...(request.system ? [{ role: 'system', content: request.system }] : []),
    ...request.messages.map(({ role, content }) => ({ role, content })),
  ];

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
