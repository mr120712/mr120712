// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { requireSolcoPro } from '@/lib/business/solco-pro-entitlement';
import { createSongRequestSchema } from '@/lib/contracts/music-generation';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const providerUnavailable = () =>
  NextResponse.json({ error: 'music_provider_not_configured' }, { status: 503 });

// GET /api/music-generation — mantiene la libreria dietro la verifica Solco Pro.
// Provider e archivio audio privato non sono stati definiti: non esponiamo risultati
// come se la libreria fosse già disponibile.
export async function GET(request: Request) {
  const access = await requireSolcoPro(request);
  if (!access.allowed) return access.response;
  return providerUnavailable();
}

// POST /api/music-generation — non crea record finché non sono configurati un
// provider musicale reale e autorizzato e le relative condizioni d’uso.
export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const access = await requireSolcoPro(request);
  if (!access.allowed) return access.response;

  const body = await request.json().catch(() => null);
  const parsed = createSongRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_prompt', message: 'Descrivi il brano in almeno 20 caratteri.' },
      { status: 400 },
    );
  }

  return providerUnavailable();
}
