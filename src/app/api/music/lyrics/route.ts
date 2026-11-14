// @polsia:user-owned — GET /api/music/lyrics: il TESTO di un brano per il player (stile Spotify),
// SOLO dove Solco ha i diritti di mostrarlo:
//   ?featured=<pathname> → brano in evidenza dichiarato in diritti.json con "testo": true;
//   ?upload=<id>         → upload pubblicato con il testo confermato dal suo autore.
// Mai testi da fonti di terzi (siti di testi, API esterne, sottotitoli, scraping) e mai per brani
// Audius, YouTube, radio o podcast. Serve una sessione (come l'ascolto) e c'è un limite per utente.
// "Nessun testo" e "testo non autorizzato" danno la STESSA risposta (200, { lyrics: null }): la
// route non rivela che cosa esiste nello store. Mai in cache (private, no-store).
import 'server-only';
import { NextResponse } from 'next/server';
import { consumeRateLimit, rateLimitResponse } from '@/lib/business/rate-limit.server';
import { type Lyrics, LyricsResponseSchema } from '@/lib/contracts/lyrics';
import { readFeaturedLyrics } from '@/lib/music/featured-lyrics.server';
import { isHomeAudioBlob } from '@/lib/music/home-tracks.server';
import { readPublishedUploadLyrics } from '@/lib/music/public-uploads.server';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const privateHeaders = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
};

/** Id di un upload pubblico (cuid), come nelle altre route di public-uploads. */
const UPLOAD_ID = /^[a-z0-9]{20,40}$/;

type Target = { kind: 'featured'; pathname: string } | { kind: 'upload'; id: string };

/** Esattamente UN parametro, una volta sola, valido. null = richiesta non valida. */
function readTarget(params: URLSearchParams): Target | null {
  const featured = params.getAll('featured');
  const upload = params.getAll('upload');
  if (featured.length + upload.length !== 1) return null;
  const [pathname] = featured;
  if (pathname !== undefined) {
    // Stesse regole del proxy di streaming: niente "..", percorsi assoluti, barre rovesciate,
    // caratteri di controllo, upload degli utenti (public-uploads/) o file non audio.
    return isHomeAudioBlob(pathname) ? { kind: 'featured', pathname } : null;
  }
  const [id] = upload;
  return id !== undefined && UPLOAD_ID.test(id) ? { kind: 'upload', id } : null;
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: privateHeaders });
}

export async function GET(request: Request) {
  let userId: string;
  try {
    const user = await requireAuth(request);
    userId = user.id;
  } catch (response) {
    return response as Response;
  }

  const target = readTarget(new URL(request.url).searchParams);
  if (!target) return json({ error: 'invalid_request' }, 400);

  const decision = await consumeRateLimit('music.lyrics', `user:${userId}`);
  if (!decision.allowed) return rateLimitResponse('music.lyrics', decision);

  let lyrics: Lyrics | null;
  try {
    lyrics =
      target.kind === 'featured'
        ? await readFeaturedLyrics(target.pathname)
        : await readPublishedUploadLyrics(target.id);
  } catch {
    return json({ error: 'lyrics_unavailable' }, 503);
  }
  // Una forma inattesa non arriva mai al client: meglio nessun testo.
  const parsed = LyricsResponseSchema.safeParse({ lyrics });
  return json(parsed.success ? parsed.data : { lyrics: null });
}
