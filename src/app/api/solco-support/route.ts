// @polsia:user-owned

import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { runSupportAgent } from '@/lib/business/solco-support-agent.server';
import {
  assessSupportQuestion,
  SUPPORT_OUT_OF_SCOPE,
  sanitizeSupportTurns,
} from '@/lib/business/solco-support-policy';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
// L'agente può fare fino a tre giri con Claude (domanda → stato_account → risposta).
export const maxDuration = 60;
const AGENT_DEADLINE_MS = 50_000;

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
};

/** Un evento nel formato che il widget già legge (`choices[0].delta.content`). */
function sseChunk(text: string) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

const requestSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().trim().min(1).max(1200),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

function streamAnswer(answer: string) {
  return new Response(`${sseChunk(answer)}data: [DONE]\n\n`, { headers: SSE_HEADERS });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }

  const body = await readJsonLimited(request, 64 * 1024);
  if (!body.ok) return limitedJsonError(body);
  const parsed = requestSchema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const question = [...parsed.data.messages]
    .reverse()
    .find((message) => message.role === 'user')?.content;
  if (!question) {
    return NextResponse.json({ error: 'missing_question' }, { status: 400 });
  }

  const decision = assessSupportQuestion(question);
  if (decision === 'out_of_scope') return streamAnswer(SUPPORT_OUT_OF_SCOPE);

  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  const limited =
    (await enforceRateLimit(
      'solco.support',
      getRateLimitIdentity(session?.user.id ?? null, request.headers),
    )) ??
    // Tetto app-wide: ogni risposta è una richiesta a Claude a pagamento.
    (await enforceRateLimit('solco.support.global', 'global'));
  if (limited) return limited;

  const user = session ? { id: session.user.id, emailVerified: session.user.emailVerified } : null;
  const turns = sanitizeSupportTurns(parsed.data.messages);
  const encoder = new TextEncoder();
  // Chi chiude il widget (o la scadenza) interrompe anche la chiamata a Claude.
  const cancelled = new AbortController();
  const signal = AbortSignal.any([
    request.signal,
    cancelled.signal,
    AbortSignal.timeout(AGENT_DEADLINE_MS),
  ]);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => {
        if (cancelled.signal.aborted) return;
        controller.enqueue(encoder.encode(chunk));
      };
      await runSupportAgent({ turns, user, signal, emit: (text) => send(sseChunk(text)) });
      send('data: [DONE]\n\n');
      if (!cancelled.signal.aborted) controller.close();
    },
    cancel() {
      cancelled.abort();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
