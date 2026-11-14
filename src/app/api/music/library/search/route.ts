// @polsia:user-owned — GET /api/music/library/search?q=…: la sezione «Le tue playlist» della
// ricerca. Cerca SOLO nella Libreria di chi chiama (playlist, Preferiti e i brani che contengono).
// Endpoint separato apposta: GET /api/music/search-all è cacheabile in CDN e condiviso fra gli
// utenti, quindi non deve mai contenere dati di un account. Qui invece: sessione obbligatoria
// (401 altrimenti), risposte sempre `private, no-store` con `Vary: Cookie` (anche 400/401/429/503),
// la stessa validazione della query e lo stesso limite di search-all (bucket `music.search`, stessa
// identità `user:<id>`): nessun limite nuovo.
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit, getRateLimitIdentity } from '@/lib/business/rate-limit.server';
import {
  LIBRARY_SEARCH_QUERY_ERROR,
  LibrarySearchQuerySchema,
  LibrarySearchResponseSchema,
} from '@/lib/contracts/library-search';
import { searchUserLibrary } from '@/lib/music/library-search.server';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

function withPrivateHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(privateHeaders)) response.headers.set(name, value);
  return response;
}

export async function GET(request: Request) {
  let user: SessionUser;
  try {
    user = await requireAuth(request);
  } catch (thrown) {
    // requireAuth lancia la risposta 401; un errore della sessione (DB giù) non è un 401.
    const unauthorized = thrown instanceof Response && thrown.status === 401;
    return NextResponse.json(
      { error: unauthorized ? 'Unauthorized' : 'library_search_unavailable' },
      { status: unauthorized ? 401 : 503, headers: privateHeaders },
    );
  }

  const parsed = LibrarySearchQuerySchema.safeParse(
    new URL(request.url).searchParams.get('q') ?? '',
  );
  if (!parsed.success) {
    return NextResponse.json(
      { errors: { q: LIBRARY_SEARCH_QUERY_ERROR } },
      { status: 400, headers: privateHeaders },
    );
  }
  const query = parsed.data;

  // Lo stesso bucket e la stessa identità della ricerca unificata (che parte insieme a questa).
  const identity = getRateLimitIdentity(user.id, request.headers);
  const limited = await enforceRateLimit('music.search', identity);
  if (limited) return withPrivateHeaders(limited);

  try {
    const result = await searchUserLibrary(user.id, query);
    return NextResponse.json(LibrarySearchResponseSchema.parse({ query, ...result }), {
      headers: privateHeaders,
    });
  } catch {
    return NextResponse.json(
      { error: 'library_search_unavailable' },
      { status: 503, headers: privateHeaders },
    );
  }
}
