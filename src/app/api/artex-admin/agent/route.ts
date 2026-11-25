// @polsia:user-owned — admin passthrough per leggere/modificare un agent di
// ARTEX senza esporre il JWT: GET (default) legge /api/agents/<key>, POST
// scrive via /api/agents/<key> con il body che passi. Auth col bearer riserva.
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

async function loginArtex(url: string, password: string, username = 'ARTEX'): Promise<string> {
  const res = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`login_${res.status}`);
  const j = (await res.json().catch(() => null)) as { token?: unknown } | null;
  const tok = j && typeof j.token === 'string' ? j.token.trim() : '';
  if (!tok) throw new Error('no_token');
  return tok;
}

async function handle(request: Request, method: 'GET' | 'POST') {
  const auth = authorizeReserve(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const artexUrl = clean(process.env.ARTEX_URL)?.replace(/\/+$/, '');
  const artexPassword = clean(process.env.ARTEX_PASSWORD);
  const preauthToken = clean(process.env.ARTEX_TOKEN);
  if (!artexUrl) return NextResponse.json({ error: 'ARTEX_URL_missing' }, { status: 500 });

  const url = new URL(request.url);
  const key = url.searchParams.get('key') ?? 'auto';
  if (!/^[a-z][a-z0-9_-]{0,32}$/i.test(key)) {
    return NextResponse.json({ error: 'invalid_key' }, { status: 400 });
  }

  let token = preauthToken;
  if (!token) {
    if (!artexPassword) {
      return NextResponse.json({ error: 'ARTEX_TOKEN_or_PASSWORD_missing' }, { status: 500 });
    }
    try {
      token = await loginArtex(artexUrl, artexPassword);
    } catch (e) {
      return NextResponse.json(
        { error: 'artex_login_failed', detail: (e as Error).message },
        { status: 502 },
      );
    }
  }

  const upstreamUrl = `${artexUrl}/api/agents/${encodeURIComponent(key)}`;
  const init: RequestInit = {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  };
  if (method === 'POST') {
    const body = await request.text();
    init.body = body;
  }

  const r = await fetch(upstreamUrl, init);
  const text = await r.text();
  return new NextResponse(text, {
    status: r.status,
    headers: { 'content-type': r.headers.get('content-type') ?? 'application/json' },
  });
}

export async function GET(request: Request) {
  return handle(request, 'GET');
}

export async function POST(request: Request) {
  return handle(request, 'POST');
}
