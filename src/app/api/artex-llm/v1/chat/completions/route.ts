// @polsia:user-owned — "AI potente" per ARTEX: endpoint OpenAI-compatibile che
// riceve il body tool-heavy di ARTEX, lo COMPRIME aggressivamente (strip
// descriptions, minify), poi lo inoltra alla reserve chain interna di Solco
// via forwardChat() (in-process, NIENTE rate limit public). Scopo: far
// rientrare il payload dell'agent `auto` sotto gli 8k TPM input del Groq free
// tier (il collo di bottiglia reale).
//
// Auth: stesso bearer di /api/ai-reserve/v1 (FREELLMAPI_API_KEY) via
// authorizeReserve — ARTEX già lo sa mandare.
//
// Modello di default: openai/gpt-oss-120b (il più potente free).
import 'server-only';
import { NextResponse } from 'next/server';
import {
  authorizeReserve,
  GROQ_BASE_URL,
  groqApiKey,
  type ReserveChatBody,
} from '@/lib/business/ai-reserve-connector.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Rimuove ricorsivamente ogni property `description` da un JSON schema. */
function stripDescriptions(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripDescriptions);
  if (!isRecord(obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'description') continue;
    out[k] = stripDescriptions(v);
  }
  return out;
}

/**
 * Comprime una tool definition OpenAI tenendo nome, type e la struttura dei
 * parameters, ma scartando descrizioni verbose. Il nome del tool e la struttura
 * dei parametri sono già quasi auto-esplicativi; il modello perde un po' di
 * guidance ma recupera molti token sul body.
 */
function compressTool(tool: unknown): unknown {
  if (!isRecord(tool)) return tool;
  const fn = isRecord(tool.function) ? tool.function : null;
  if (!fn) return tool;
  const compressed: Record<string, unknown> = {
    ...(typeof tool.type === 'string' ? { type: tool.type } : { type: 'function' }),
    function: {
      ...(typeof fn.name === 'string' ? { name: fn.name } : {}),
      // Tieni al massimo i primi 60 caratteri della description: suggerimento
      // minimo che aiuta il modello a disambiguare tool con nomi simili.
      ...(typeof fn.description === 'string' ? { description: fn.description.slice(0, 60) } : {}),
      ...(fn.parameters !== undefined ? { parameters: stripDescriptions(fn.parameters) } : {}),
    },
  };
  return compressed;
}

export async function POST(request: Request) {
  const auth = authorizeReserve(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const raw = await request.json().catch(() => null);
  if (!isRecord(raw)) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  // Comprimi l'array tools se presente. Lascia stare tutto il resto (messaggi,
  // temperature, tool_choice, ecc.): sono campi piccoli e il contenuto va
  // preservato per non rompere la conversation.
  const compressedTools = Array.isArray(raw.tools) ? raw.tools.map(compressTool) : undefined;

  // gpt-oss-120b di Groq è un reasoning model: senza un min di max_tokens alto,
  // consuma TUTTI i completion_tokens nel ragionamento interno (reasoning_tokens)
  // e torna con content="" + finish_reason="length". Clampiamo max_tokens a ≥ 1500
  // per lasciare spazio sia al ragionamento sia alla risposta. ARTEX spesso manda
  // 256/512 per economia; su un reasoning model è troppo poco.
  const MIN_MAX_TOKENS_FOR_REASONING = 1500;
  const requestedMaxTokens =
    typeof raw.max_tokens === 'number' && raw.max_tokens > 0 ? raw.max_tokens : 2048;
  const effectiveMaxTokens = Math.max(requestedMaxTokens, MIN_MAX_TOKENS_FOR_REASONING);

  // Costruisci il body per forwardChat. Default al modello più potente free.
  const body: ReserveChatBody = {
    ...(typeof raw.model === 'string' ? { model: raw.model } : { model: 'openai/gpt-oss-120b' }),
    messages: Array.isArray(raw.messages) ? (raw.messages as ReserveChatBody['messages']) : [],
    ...(typeof raw.temperature === 'number' ? { temperature: raw.temperature } : {}),
    ...(typeof raw.top_p === 'number' ? { top_p: raw.top_p } : {}),
    max_tokens: effectiveMaxTokens,
    ...(isRecord(raw.response_format)
      ? { response_format: raw.response_format as { type?: string } }
      : {}),
    ...(compressedTools ? { tools: compressedTools } : {}),
    ...(typeof raw.tool_choice === 'string' || isRecord(raw.tool_choice)
      ? { tool_choice: raw.tool_choice as string | Record<string, unknown> }
      : {}),
    ...(typeof raw.parallel_tool_calls === 'boolean'
      ? { parallel_tool_calls: raw.parallel_tool_calls }
      : {}),
    // Forza reasoning_effort="low" su gpt-oss: abbassa l'overhead di reasoning
    // tokens che altrimenti divora tutta la max_tokens prima che il modello
    // produca il content. Senza questo, content="" + finish_reason="length".
    reasoning_effort:
      typeof raw.reasoning_effort === 'string' && raw.reasoning_effort.length > 0
        ? raw.reasoning_effort
        : 'low',
  };

  // Log diagnostico: ARTEX classifica errori di shape/upstream come model_error
  // senza verbosità, quindi loggiamo noi il profilo della richiesta per capire
  // cosa sta mandando e cosa riceve.
  console.log(
    `[artex-llm] in: model=${body.model} msgs=${body.messages.length} ` +
      `tools=${Array.isArray(body.tools) ? body.tools.length : 0} ` +
      `max_tokens=${body.max_tokens} tool_choice=${JSON.stringify(body.tool_choice)} ` +
      `temp=${body.temperature} top_p=${body.top_p} re=${body.reasoning_effort}`,
  );

  // Chiama Groq DIRETTAMENTE (niente provider chain): forwardChat farebbe
  // failover a Cerebras/Gemini/Mistral quando Groq restituisce 429 o altro
  // errore, e quei provider non hanno "openai/gpt-oss-120b" → rispondono 404
  // (upstream_error 404). Qui vogliamo: se Groq fallisce, l'errore torna
  // intatto ad ARTEX che poi lo gestisce / riprova.
  const key = groqApiKey();
  if (!key) {
    return NextResponse.json({ error: 'GROQ_API_KEY_missing' }, { status: 503 });
  }
  const upstreamPayload = {
    model: body.model ?? 'openai/gpt-oss-120b',
    messages: body.messages,
    stream: false as const,
    max_tokens: body.max_tokens,
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(typeof body.parallel_tool_calls === 'boolean'
      ? { parallel_tool_calls: body.parallel_tool_calls }
      : {}),
    ...(body.response_format && typeof body.response_format.type === 'string'
      ? { response_format: body.response_format }
      : {}),
    ...(Array.isArray(body.tools) && body.tools.length > 0 ? { tools: body.tools } : {}),
    ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
    ...(body.reasoning_effort ? { reasoning_effort: body.reasoning_effort } : {}),
  };

  const callGroq = async () =>
    fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(upstreamPayload),
      cache: 'no-store',
      signal: AbortSignal.timeout(50_000),
    });

  // Retry su 429 TPM con backoff che rispetta il wait suggerito da Groq. ARTEX
  // classifica 429 come model_error e abbandona il turno; qui lo evitiamo.
  const parseRetryAfterMs = (headerVal: string | null, bodyMsg: string): number => {
    const h = headerVal ? Number.parseFloat(headerVal) : NaN;
    if (Number.isFinite(h) && h > 0) return Math.min(h * 1000, 20_000);
    const m = /try again in ([\d.]+)s/i.exec(bodyMsg);
    if (m) {
      const s = Number.parseFloat(m[1]);
      if (Number.isFinite(s) && s > 0) return Math.min(s * 1000 + 300, 20_000);
    }
    return 2_000;
  };

  let res = await callGroq();
  let bodyText = await res.clone().text().catch(() => '');
  const MAX_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_RETRIES && res.status === 429; attempt++) {
    const waitMs = parseRetryAfterMs(res.headers.get('retry-after'), bodyText);
    console.log(
      `[artex-llm] 429 attempt=${attempt} waiting=${waitMs}ms preview=${bodyText.slice(0, 200)}`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
    res = await callGroq();
    bodyText = await res.clone().text().catch(() => '');
  }

  console.log(
    `[artex-llm] groq-direct out: status=${res.status} body_len=${bodyText.length} ` +
      `preview=${bodyText.slice(0, 500)}`,
  );
  return new NextResponse(bodyText, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}
