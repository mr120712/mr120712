// @polsia:user-owned
//
// Who may call POST /api/ai/chat. Return null to allow, or a Response to refuse
// (the route returns it and never calls the AI proxy). Open by default; recipes
// in the ai module AGENT.md. Edit in place, keep the signature, and do not read
// the body here (use req.clone()).

import 'server-only';
import { chatRequestSchema } from '@/lib/ai/schema';
import { auth } from '@/lib/auth';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { readJsonLimited } from '@/lib/business/request-body.server';

const MAX_CHAT_BODY_BYTES = 48 * 1024;
const MAX_CHAT_CONTENT_CHARS = 16_000;

export async function authorizeAiChat(req: Request): Promise<Response | null> {
  const session = await auth.api.getSession({ headers: req.headers }).catch(() => null);
  const body = await readJsonLimited(req.clone(), MAX_CHAT_BODY_BYTES);
  if (!body.ok && body.status === 413) {
    return Response.json(
      {
        error: 'payload_too_large',
        message: 'La conversazione è troppo grande. Riduci il testo e riprova.',
      },
      { status: 413 },
    );
  }
  if (!body.ok) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  const parsed = chatRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.flatten().formErrors[0] ?? 'invalid_request' },
      { status: 400 },
    );
  }
  if (
    parsed.data.messages.reduce((total, message) => total + message.content.length, 0) >
    MAX_CHAT_CONTENT_CHARS
  ) {
    return Response.json(
      {
        error: 'payload_too_large',
        message: 'La conversazione supera il limite di testo consentito.',
      },
      { status: 413 },
    );
  }

  return enforceRateLimit('ai.chat', getRateLimitIdentity(session?.user.id ?? null, req.headers));
}
