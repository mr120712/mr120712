// @polsia:user-owned — brani YouTube per un genere o una playlist Solco (ricerca fissa, cache 24 h).
// Le ricerche dei generi hanno una quota propria (search:genre) dentro il budget giornaliero: a
// quota finita la pagina mostra i brani salvati se sono recenti (vedi youtube-search-store), con
// la loro data. Senza chiave API, o per il monitor automatico (User-Agent "SolcoMonitor/"), non si
// cerca su YouTube e non si consuma budget: solo i risultati salvati.
import 'server-only';
import { NextResponse } from 'next/server';
import { YouTubeMusicSearchResponseSchema } from '@/lib/contracts/youtube-search';
import { findGenre } from '@/lib/music/genre-catalog';
import { readYouTubeApiKey } from '@/lib/music/music-api.server';
import {
  withYouTubeSearchBudget,
  type YouTubeSearchLoader,
} from '@/lib/music/youtube-budget.server';
import { contractUnavailableReason, youtubeSearchNotice } from '@/lib/music/youtube-notice';
import { searchYouTubeMusic } from '@/lib/music/youtube-search.server';
import { storedYouTubeSearchWithTime } from '@/lib/music/youtube-search-store.server';

export const dynamic = 'force-dynamic';

const GENRE_RESULTS = 25;
/** Signature of the daily browser check and site check (scripts/monitor). */
const MONITOR_USER_AGENT = 'SolcoMonitor/';

function unavailable(reason: 'not_configured' | 'api_error'): YouTubeSearchLoader {
  return async () => ({ outcome: 'unavailable', videos: [], unavailableReason: reason });
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const genre = findGenre(slug);
  if (!genre) return NextResponse.json({ error: 'genre_not_found' }, { status: 404 });
  const apiKey = readYouTubeApiKey();
  // Monitoring must never spend a search (100 units) or a re-check: saved results only.
  const monitor = request.headers.get('user-agent')?.includes(MONITOR_USER_AGENT) ?? false;
  const load = !apiKey
    ? unavailable('not_configured')
    : monitor
      ? unavailable('api_error')
      : withYouTubeSearchBudget((term, size) => searchYouTubeMusic(term, apiKey, fetch, size), {
          purpose: 'genre',
        });
  const stored = await storedYouTubeSearchWithTime(
    genre.query,
    GENRE_RESULTS,
    load,
    monitor ? { recheck: null } : {},
  );
  const { result } = stored;
  const unavailableReason = contractUnavailableReason(result.unavailableReason);
  const body = {
    source: 'youtube' as const,
    outcome: result.outcome,
    tracks: [],
    artists: [],
    playlists: [],
    albums: [],
    videos: result.videos,
    sourceStatus: {
      id: 'youtube' as const,
      label: 'YouTube',
      active: result.outcome !== 'unavailable',
      searchOutcome: result.outcome,
      ...(unavailableReason ? { unavailableReason } : {}),
      summary: 'Video musicali da YouTube.',
      prerequisite: 'YOUTUBE_DATA_API_KEY',
    },
    youtube: youtubeSearchNotice(stored),
  };
  return NextResponse.json(YouTubeMusicSearchResponseSchema.parse(body), {
    headers: {
      // The database already limits YouTube to one search per genre per day; the edge keeps a
      // copy for 1 h only, so results shown as current are never much older than 24 h.
      'Cache-Control':
        result.outcome === 'unavailable' || monitor
          ? 'no-store'
          : result.outcome === 'no_results' || stored.stale
            ? // An empty page, or saved results, should not stay at the edge for long.
              'public, max-age=300, s-maxage=900'
            : 'public, max-age=600, s-maxage=3600',
    },
  });
}
