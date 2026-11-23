// @polsia:user-owned — GET /api/space-chat/v1/models: il pulsante «Prova» dello Space statico.
// Bearer SPACE_CHAT_API_KEY e CORS solo per lo Space (vedi space-chat.server.ts).
import 'server-only';
import { NextResponse } from 'next/server';
import {
  authorizeSpaceChat,
  huggingFaceConfig,
  spaceChatCors,
} from '@/lib/business/space-chat.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: spaceChatCors(request) });
}

export function GET(request: Request) {
  const headers = { ...spaceChatCors(request), 'Cache-Control': 'no-store' };
  const auth = authorizeSpaceChat(request);
  if (!auth.ok) {
    return NextResponse.json({ error: { message: auth.error } }, { status: auth.status, headers });
  }
  const hf = huggingFaceConfig();
  const id = hf ? (hf.model.split(':')[0] ?? hf.model) : 'solco-mwapi';
  return NextResponse.json({ object: 'list', data: [{ id, object: 'model' }] }, { headers });
}
