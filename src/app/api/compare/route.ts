// @polsia:user-owned — proxy OpenAI-compatible verso il gateway LLM locale.
// Una chiamata = un modello. Il client fa fan-out di N richieste parallele a
// questa route, così le risposte compaiono una a una.
//
// Variabili d'ambiente richieste (in .env.local):
//   LOCAL_LLM_BASE_URL   es. http://192.168.0.117:8080
//   LOCAL_LLM_KEY        bearer token del gateway
//
// Non va in env.ts (framework-owned): lette da process.env qui dentro.

import 'server-only';
import { NextResponse } from 'next/server';
import { CompareRequest, type CompareResult } from '@/lib/contracts/compare';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Finestra di tolleranza oltre il nostro timeout (vedi UPSTREAM_TIMEOUT_MS).
export const maxDuration = 90;

const UPSTREAM_TIMEOUT_MS = 75_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readConfig(): { baseUrl: string; apiKey: string } | { error: string } {
  const baseUrl = process.env.LOCAL_LLM_BASE_URL?.trim();
  const apiKey = process.env.LOCAL_LLM_KEY?.trim();
  if (!baseUrl) return { error: 'LOCAL_LLM_BASE_URL non impostata (.env.local).' };
  if (!apiKey) return { error: 'LOCAL_LLM_KEY non impostata (.env.local).' };
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403 });
  }

  const parsed = CompareRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    const errors: Record<string, string> = {};
    for (const [field, messages] of Object.entries(fieldErrors)) {
      const message = messages?.[0];
      if (message) errors[field] = message;
    }
    return NextResponse.json({ errors }, { status: 400 });
  }

  const cfg = readConfig();
  if ('error' in cfg) {
    return NextResponse.json({ error: cfg.error }, { status: 500 });
  }

  const { model, prompt, temperature, maxTokens } = parsed.data;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof maxTokens === 'number' ? { max_tokens: maxTokens } : {}),
      }),
      cache: 'no-store',
      signal: controller.signal,
    });

    const latencyMs = Date.now() - started;
    const bodyText = await upstream.text();
    let body: unknown = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      body = bodyText;
    }

    if (!upstream.ok) {
      const detail =
        body && typeof body === 'object' && 'error' in body
          ? JSON.stringify((body as { error: unknown }).error)
          : typeof body === 'string'
            ? body.slice(0, 400)
            : '';
      const result: CompareResult = {
        model,
        status: 'error',
        error: `HTTP ${upstream.status}${detail ? ` — ${detail}` : ''}`,
        latencyMs,
      };
      return NextResponse.json(result);
    }

    const bodyObj = isRecord(body) ? body : {};
    const choices = Array.isArray(bodyObj.choices) ? bodyObj.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : null;
    const message = choice && isRecord(choice.message) ? choice.message : null;
    const content: string | null = typeof message?.content === 'string' ? message.content : null;
    const reasoning: string | null =
      typeof message?.reasoning === 'string' ? message.reasoning : null;
    const finishReason: string | null =
      typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
    const usageRaw = isRecord(bodyObj.usage) ? bodyObj.usage : null;
    const usage = usageRaw
      ? {
          promptTokens:
            typeof usageRaw.prompt_tokens === 'number' ? usageRaw.prompt_tokens : undefined,
          completionTokens:
            typeof usageRaw.completion_tokens === 'number' ? usageRaw.completion_tokens : undefined,
          totalTokens:
            typeof usageRaw.total_tokens === 'number' ? usageRaw.total_tokens : undefined,
        }
      : null;
    const resolvedModel: string | null = typeof bodyObj.model === 'string' ? bodyObj.model : null;

    const result: CompareResult = {
      model,
      status: 'ok',
      content,
      reasoning,
      error: null,
      latencyMs,
      usage,
      resolvedModel,
      finishReason,
    };
    return NextResponse.json(result);
  } catch (err) {
    const latencyMs = Date.now() - started;
    const aborted = err instanceof Error && err.name === 'AbortError';
    const result: CompareResult = {
      model,
      status: 'error',
      error: aborted
        ? `Timeout dopo ${Math.round(UPSTREAM_TIMEOUT_MS / 1000)}s`
        : err instanceof Error
          ? err.message
          : 'unknown_error',
      latencyMs,
    };
    return NextResponse.json(result);
  } finally {
    clearTimeout(timer);
  }
}
