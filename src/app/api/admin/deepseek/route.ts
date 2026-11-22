// @polsia:user-owned — chat DeepSeek per l'amministratore: SOLO admin verificati, stessa origine,
// limite 'admin.deepseek'. Backend scelto da DEEPSEEK_BACKEND (vedi deepseek-chat.server.ts).
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isAuthorizedAdmin } from '@/lib/business/admin-account-policy';
import { askDeepseek, type DeepseekFailure } from '@/lib/business/deepseek-chat.server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  DeepseekChatRequestSchema,
  DeepseekChatResponseSchema,
} from '@/lib/contracts/deepseek-chat';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const privateHeaders = { 'Cache-Control': 'private, no-store, no-cache, must-revalidate' };

const failureStatus: Record<DeepseekFailure, number> = {
  worker_unauthorized: 503,
  chat_not_configured: 503,
  busy: 503,
  model_unreachable: 504,
  timeout: 504,
  model_error: 502,
  bad_response: 502,
};

function failure(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: privateHeaders });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return failure('forbidden_origin', 403);

  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    session = await auth.api.getSession({ headers: request.headers });
  } catch {
    return failure('session_unavailable', 503);
  }
  if (!session) return failure('unauthorized', 401);
  if (!isAuthorizedAdmin(session.user)) return failure('forbidden', 403);

  const body = await readJsonLimited(request, 128 * 1024);
  if (!body.ok) return limitedJsonError(body);
  const parsed = DeepseekChatRequestSchema.safeParse(body.value);
  if (!parsed.success) return failure('invalid_request', 400);

  const limited = await enforceRateLimit('admin.deepseek', `user:${session.user.id}`);
  if (limited) {
    for (const [name, value] of Object.entries(privateHeaders)) limited.headers.set(name, value);
    return limited;
  }

  const outcome = await askDeepseek(parsed.data);
  if (outcome.status === 'not_configured') return failure('worker_not_configured', 503);
  if (outcome.status === 'failed') return failure(outcome.error, failureStatus[outcome.error]);
  return NextResponse.json(
    DeepseekChatResponseSchema.parse({ reply: outcome.reply, model: outcome.model }),
    { headers: privateHeaders },
  );
}
