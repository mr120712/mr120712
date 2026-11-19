// @polsia:user-owned — GET /api/ai-reserve/v1 health: verifica PUBBLICA (senza token) che la
// riserva AI gratuita interna (Groq in-process) sia raggiungibile. Interroga Groq /models (cheap,
// non spende token) e riporta solo lo stato — nessun segreto, nessun elenco modelli. Cache in-memory
// di 60s per non interrogare Groq ad ogni richiesta. Serve a controllare «funziona?» da un URL,
// senza admin né il Bearer della riserva.
import 'server-only';
import { NextResponse } from 'next/server';
import { listModels, reserveStatusLabel } from '@/lib/business/ai-reserve-connector.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TTL_MS = 60_000;
let cached: { at: number; body: Record<string, unknown> } | null = null;

export async function GET() {
  const now = Date.now();
  if (!cached || now - cached.at >= TTL_MS) {
    const probe = await listModels();
    await probe.body?.cancel().catch(() => undefined);
    cached = {
      at: now,
      body: {
        reserve: reserveStatusLabel(probe.status),
        groqStatus: probe.status,
        checkedAt: new Date(now).toISOString(),
      },
    };
  }
  return NextResponse.json(cached.body, { headers: { 'cache-control': 'no-store' } });
}
