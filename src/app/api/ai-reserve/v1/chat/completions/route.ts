// @polsia:user-owned — POST /api/ai-reserve/v1/chat/completions del connettore "Riserva AI".
// Endpoint OpenAI-compatibile, non-streaming. Verifica il Bearer (FREELLMAPI_API_KEY), valida il
// corpo con zod e inoltra a Groq (free tier). Nessun sameOrigin: è un endpoint MACCHINA autenticato
// dal token (nessun cookie, nessuna autorità ambientale), chiamato server-to-server dal client
// riserva di Solco, che non manda un header Origin. Il Bearer È l'autenticazione.
import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeReserve, forwardChat } from '@/lib/business/ai-reserve-connector.server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Una chat di ripiego può aspettare l'upstream: resta sotto il tetto della route.
export const maxDuration = 60;

const bodySchema = z.object({
  model: z.string().max(200).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string(),
      }),
    )
    .min(1)
    .max(100),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(32_000).optional(),
  response_format: z.object({ type: z.string().optional() }).optional(),
  // Accettato ma ignorato: la riserva è sempre non-streaming.
  stream: z.boolean().optional(),
});

export async function POST(request: Request) {
  const auth = authorizeReserve(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // Tetto per IP: protegge i tetti giornalieri bassi dei provider gratuiti da una chiave condivisa.
  // L'uso interno di Solco non passa di qui (forwardChat in-process), quindi non è toccato.
  const limited = await enforceRateLimit('ai.reserve', getRateLimitIdentity(null, request.headers));
  if (limited) return limited;

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const { stream: _ignored, ...body } = parsed.data;
  return forwardChat(body);
}
