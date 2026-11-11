// @polsia:framework-owned - DO NOT EDIT. Code installed by polsia/modules/ai@0.2.0. Drift = commit rejected.
//
// POST /api/ai/chat — streaming chat relay to the Polsia AI proxy.
// SECURITY: every call is billed to the app owner, on the model the request
// names. Who may call it at all is decided by the user-owned
// src/lib/ai/authorize.ts, checked before the body is read.

import 'server-only';
import { NextResponse } from 'next/server';
import { authorizeAiChat } from '@/lib/ai/authorize';
import { AiConfigurationError, streamChat } from '@/lib/ai/client';
import { chatRequestSchema } from '@/lib/ai/schema';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // Explicit type: a changed signature in the app's authorize.ts fails the build.
  const denied: Response | null = await authorizeAiChat(req);
  if (denied) return denied;

  const json = await req.json().catch(() => null);
  const result = chatRequestSchema.safeParse(json);

  if (!result.success) {
    return NextResponse.json(
      { error: result.error.flatten().formErrors[0] ?? 'invalid_request' },
      { status: 400 },
    );
  }

  try {
    const upstream = await streamChat({
      messages: result.data.messages,
      model: result.data.model,
      task: result.data.task,
    });

    // Relay the OpenAI-compatible SSE stream straight through to the browser.
    return new Response(upstream.body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    });
  } catch (err) {
    if (err instanceof AiConfigurationError) {
      return NextResponse.json({ error: 'ai_not_configured' }, { status: 503 });
    }
    return NextResponse.json({ error: 'ai_request_failed' }, { status: 502 });
  }
}
