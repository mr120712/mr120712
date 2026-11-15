// @polsia:user-owned — stato di «Crea playlist»: chi è collegato, se ha Premium (le proposte con
// l'AI sono incluse nei piani a pagamento, come «Cerca con l'AI»), se la chiave Anthropic funziona e
// se il catalogo Audius è configurato. La pagina mostra le scelte senza AI a tutti.
import 'server-only';
import { NextResponse } from 'next/server';
import { playlistAiAvailable } from '@/lib/business/playlist-engine-ai.server';
import { currentAccess } from '@/lib/business/premium-access.server';
import { PlaylistEngineStatusSchema } from '@/lib/contracts/playlist-engine';
import { getAudiusActivation } from '@/lib/music/audius-source.server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [access, ai] = await Promise.all([
    currentAccess(),
    playlistAiAvailable().catch(() => false),
  ]);
  return NextResponse.json(
    PlaylistEngineStatusSchema.parse({ ...access, ai, audius: getAudiusActivation().active }),
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
