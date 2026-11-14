// @polsia:user-owned — elenco pubblico dei "brani in evidenza" della Home: i file audio messi
// dall'amministratore direttamente nello store Vercel Blob. Sola lettura, nessun login.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { listHomeTrackSections } from '@/lib/music/home-tracks.server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // Ogni richiesta interroga l'API (a consumo) di Vercel Blob: come le altre letture di catalogo
  // anonime (radio/podcast), si applica il rate-limit per identità, così una cache aggirata con
  // query-string diverse non moltiplica all'infinito le chiamate a list() sullo stesso token.
  const identity = getRateLimitIdentity(null, request.headers);
  const limited = identity ? await enforceRateLimit('music.catalog', identity) : null;
  if (limited) return limited;

  // listHomeTracks non fa mai throw (ritorna [] su qualsiasi problema), ma per sicurezza la Home
  // non deve mai rompersi per questa sezione.
  try {
    const { items, sections } = await listHomeTrackSections();
    return NextResponse.json(
      { items, sections },
      {
        headers: {
          // Cache breve sulla CDN: un file aggiunto nel pannello Blob compare entro ~1 minuto.
          'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
        },
      },
    );
  } catch {
    return NextResponse.json({ items: [], sections: [] });
  }
}
