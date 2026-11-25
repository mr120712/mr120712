// @polsia:user-owned — "AI potente" per ARTEX: endpoint OpenAI-compatibile che
// riceve il body tool-heavy di ARTEX e lo inoltra a Claude Sonnet 4.5 tramite
// l'endpoint OpenAI-compatibile di Anthropic (`/v1/chat/completions`). Teniamo
// la compressione dei tool-schemas (strip di tutte le `description` ricorsive,
// descrizioni di funzione tagliate a 60 char) sia per risparmiare token sia per
// stare entro i limiti del tier a pagamento.
//
// Auth in ingresso: bearer di riserva (FREELLMAPI_API_KEY) via authorizeReserve.
// Auth verso Anthropic: ANTHROPIC_API_KEY (già presente su Vercel production).
//
// Modello di default: `claude-sonnet-4-5` — migliore al mondo per tool-calling
// multi-step e reasoning di sicurezza (il profilo di ARTEX).
import 'server-only';
import { NextResponse } from 'next/server';
import { authorizeReserve } from '@/lib/business/ai-reserve-connector.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

const ANTHROPIC_OPENAI_COMPAT_URL = 'https://api.anthropic.com/v1/chat/completions';
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clean(v: string | undefined) {
  const t = v?.trim();
  return t && t.length > 0 ? t : undefined;
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

/** Comprime una tool definition OpenAI: nome + type + parameters + primi 60 char di description. */
function compressTool(tool: unknown): unknown {
  if (!isRecord(tool)) return tool;
  const fn = isRecord(tool.function) ? tool.function : null;
  if (!fn) return tool;
  const compressed: Record<string, unknown> = {
    ...(typeof tool.type === 'string' ? { type: tool.type } : { type: 'function' }),
    function: {
      ...(typeof fn.name === 'string' ? { name: fn.name } : {}),
      ...(typeof fn.description === 'string' ? { description: fn.description.slice(0, 60) } : {}),
      ...(fn.parameters !== undefined ? { parameters: stripDescriptions(fn.parameters) } : {}),
    },
  };
  return compressed;
}

/** Normalizza il nome del modello: se è un alias Groq o "auto", forza al default Claude. */
function resolveClaudeModel(requested: unknown): string {
  if (typeof requested !== 'string') return DEFAULT_CLAUDE_MODEL;
  const r = requested.trim();
  if (r.length === 0 || r === 'auto') return DEFAULT_CLAUDE_MODEL;
  // ARTEX manda ancora il vecchio id Groq (openai/gpt-oss-120b) perché il profilo
  // attivo lo porta: lo rimappiamo a Claude Sonnet 4.5 senza richiedere un
  // update lato ARTEX.
  if (r.startsWith('openai/') || r.startsWith('groq/')) return DEFAULT_CLAUDE_MODEL;
  return r;
}

export async function POST(request: Request) {
  const auth = authorizeReserve(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const raw = await request.json().catch(() => null);
  if (!isRecord(raw)) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const anthropicKey = clean(process.env.ANTHROPIC_API_KEY);
  if (!anthropicKey) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY_missing' }, { status: 503 });
  }

  const compressedTools = Array.isArray(raw.tools) ? raw.tools.map(compressTool) : undefined;

  // Claude accetta max_tokens fra 1 e 8192 su Sonnet. Default: 4096 — margine
  // ampio per risposte lunghe multi-tool senza sprecare quota se ARTEX non chiede.
  const requestedMaxTokens =
    typeof raw.max_tokens === 'number' && raw.max_tokens > 0 ? raw.max_tokens : 4096;
  const effectiveMaxTokens = Math.min(Math.max(requestedMaxTokens, 1024), 8192);

  const model = resolveClaudeModel(raw.model);

  // Costruisci il payload OpenAI-compatibile per Anthropic. Omettiamo
  // reasoning_effort e parallel_tool_calls (Groq-only); omettiamo response_format
  // perché l'endpoint OpenAI-compat di Anthropic non lo supporta uniformemente.
  const payload: Record<string, unknown> = {
    model,
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    max_tokens: effectiveMaxTokens,
    stream: false,
    ...(typeof raw.temperature === 'number' ? { temperature: raw.temperature } : {}),
    ...(typeof raw.top_p === 'number' ? { top_p: raw.top_p } : {}),
    ...(compressedTools && compressedTools.length > 0 ? { tools: compressedTools } : {}),
    ...(typeof raw.tool_choice === 'string' || isRecord(raw.tool_choice)
      ? { tool_choice: raw.tool_choice as string | Record<string, unknown> }
      : {}),
  };

  console.log(
    `[artex-llm] in: model=${model} msgs=${Array.isArray(raw.messages) ? raw.messages.length : 0} ` +
      `tools=${compressedTools?.length ?? 0} max_tokens=${effectiveMaxTokens} ` +
      `tool_choice=${JSON.stringify(payload.tool_choice)}`,
  );

  const callAnthropic = async () =>
    fetch(ANTHROPIC_OPENAI_COMPAT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${anthropicKey}`,
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: AbortSignal.timeout(60_000),
    });

  // Retry su 429 Anthropic rispettando retry-after header (standard HTTP).
  const parseRetryAfterMs = (headerVal: string | null): number => {
    const h = headerVal ? Number.parseFloat(headerVal) : NaN;
    if (Number.isFinite(h) && h > 0) return Math.min(h * 1000, 20_000);
    return 3_000;
  };

  let res = await callAnthropic();
  let bodyText = await res.clone().text().catch(() => '');
  const MAX_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_RETRIES && (res.status === 429 || res.status === 529); attempt++) {
    const waitMs = parseRetryAfterMs(res.headers.get('retry-after'));
    console.log(
      `[artex-llm] ${res.status} attempt=${attempt} waiting=${waitMs}ms preview=${bodyText.slice(0, 200)}`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
    res = await callAnthropic();
    bodyText = await res.clone().text().catch(() => '');
  }

  console.log(
    `[artex-llm] anthropic out: status=${res.status} body_len=${bodyText.length} ` +
      `preview=${bodyText.slice(0, 500)}`,
  );
  return new NextResponse(bodyText, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}
