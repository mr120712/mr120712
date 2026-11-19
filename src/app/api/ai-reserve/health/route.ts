// @polsia:user-owned — GET /api/ai-reserve/health: verifica PUBBLICA (senza token né admin) che la
// riserva AI gratuita interna (Groq in-process) funzioni. Interroga Groq /models (cheap, non spende
// token) e riporta lo STATO REALE di Groq per diagnosi: { reserve, groqStatus, detail }. Nessun
// segreto (chiave redatta, nessun elenco modelli). Cache in-memory di 60s per non pesare su Groq.
import 'server-only';
import { NextResponse } from 'next/server';
import { GROQ_BASE_URL, groqApiKey } from '@/lib/business/ai-reserve-connector.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TTL_MS = 60_000;
let cached: { at: number; body: Record<string, unknown> } | null = null;

async function probe(now: number): Promise<Record<string, unknown>> {
  const at = new Date(now).toISOString();
  const key = groqApiKey();
  if (!key) {
    return {
      reserve: 'unconfigured',
      groqStatus: null,
      detail: 'GROQ_API_KEY mancante',
      checkedAt: at,
    };
  }
  try {
    const r = await fetch(`${GROQ_BASE_URL}/models`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    let detail: string | undefined;
    if (r.status !== 200) {
      const text = await r.text().catch(() => '');
      try {
        const j = JSON.parse(text) as {
          error?: { code?: string; type?: string; message?: string };
        };
        detail = j.error?.code ?? j.error?.type ?? j.error?.message?.slice(0, 160);
      } catch {
        detail = text.slice(0, 160);
      }
      if (detail) detail = detail.replace(/(gsk|sk)[-_][A-Za-z0-9]+/g, '[REDACTED]');
    } else {
      await r.body?.cancel().catch(() => undefined);
    }
    return {
      reserve: r.status === 200 ? 'ok' : 'down',
      groqStatus: r.status,
      detail,
      checkedAt: at,
    };
  } catch (e) {
    return {
      reserve: 'down',
      groqStatus: null,
      detail: `Groq irraggiungibile (${e instanceof Error ? e.name : 'errore'})`,
      checkedAt: at,
    };
  }
}

export async function GET() {
  const now = Date.now();
  if (!cached || now - cached.at >= TTL_MS) {
    cached = { at: now, body: await probe(now) };
  }
  return NextResponse.json(cached.body, { headers: { 'cache-control': 'no-store' } });
}
