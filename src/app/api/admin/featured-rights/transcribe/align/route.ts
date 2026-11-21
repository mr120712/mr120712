// @polsia:user-owned — POST /api/admin/featured-rights/transcribe/align: il testo UFFICIALE di un
// brano in evidenza (incollato dall'admin, che ne ha i diritti) allineato ai tempi dell'audio con
// Solco AI, dalla pagina admin «Diritti e testi». SOLO per i brani dichiarati in diritti.json con
// "testo": true: permesso, limiti e cache cifrata sono quelli della trascrizione (stesso 404 per
// ogni altro brano, nessuna chiamata al motore). Solo admin con email verificata, stessa origine;
// la bozza torna solo a chi l'ha chiesta e non va mai nella cache HTTP; il testo fornito non si
// conserva. Errori sul campo `lyrics` (400) quando il testo è vuoto, troppo lungo o non trova
// riscontro nell'audio.
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isAuthorizedAdmin } from '@/lib/business/admin-account-policy';
import {
  AlignLyricsRequestSchema,
  TranscribeResponseSchema,
} from '@/lib/contracts/lyrics-transcription';
import { alignFeaturedTrackLyrics } from '@/lib/music/lyrics-align.server';
import { transcriptionRefusalResponse } from '@/lib/music/lyrics-transcription.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
// Come la trascrizione: elenco dello store + diritti.json + audio (≤ 25 MB) + Whisper (≤ 100 s).
export const maxDuration = 120;

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

function failure(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status, headers: privateHeaders });
}

type AdminAccess = { allowed: true; userId: string } | { allowed: false; response: Response };

async function requireAdmin(request: Request): Promise<AdminAccess> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return { allowed: false, response: failure('unauthorized', 401) };
    if (!isAuthorizedAdmin(session.user)) {
      return { allowed: false, response: failure('forbidden', 403) };
    }
    return { allowed: true, userId: session.user.id };
  } catch {
    return { allowed: false, response: failure('session_unavailable', 503) };
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return failure('forbidden_origin', 403);
  const access = await requireAdmin(request);
  if (!access.allowed) return access.response;

  const raw = await request.json().catch(() => null);
  const parsed = AlignLyricsRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (field === 'language') {
      return failure('invalid_request', 400, {
        errors: { language: 'Lingua non valida: scegli una lingua dall’elenco o «Automatica».' },
      });
    }
    if (field === 'lyrics') {
      const tooBig = parsed.error.issues.some(
        (issue) => issue.path[0] === 'lyrics' && issue.code === 'too_big',
      );
      return failure('invalid_request', 400, {
        errors: {
          lyrics: tooBig
            ? 'Il testo supera 64 KB: incolla solo il testo di questo brano.'
            : 'Incolla il testo del brano, una riga per verso.',
        },
      });
    }
    return failure('invalid_request', 400, { errors: { pathname: 'Richiesta non valida.' } });
  }

  try {
    const outcome = await alignFeaturedTrackLyrics({
      pathname: parsed.data.pathname,
      lyrics: parsed.data.lyrics,
      language: parsed.data.language,
      identity: `user:${access.userId}`,
      signal: request.signal,
    });
    if (!outcome.ok) return transcriptionRefusalResponse(outcome.refusal);
    return NextResponse.json(TranscribeResponseSchema.parse(outcome.result), {
      headers: privateHeaders,
    });
  } catch (error) {
    // Solo il tipo di errore nei log: niente percorsi, testo o chiavi.
    // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore.
    console.error(
      '[admin/featured-rights/transcribe/align] allineamento non riuscito:',
      error instanceof Error ? error.name : typeof error,
    );
    return failure('align_failed', 500, {
      message: 'L’allineamento non è riuscito. Riprova tra poco.',
    });
  }
}
