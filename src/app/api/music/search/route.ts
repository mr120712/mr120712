// @polsia:user-owned
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import { MusicSearchResponseSchema } from '@/lib/contracts/music';
import { getMusicSourceStatuses, searchMusic } from '@/lib/music/music-api.server';

export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store, no-cache, must-revalidate' };

export async function GET(request: Request) {
  const url = new URL(request.url);
  const source = url.searchParams.get('source');
  const query = url.searchParams.get('q')?.trim() ?? '';
  if (source !== 'audius' && source !== 'youtube') {
    return NextResponse.json({ error: 'invalid_source' }, { status: 400, headers: privateHeaders });
  }
  if (!query || query.length > 80) {
    return NextResponse.json(
      { errors: { q: 'Inserisci una ricerca da 1 a 80 caratteri.' } },
      { status: 400, headers: privateHeaders },
    );
  }
  if (source === 'youtube' && url.searchParams.get('youtubeConsent') !== 'accepted') {
    return NextResponse.json(
      { error: 'youtube_consent_required' },
      { status: 403, headers: privateHeaders },
    );
  }
  // Una fonte non configurata non consuma quota: restituisci subito lo stato
  // non disponibile anche in locale, senza intestazioni IP del proxy d'ingresso.
  if (!getMusicSourceStatuses().find((item) => item.id === source)?.active) {
    const body = MusicSearchResponseSchema.parse(await searchMusic(source, query));
    return NextResponse.json(body, { headers: privateHeaders });
  }

  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  const identity = getRateLimitIdentity(session?.user.id ?? null, request.headers);
  const limited = await enforceRateLimit('music.search', identity);
  if (limited) {
    for (const [name, value] of Object.entries(privateHeaders)) limited.headers.set(name, value);
    return limited;
  }

  try {
    const result = await searchMusic(source, query, { youtubeIdentity: identity });
    const body = MusicSearchResponseSchema.parse(result);
    return NextResponse.json(body, { headers: privateHeaders });
  } catch {
    const status = getMusicSourceStatuses({ [source]: 'unavailable' }).find(
      (item) => item.id === source,
    );
    return NextResponse.json(
      MusicSearchResponseSchema.parse({
        source,
        outcome: 'unavailable',
        tracks: [],
        artists: [],
        playlists: [],
        albums: [],
        videos: [],
        sourceStatus: {
          ...status,
          ...(source === 'youtube' ? { unavailableReason: 'api_error' } : {}),
        },
      }),
      { status: 200, headers: privateHeaders },
    );
  }
}
