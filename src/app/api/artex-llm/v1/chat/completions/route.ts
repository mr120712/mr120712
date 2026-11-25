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
  forwardChat,
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

  // forwardChat è in-process: no rate-limit pubblico, no bearer re-verify,
  // va dritto al provider upstream (Groq con gpt-oss-120b di default).
  const res = await forwardChat(body);
  // Clona per leggere il body senza consumare lo stream della risposta.
  const clone = res.clone();
  const bodyText = await clone.text().catch(() => '');
  console.log(
    `[artex-llm] out: status=${res.status} body_len=${bodyText.length} ` +
      `preview=${bodyText.slice(0, 500)}`,
  );
  return res;
}
