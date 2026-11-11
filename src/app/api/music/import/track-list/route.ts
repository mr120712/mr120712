// @polsia:user-owned — importa un elenco di brani portato dall'utente (righe "Artista - Titolo"
// o un CSV esportato da un altro servizio) come playlist della Libreria. Nessuna API di terzi:
// ogni brano viene cercato su YouTube solo quando lo si ascolta (vedi /api/music/resolve-song).
import 'server-only';
import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { parseTrackList } from '@/lib/business/track-list-import';
import { createSongPlaylist } from '@/lib/business/track-list-import.server';
import { TrackListImportResponseSchema, TrackListImportSchema } from '@/lib/contracts/library';
import { prisma } from '@/lib/db';
import { MAX_PLAYLISTS_PER_USER } from '@/lib/music/collections.server';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

const MAX_PLAYLISTS = MAX_PLAYLISTS_PER_USER;

const privateHeaders = {
  'Cache-Control': 'private, no-store, no-cache, must-revalidate',
  Vary: 'Cookie',
};

async function signedIn(request: Request): Promise<{ user: SessionUser } | { response: Response }> {
  try {
    return { user: await requireAuth(request) };
  } catch (response) {
    return { response: response as Response };
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { error: 'forbidden_origin' },
      { status: 403, headers: privateHeaders },
    );
  }
  const auth = await signedIn(request);
  if ('response' in auth) return auth.response;
  const limited = await enforceRateLimit('library.import', `user:${auth.user.id}`);
  if (limited) return limited;
  // 300,000 characters can double or more once JSON-escaped (quotes, accents): zod is the real cap.
  const payload = await readJsonLimited(request, 1024 * 1024);
  if (!payload.ok) return limitedJsonError(payload);
  const body = TrackListImportSchema.safeParse(payload.value);
  if (!body.success) {
    return NextResponse.json(
      { errors: { text: 'Incolla un elenco di brani o carica un file CSV.' } },
      { status: 400, headers: privateHeaders },
    );
  }

  const parsed = parseTrackList(body.data.text);
  if (parsed.error === 'missing_columns') {
    return NextResponse.json(
      {
        errors: {
          text: 'Il file sembra una tabella ma non ha una colonna con il titolo del brano (es. “Track Name”, “Title”, “Titolo”). Aggiungi le colonne del titolo e dell’artista.',
        },
      },
      { status: 400, headers: privateHeaders },
    );
  }
  if (parsed.tracks.length === 0) {
    return NextResponse.json(
      {
        errors: {
          text: 'Non ho trovato brani. Usa una riga per brano, come “Artista - Titolo”, oppure un CSV con le colonne del titolo e dell’artista.',
        },
      },
      { status: 400, headers: privateHeaders },
    );
  }

  // Keep each library bounded: the whole library is loaded on every visit.
  const playlists = await prisma.userMusicCollection.count({
    where: { userId: auth.user.id, kind: 'playlist' },
  });
  if (playlists >= MAX_PLAYLISTS) {
    return NextResponse.json(
      {
        error: 'library_full',
        message: `Hai raggiunto il massimo di ${MAX_PLAYLISTS} playlist. Eliminane qualcuna per importarne altre.`,
      },
      { status: 409, headers: privateHeaders },
    );
  }

  const { collectionId, name } = await createSongPlaylist(
    auth.user.id,
    body.data.name ?? 'Playlist importata',
    parsed.tracks,
  );
  return NextResponse.json(
    TrackListImportResponseSchema.parse({
      collectionId,
      name,
      imported: parsed.tracks.length,
      skipped: parsed.skipped,
      truncated: parsed.truncated,
      format: parsed.format,
    }),
    { headers: privateHeaders },
  );
}
