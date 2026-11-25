// @polsia:user-owned — proxy OpenAI-compatible verso il gateway LLM locale.
// Una chiamata = un modello. Il client fa fan-out di N richieste parallele a
// questa route, così le risposte compaiono una a una.
//
// La route STREAMA sempre (stream: true verso l'upstream, stream_options.
// include_usage per avere i token alla fine). Se l'upstream restituisce HTTP
// non-ok PRIMA che inizi lo stream, la route risponde con una busta JSON
// `{status:'error', error, latencyMs}` (CompareResult) — così il client può
// gestire i due casi con lo stesso contratto.
//
// Variabili d'ambiente richieste (in .env.local):
//   LOCAL_LLM_BASE_URL   es. http://192.168.0.117:8080
//   LOCAL_LLM_KEY        bearer token del gateway

import 'server-only';
import { NextResponse } from 'next/server';
import { CompareRequest, type CompareResult } from '@/lib/contracts/compare';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Finestra di tolleranza oltre il nostro timeout (vedi UPSTREAM_TIMEOUT_MS).
export const maxDuration = 120;

const UPSTREAM_TIMEOUT_MS = 90_000;

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

  // Timeout upstream + propagazione del disconnect del client (cancel del fetch
  // nel browser deve davvero fermare la chiamata al gateway).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const onClientAbort = () => controller.abort();
  req.signal.addEventListener('abort', onClientAbort);

  const cleanup = () => {
    clearTimeout(timer);
    req.signal.removeEventListener('abort', onClientAbort);
  };

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
        stream: true,
        stream_options: { include_usage: true },
        ...(typeof temperature === 'number' ? { temperature } : {}),
        ...(typeof maxTokens === 'number' ? { max_tokens: maxTokens } : {}),
      }),
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const bodyText = await upstream.text().catch(() => '');
      const detail = bodyText ? bodyText.slice(0, 400) : '';
      const latencyMs = Date.now() - started;
      const result: CompareResult = {
        model,
        status: 'error',
        error: `HTTP ${upstream.status}${detail ? ` — ${detail}` : ''}`,
        latencyMs,
      };
      cleanup();
      return NextResponse.json(result);
    }

    // Relay dello stream SSE upstream. Aggancio cleanup alla chiusura della
    // pipe (il timer scade col setTimeout non cancellato se lo stream è lungo —
    // lo cancello comunque qui perché l'upstream ha accettato).
    clearTimeout(timer);

    const relayed = upstream.body.pipeThrough(
      new TransformStream({
        flush() {
          req.signal.removeEventListener('abort', onClientAbort);
        },
      }),
    );

    return new Response(relayed, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    });
  } catch (err) {
    cleanup();
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
  }
}
