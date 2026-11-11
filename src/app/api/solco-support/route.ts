// @polsia:user-owned

import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AiConfigurationError, chat } from '@/lib/ai/client';
import { auth } from '@/lib/auth';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  assessSupportQuestion,
  buildSupportMessages,
  SUPPORT_NOT_CONFIGURED,
  SUPPORT_OUT_OF_SCOPE,
  SUPPORT_TEMPORARY_ERROR,
  SUPPORT_UNKNOWN_ANSWER,
} from '@/lib/business/solco-support-policy';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

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
  const chunk = `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`;
  return new Response(chunk, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
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
  if (decision === 'unknown') return streamAnswer(SUPPORT_UNKNOWN_ANSWER);

  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  const limited = await enforceRateLimit(
    'solco.support',
    getRateLimitIdentity(session?.user.id ?? null, request.headers),
  );
  if (limited) return limited;

  try {
    const answer = await chat({
      messages: buildSupportMessages(question),
      task: 'general',
      temperature: 0.1,
      signal: AbortSignal.timeout(20_000),
    });
    return streamAnswer(answer.trim() || SUPPORT_UNKNOWN_ANSWER);
  } catch (error) {
    return streamAnswer(
      error instanceof AiConfigurationError ? SUPPORT_NOT_CONFIGURED : SUPPORT_TEMPORARY_ERROR,
    );
  }
}
