// @polsia:user-owned — GET /api/music/audiocom/featured: le sezioni «In evidenza da audio.com» della
// Home (le collection scelte dall'amministratore, con i loro brani musicali). Uguali per tutti:
// costruite sul server con l'account collegato e tenute in cache (audiocom-collections.server.ts),
// quindi la risposta può stare qualche minuto nella cache della rete. Non fallisce mai: senza
// sezioni (nessuna scelta, nessun account, audio.com giù) risponde con un elenco vuoto.
import 'server-only';
import { NextResponse } from 'next/server';
import { AudioComHomeResponseSchema } from '@/lib/contracts/audiocom-collections';
import { getAudioComHomeSections } from '@/lib/music/audiocom-collections.server';

export const dynamic = 'force-dynamic';

const CACHE = 'public, max-age=60, s-maxage=120, stale-while-revalidate=600';

export async function GET() {
  const parsed = AudioComHomeResponseSchema.safeParse({
    sections: await getAudioComHomeSections(),
  });
  const body = parsed.success ? parsed.data : { sections: [] };
  return NextResponse.json(body, {
    headers: { 'Cache-Control': parsed.success ? CACHE : 'no-store' },
  });
}
