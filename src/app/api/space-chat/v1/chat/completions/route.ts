// @polsia:user-owned — POST /api/space-chat/v1/chat/completions: chat OpenAI-compatibile per lo
// Space statico privato (vedi space-chat.server.ts). Cancello: pass di sessione (da /gate) o
// SPACE_CHAT_API_KEY, Origin ammesso, CORS solo per lo Space, limite 'space.chat'. Modello: OBLITERATUS su Hugging Face (HF_INFERENCE_TOKEN), altrimenti
// la catena di /ds (MWAPI). Nessun sameOrigin: chiamata
// cross-origin dal browser, autenticata dalla chiave (nessun cookie).
import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { askDeepseek } from '@/lib/business/deepseek-chat.server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import {
  askHuggingFace,
  authorizeSpaceChat,
  huggingFaceConfig,
  rejectSpaceChat,
  spaceChatCors,
  sseReply,
} from '@/lib/business/space-chat.server';
import { DeepseekChatRequestSchema } from '@/lib/contracts/deepseek-chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const BodySchema = z.object({
  model: z.string().max(200).optional(),
  messages: z
    .array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }))
    .min(1)
    .max(60),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(32_000).optional(),
  stream: z.boolean().optional(),
});

const FAILURE_STATUS: Record<string, number> = {
  timeout: 504,
  model_unreachable: 504,
  busy: 503,
  provider_rate_limited: 503,
};

export function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: spaceChatCors(request) });
}

export async function POST(request: Request) {
  const cors = { ...spaceChatCors(request), 'Cache-Control': 'no-store' };
  const fail = (error: string, status: number, detail?: string) =>
    NextResponse.json(
      { error: { message: detail ? `${error}: ${detail}` : error, type: error } },
      { status, headers: cors },
    );

  const auth = authorizeSpaceChat(request);
  if (!auth.ok) return rejectSpaceChat(request, auth, cors);

  const limited = await enforceRateLimit('space.chat', 'space:owner');
  if (limited) {
    for (const [name, value] of Object.entries(cors)) limited.headers.set(name, value);
    return limited;
  }

  const raw = await readJsonLimited(request, 256 * 1024);
  if (!raw.ok) return limitedJsonError(raw);
  const body = BodySchema.safeParse(raw.value);
  if (!body.success) return fail('invalid_request', 400);

  // Prompt di sistema a parte; la conversazione (ultimi 40 turni) deve finire con l'utente.
  const system = body.data.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
    .slice(0, 4000);
  const turns = body.data.messages
    .filter((m): m is { role: 'user' | 'assistant'; content: string } => m.role !== 'system')
    .slice(-40);
  const request_ = DeepseekChatRequestSchema.safeParse({
    ...(system.trim() ? { system } : {}),
    messages: turns,
    temperature: body.data.temperature,
    maxTokens:
      body.data.max_tokens !== undefined
        ? Math.max(64, Math.min(8192, body.data.max_tokens))
        : undefined,
  });
  if (!request_.success)
    return fail('invalid_request', 400, 'ultimo messaggio non dell’utente o troppo lungo');

  // Con HF_INFERENCE_TOKEN: il modello OBLITERATUS su Hugging Face (nessun ripiego silenzioso su
  // Claude: un errore si vede come tale). Senza: la catena MWAPI di /ds.
  const hf = huggingFaceConfig();
  let outcome: { reply: string; model: string };
  if (hf) {
    const answer = await askHuggingFace(request_.data, hf);
    if (answer.status === 'failed') return fail(answer.error, answer.httpStatus, answer.detail);
    outcome = answer;
  } else {
    const answer = await askDeepseek(request_.data);
    if (answer.status === 'not_configured') {
      return fail('not_configured', 503, 'MWAPI_API_KEY mancante');
    }
    if (answer.status === 'failed') {
      return fail(answer.error, FAILURE_STATUS[answer.error] ?? 502, answer.detail);
    }
    outcome = answer;
  }

  if (body.data.stream) {
    return new Response(sseReply(outcome.reply, outcome.model), {
      headers: { ...cors, 'content-type': 'text/event-stream; charset=utf-8' },
    });
  }
  return NextResponse.json(
    {
      object: 'chat.completion',
      model: outcome.model,
      choices: [
        { index: 0, message: { role: 'assistant', content: outcome.reply }, finish_reason: 'stop' },
      ],
    },
    { headers: cors },
  );
}
