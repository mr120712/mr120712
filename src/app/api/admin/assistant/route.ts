// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { AiConfigurationError, chat } from '@/lib/ai/client';
import { auth } from '@/lib/auth';
import {
  buildAdminAssistantMessages,
  containsCredentialRequest,
  safeAssistantReply,
} from '@/lib/business/admin-assistant';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  AdminAssistantRequestSchema,
  AdminAssistantResponseSchema,
} from '@/lib/contracts/admin-assistant';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store, no-cache, must-revalidate' };
const credentialRefusal =
  'Non posso visualizzare, generare o richiedere credenziali private. Rimuovi eventuali segreti dal messaggio; posso aiutarti con informazioni operative non sensibili.';

function failure(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: privateHeaders });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return failure('forbidden_origin', 403);

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return failure('unauthorized', 401);
  if (session.user.role !== 'admin' || session.user.emailVerified !== true) {
    return failure('forbidden', 403);
  }

  const body = await readJsonLimited(request, 64 * 1024);
  if (!body.ok) return limitedJsonError(body);
  const parsed = AdminAssistantRequestSchema.safeParse(body.value);
  if (!parsed.success) return failure('invalid_request', 400);

  if (containsCredentialRequest(parsed.data.messages)) {
    return NextResponse.json(AdminAssistantResponseSchema.parse({ reply: credentialRefusal }), {
      headers: privateHeaders,
    });
  }

  const limited = await enforceRateLimit('admin.assistant', `user:${session.user.id}`);
  if (limited) {
    for (const [name, value] of Object.entries(privateHeaders)) limited.headers.set(name, value);
    return limited;
  }

  try {
    const reply = await chat({
      messages: buildAdminAssistantMessages(parsed.data.messages),
      task: 'general',
      temperature: 0.2,
    });
    const response = AdminAssistantResponseSchema.parse({ reply: safeAssistantReply(reply) });
    return NextResponse.json(response, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof AiConfigurationError) return failure('ai_not_configured', 503);
    return failure('assistant_unavailable', 502);
  }
}
