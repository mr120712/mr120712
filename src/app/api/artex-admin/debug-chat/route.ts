// @polsia:user-owned — debug: crea conversation ARTEX, invia prompt, polla,
// ritorna TUTTI gli items raw del activity stream (nessun filtro). Serve a
// capire perché /compare vede solo il placeholder "(no text summary".
import 'server-only';
import { NextResponse } from 'next/server';
import { authorizeReserve } from '@/lib/business/ai-reserve-connector.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

function clean(v: string | undefined) {
  const t = v?.trim();
  return t && t.length > 0 ? t : undefined;
}

export async function POST(request: Request) {
  const auth = authorizeReserve(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const artexUrl = clean(process.env.ARTEX_URL)?.replace(/\/+$/, '');
  const artexPassword = clean(process.env.ARTEX_PASSWORD);
  if (!artexUrl || !artexPassword) {
    return NextResponse.json({ error: 'env_missing' }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    agentKey?: string;
    prompt?: string;
    timeoutMs?: number;
  };
  const agentKey = body.agentKey ?? 'mainagent';
  const prompt = body.prompt ?? 'Ciao, dimmi cosa è un XSS in 2 righe.';
  const timeoutMs = Math.min(body.timeoutMs ?? 60_000, 80_000);

  // Login
  const loginRes = await fetch(`${artexUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ARTEX', password: artexPassword }),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!loginRes.ok) return NextResponse.json({ error: 'login_failed' }, { status: 502 });
  const { token } = (await loginRes.json()) as { token: string };

  const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

  // Create conversation
  const convRes = await fetch(`${artexUrl}/api/conversations`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ agent_key: agentKey, title: 'debug' }),
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  if (!convRes.ok)
    return NextResponse.json(
      { error: 'create_failed', status: convRes.status, body: await convRes.text() },
      { status: 502 },
    );
  const { id: convId } = (await convRes.json()) as { id: number };

  // Send message
  const msgRes = await fetch(`${artexUrl}/api/conversations/${convId}/messages`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ message: prompt }),
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  if (!msgRes.ok)
    return NextResponse.json(
      { error: 'send_failed', status: msgRes.status, body: await msgRes.text(), convId },
      { status: 502 },
    );

  // Poll activity
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  let running = true;
  const allItems: unknown[] = [];
  while (Date.now() < deadline && running) {
    const remaining = Math.max(2_000, deadline - Date.now());
    const pageRes = await fetch(
      `${artexUrl}/api/conversations/${convId}/messages?since=${cursor}`,
      {
        method: 'GET',
        headers: authHeaders,
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.min(10_000, remaining)),
      },
    );
    if (!pageRes.ok) break;
    const page = (await pageRes.json()) as {
      items: unknown[];
      cursor: number;
      running: boolean;
    };
    cursor = page.cursor;
    running = page.running;
    allItems.push(...page.items);
    if (!running) break;
    await new Promise((r) => setTimeout(r, 1500));
  }

  return NextResponse.json({ convId, running, totalItems: allItems.length, items: allItems });
}
