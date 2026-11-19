// @polsia:user-owned — GET /api/ai-reserve/v1/models del connettore "Riserva AI".
// Verifica il Bearer (FREELLMAPI_API_KEY) e poi fa da proxy a GET /models di Groq. Un 200 qui =
// "riserva pronta" per il monitoraggio (checkFreellmapi): catena connettore→Groq funzionante.
import 'server-only';
import { NextResponse } from 'next/server';
import { authorizeReserve, listModels } from '@/lib/business/ai-reserve-connector.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = authorizeReserve(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return listModels();
}
