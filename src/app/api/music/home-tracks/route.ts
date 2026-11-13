// @polsia:user-owned — elenco pubblico dei "brani in evidenza" della Home: i file audio messi
// dall'amministratore direttamente nello store Vercel Blob. Sola lettura, nessun login.
import 'server-only';
import { NextResponse } from 'next/server';
import { listHomeTracks } from '@/lib/music/home-tracks.server';

export const dynamic = 'force-dynamic';

export async function GET() {
  // listHomeTracks non fa mai throw (ritorna [] su qualsiasi problema), ma per sicurezza la Home
  // non deve mai rompersi per questa sezione.
  try {
    const items = await listHomeTracks();
    return NextResponse.json(
      { items },
      {
        headers: {
          // Cache breve sulla CDN: un file aggiunto nel pannello Blob compare entro ~1 minuto.
          'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
        },
      },
    );
  } catch {
    return NextResponse.json({ items: [] });
  }
}
