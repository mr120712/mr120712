// @polsia:user-owned — admin one-shot: imposta ARTEX active LLM config su
// Groq DIRETTAMENTE (api.groq.com), bypassando il nostro adapter. Usa
// GROQ_API_KEY come api_key. Pensato per il tier a pagamento di Groq dove
// non serve compressione/retry.
import 'server-only';
import { NextResponse } from 'next/server';
import { authorizeReserve } from '@/lib/business/ai-reserve-connector.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function clean(v: string | undefined) {
  const t = v?.trim();
  return t && t.length > 0 ? t : undefined;
}

export async function POST(request: Request) {
  const auth = authorizeReserve(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const artexUrl = clean(process.env.ARTEX_URL)?.replace(/\/+$/, '');
  const artexPassword = clean(process.env.ARTEX_PASSWORD);
  const artexUsername = clean(process.env.ARTEX_USERNAME) ?? 'ARTEX';
  const preauthToken = clean(process.env.ARTEX_TOKEN);
  const groqKey = clean(process.env.GROQ_API_KEY);
  if (!artexUrl) return NextResponse.json({ error: 'ARTEX_URL_missing' }, { status: 500 });
  if (!groqKey) return NextResponse.json({ error: 'GROQ_API_KEY_missing' }, { status: 500 });

  let artexToken = preauthToken;
  if (!artexToken) {
    if (!artexPassword) {
      return NextResponse.json({ error: 'ARTEX_TOKEN_or_PASSWORD_missing' }, { status: 500 });
    }
    const loginRes = await fetch(`${artexUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: artexUsername, password: artexPassword }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!loginRes.ok) {
      return NextResponse.json(
        { error: 'artex_login_failed', status: loginRes.status },
        { status: 502 },
      );
    }
    const loginJson = (await loginRes.json().catch(() => null)) as { token?: unknown } | null;
    const tok = loginJson && typeof loginJson.token === 'string' ? loginJson.token.trim() : '';
    if (!tok) return NextResponse.json({ error: 'artex_login_no_token' }, { status: 502 });
    artexToken = tok;
  }

  const config = {
    name: 'Groq-Direct-Paid',
    provider: 'openai',
    format: 'openai',
    base_url: 'https://api.groq.com/openai/v1',
    api_key: groqKey,
    model: 'openai/gpt-oss-120b',
    context_window_k: 131,
    streaming: false,
    priority: 0,
    pool_exclude: false,
  };

  // 1) Upsert come profilo (tollera errore duplicate-name).
  const r1 = await fetch(`${artexUrl}/api/llm/profiles`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${artexToken}`,
    },
    body: JSON.stringify(config),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  const upsertBody = await r1.text().catch(() => '');

  // 2) Imposta come LLM attivo.
  const r2 = await fetch(`${artexUrl}/api/llm`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${artexToken}`,
    },
    body: JSON.stringify(config),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  const activeBody = await r2.text().catch(() => '');

  return NextResponse.json({
    upsert: { status: r1.status, body: upsertBody.slice(0, 300) },
    active: { status: r2.status, body: activeBody.slice(0, 300) },
  });
}
