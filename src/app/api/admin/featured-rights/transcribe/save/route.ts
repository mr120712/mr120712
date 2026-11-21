// @polsia:user-owned — POST /api/admin/featured-rights/transcribe/save: salva il testo (rivisto
// dall'amministratore) come "<stessa cartella>/<stesso nome>.lrc" accanto a un brano in evidenza
// dichiarato in diritti.json con "testo": true. Permesso ricontrollato adesso (stesso 404 per ogni
// altro brano); nome del file ricavato SOLO dal pathname validato; testo validato con il parser
// dei testi (≤ 64 KB); un .lrc esistente si sostituisce solo con `overwrite: true` (altrimenti
// 409). Solo admin con email verificata, stessa origine, limite 'lyrics.transcribe.save'. Il nuovo
// .lrc compare nel player entro ~5 minuti (l'indice dei brani si rilegge da solo).
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isAuthorizedAdmin } from '@/lib/business/admin-account-policy';
import {
  SaveLyricsRequestSchema,
  SaveLyricsResponseSchema,
  TRANSCRIPTION_VISIBLE_WITHIN_MINUTES,
} from '@/lib/contracts/lyrics-transcription';
import {
  LRC_TOO_LARGE_MESSAGE,
  saveTranscribedLyrics,
  transcriptionRefusalResponse,
} from '@/lib/music/lyrics-transcription.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
  const parsed = SaveLyricsRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const lrcTooBig = parsed.error.issues.some(
      (issue) => issue.path[0] === 'lrc' && issue.code === 'too_big',
    );
    return failure('invalid_request', 400, {
      errors: lrcTooBig ? { lrc: LRC_TOO_LARGE_MESSAGE } : { lrc: 'Richiesta non valida.' },
    });
  }

  try {
    const outcome = await saveTranscribedLyrics({
      pathname: parsed.data.pathname,
      lrc: parsed.data.lrc,
      overwrite: parsed.data.overwrite,
      identity: `user:${access.userId}`,
    });
    if (!outcome.ok) return transcriptionRefusalResponse(outcome.refusal);
    return NextResponse.json(
      SaveLyricsResponseSchema.parse({
        saved: true,
        visibleWithinMinutes: TRANSCRIPTION_VISIBLE_WITHIN_MINUTES,
      }),
      { headers: privateHeaders },
    );
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore.
    console.error(
      '[admin/featured-rights/transcribe/save] salvataggio non riuscito:',
      error instanceof Error ? error.name : typeof error,
    );
    return failure('save_failed', 500, {
      message: 'Salvataggio non riuscito. Riprova tra poco.',
    });
  }
}
