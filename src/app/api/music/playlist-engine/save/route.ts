// @polsia:user-owned — «Salva nella Libreria» di «Crea playlist»: crea la playlist con tutti i
// brani della bozza in una sola scrittura. Stessi limiti delle raccolte (100 playlist, 500 elementi,
// nessun doppione), uguali per Free e Pro. I "song" sono quelli dell'importazione di un elenco
// (cercati su YouTube solo all'ascolto), i brani Audius entrano solo con la firma del server.
import 'server-only';
import { NextResponse } from 'next/server';
import { savePlaylistDraft } from '@/lib/business/playlist-engine.server';
import { enforceRateLimit } from '@/lib/business/rate-limit.server';
import { limitedJsonError, readJsonLimited } from '@/lib/business/request-body.server';
import { PLAYLIST_DESCRIPTION_TOO_LONG } from '@/lib/contracts/music';
import { SaveRequestSchema, SaveResponseSchema } from '@/lib/contracts/playlist-engine';
import { isFavoritesName, MAX_PLAYLISTS_PER_USER } from '@/lib/music/collections.server';
import { requireAuth, type SessionUser } from '@/lib/require-auth';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

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

/** Il campo del modulo per un errore di validazione (nome e descrizione tornano sul modulo). */
function fieldError(path: readonly (string | number)[], message: string) {
  const field = path[0];
  if (field === 'name') return { name: message };
  if (field === 'description') {
    return {
      description:
        message === PLAYLIST_DESCRIPTION_TOO_LONG
          ? message
          : 'Scrivi la descrizione come testo semplice, oppure lasciala vuota.',
    };
  }
  if (field === 'tracks' && path.length === 1) return { tracks: message };
  return { tracks: 'Alcuni brani della bozza non sono validi: ricrea la bozza e riprova.' };
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
  const limited = await enforceRateLimit('playlist.engine.save', `user:${auth.user.id}`);
  if (limited) return limited;
  // 50 brani con i metadati Audius, le firme e titoli non latini stanno larghi in 256 KB.
  const payload = await readJsonLimited(request, 256 * 1024);
  if (!payload.ok) return limitedJsonError(payload);
  const parsed = SaveRequestSchema.safeParse(payload.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { errors: fieldError(issue?.path ?? [], issue?.message ?? 'Controlla i dati e riprova.') },
      { status: 400, headers: privateHeaders },
    );
  }
  if (isFavoritesName(parsed.data.name)) {
    return NextResponse.json(
      { errors: { name: 'Il nome «Preferiti» è riservato: scegline un altro.' } },
      { status: 400, headers: privateHeaders },
    );
  }

  try {
    const outcome = await savePlaylistDraft(auth.user.id, {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      tracks: parsed.data.tracks,
    });
    if (!outcome.ok) {
      return outcome.error === 'limit_reached'
        ? NextResponse.json(
            {
              error: 'limit_reached',
              message: `Hai raggiunto il limite di ${MAX_PLAYLISTS_PER_USER} playlist. Eliminane una per salvarne una nuova.`,
            },
            { status: 409, headers: privateHeaders },
          )
        : NextResponse.json(
            {
              errors: {
                tracks:
                  'I brani della bozza non sono più validi (la bozza ha più di una settimana?). Ricreala e riprova.',
              },
            },
            { status: 400, headers: privateHeaders },
          );
    }
    return NextResponse.json(
      SaveResponseSchema.parse({
        collectionId: outcome.collectionId,
        name: outcome.name,
        saved: outcome.saved,
        skipped: outcome.skipped,
      }),
      { status: 201, headers: privateHeaders },
    );
  } catch {
    return NextResponse.json(
      {
        error: 'save_unavailable',
        message: 'Non sono riuscito a salvare la playlist. Riprova tra poco: la bozza resta qui.',
      },
      { status: 503, headers: privateHeaders },
    );
  }
}
