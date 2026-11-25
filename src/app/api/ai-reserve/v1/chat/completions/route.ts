// @polsia:user-owned — POST /api/ai-reserve/v1/chat/completions del connettore "Riserva AI".
// Endpoint OpenAI-compatibile, non-streaming. Verifica il Bearer (FREELLMAPI_API_KEY), valida il
// corpo con zod e inoltra a Groq (free tier). Nessun sameOrigin: è un endpoint MACCHINA autenticato
// dal token (nessun cookie, nessuna autorità ambientale), chiamato server-to-server dal client
// riserva di Solco, che non manda un header Origin. Il Bearer È l'autenticazione.
import 'server-only';
import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeReserve, forwardChat } from '@/lib/business/ai-reserve-connector.server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Una chat di ripiego può aspettare l'upstream: resta sotto il tetto della route.
export const maxDuration = 60;

// Tetto difensivo prima del parse JSON: body più grandi di così non passano
// comunque (Vercel Serverless cap 4.5MB; molti free-tier upstream rifiutano
// >1-2MB), ma dare qui un errore chiaro — con la dimensione e un suggerimento —
// è molto più utile che il 502 opaco `upstream_error 413` che si otterrebbe
// forwardando tale e quale. Clienti agentici (ARTEX in testa) sfiorano questo
// soffitto quando serializzano system+tools di un worker grosso.
const BODY_MAX_BYTES = 3_500_000;

/**
 * Chiavi (hash SHA-256 in hex, comma-separated) che ottengono la tier
 * `ai.reserve.heavy` invece di `ai.reserve` di default. Opt-in: nessuna chiave
 * = nessuna tier estesa. Pensato per ARTEX ("…796b") e simili clienti agentici.
 */
function heavyKeyHashes(): Set<string> {
  const raw = process.env.FREELLMAPI_HEAVY_KEY_HASHES ?? '';
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim().toLowerCase();
    if (/^[a-f0-9]{64}$/.test(trimmed)) out.add(trimmed);
  }
  return out;
}

/** Hash SHA-256 (hex) del token nell'Authorization: Bearer; null se assente/malformato. */
function bearerHash(headers: Headers): string | null {
  const auth = headers.get('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m?.[1]) return null;
  return createHash('sha256').update(m[1].trim()).digest('hex');
}

// Il content di un messaggio può essere una stringa semplice, un array di parti
// (OpenAI vision / tool_use / tool_result), o null (tipico di un assistant message
// che è SOLO una tool call). Le parti passano con passthrough: se un upstream non
// capisce un tipo di parte, risponde con un errore e la catena prova il successivo.
const contentValue = z.union([z.string(), z.array(z.object({}).passthrough()).max(64), z.null()]);

// Gli agent usano tool calls: role `tool` per i risultati di uno strumento,
// `tool_calls` sui messaggi dell'assistant, `tool_call_id`/`name` sui tool. Il resto
// dei campi passa com'è, così corpi OpenAI validi che questo validatore non conosce
// (es. `audio`, `refusal`) continuano a funzionare quando l'upstream li accetta.
const message = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: contentValue.optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.object({}).passthrough()).max(64).optional(),
  })
  .passthrough();

const bodySchema = z
  .object({
    model: z.string().max(200).optional(),
    // Lunghe conversation di agent (system + molti turni + tool_result) superano i 100 messaggi:
    // 500 copre chat di molti turni senza invitare a leak di memoria.
    messages: z.array(message).min(1).max(500),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    // 200k perché i reasoning model (gpt-oss-120b, o-series) spendono token interni oltre il
    // visibile; il budget di output passato dall'agent può superare i 32k.
    max_tokens: z.number().int().positive().max(200_000).optional(),
    response_format: z.object({ type: z.string().optional() }).passthrough().optional(),
    tools: z.array(z.object({}).passthrough()).max(128).optional(),
    tool_choice: z.union([z.string(), z.object({}).passthrough()]).optional(),
    parallel_tool_calls: z.boolean().optional(),
    // Accettato ma ignorato: la riserva è sempre non-streaming.
    stream: z.boolean().optional(),
  })
  .passthrough();

export async function POST(request: Request) {
  const auth = authorizeReserve(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // Early-reject dei body oltre il tetto: il forward a Groq/Magnetapi/etc. su
  // body così grandi finirebbe comunque in 502 upstream_error 413. Qui rispondi
  // con un 413 "solco-originated" che include la taglia vista e un suggerimento
  // concreto, così chi chiama (ARTEX agent in testa) sa cosa ridurre.
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > BODY_MAX_BYTES) {
    return NextResponse.json(
      {
        error: 'payload_too_large',
        size_bytes: declared,
        limit_bytes: BODY_MAX_BYTES,
        hint: 'Reduce the system prompt or trim the tools array; upstream providers reject payloads this large anyway.',
      },
      { status: 413 },
    );
  }

  // Tier: default per IP (15/min, 150/giorno). Chiavi designate via
  // FREELLMAPI_HEAVY_KEY_HASHES ottengono la tier "heavy" (60/min, 2000/giorno).
  // L'uso interno di Solco non passa di qui (forwardChat in-process), quindi
  // non è toccato in nessuno dei due casi.
  const heavy = heavyKeyHashes();
  const hash = bearerHash(request.headers);
  const tier = hash && heavy.has(hash) ? 'ai.reserve.heavy' : 'ai.reserve';
  const limited = await enforceRateLimit(tier, getRateLimitIdentity(null, request.headers));
  if (limited) return limited;

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    // Loghiamo il dettaglio del fail — solo path + codice + messaggio, NIENTE contenuto — così
    // dai Vercel runtime logs si vede subito quale campo fa saltare un agent (noi ne consumiamo
    // vari con payload shape leggermente diverse). Non va nel body della risposta per non far
    // leak di struttura ai caller.
    console.error(
      '[ai-reserve] invalid_request:',
      JSON.stringify(
        parsed.error.issues.slice(0, 10).map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      ),
    );
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const { stream: _ignored, ...body } = parsed.data;
  return forwardChat(body);
}
