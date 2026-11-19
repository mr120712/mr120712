// @polsia:user-owned — GET /api/ai-reserve/health: verifica PUBBLICA (senza token né admin) che la
// riserva AI gratuita interna (router multi-provider in stile FreeLLMAPI) funzioni. Interroga /models
// di OGNI provider gratuito configurato (cheap, non spende token) e riporta lo STATO REALE di ognuno
// per diagnosi: { reserve, active, providers[], checkedAt }. Nessun segreto (nessuna chiave, nessun
// elenco modelli). Cache in-memory di 60s per non pesare sugli upstream.
import 'server-only';
import { NextResponse } from 'next/server';
import { probeProviders } from '@/lib/business/ai-reserve-connector.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TTL_MS = 60_000;
let cached: { at: number; body: Record<string, unknown> } | null = null;

async function probe(now: number): Promise<Record<string, unknown>> {
  const checkedAt = new Date(now).toISOString();
  const providers = await probeProviders();
  const active = providers.length;
  const anyOk = providers.some((provider) => provider.ok);
  const reserve = active === 0 ? 'unconfigured' : anyOk ? 'ok' : 'down';
  return {
    reserve,
    active,
    providers: providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      status: provider.status,
      ok: provider.ok,
    })),
    checkedAt,
  };
}

export async function GET() {
  const now = Date.now();
  if (!cached || now - cached.at >= TTL_MS) {
    cached = { at: now, body: await probe(now) };
  }
  return NextResponse.json(cached.body, { headers: { 'cache-control': 'no-store' } });
}
