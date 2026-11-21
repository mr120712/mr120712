// @polsia:user-owned — POST /api/admin/featured-rights/transcribe/refine: «Rifinisci con Solco AI»
// dalla pagina admin «Diritti e testi». La bozza dell'editor (LRC con i tempi) ripulita dal modello di
// Solco AI (punteggiatura, maiuscole, versi, errori evidenti; mai inventare o togliere) e rimessa sui
// tempi della bozza. SOLO per i brani dichiarati in diritti.json con "testo": true: stesso cancello
// della trascrizione (404 identico per ogni altro brano, nessuna chiamata al modello). Solo admin
// con email verificata, stessa origine; la bozza torna solo a chi l'ha chiesta, mai nella cache
// HTTP; il testo inviato non si conserva. Errori sul campo `lrc` (400) quando la bozza è vuota,
// senza tempi o troppo lunga; 503 senza chiave Anthropic o modello occupato; 502 se il modello
// rifiuta o cambia troppo il testo (la bozza resta com'era).
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isAuthorizedAdmin } from '@/lib/business/admin-account-policy';
import {
  RefineLyricsRequestSchema,
  RefineLyricsResponseSchema,
} from '@/lib/contracts/lyrics-transcription';
import { refineFeaturedTrackLyrics } from '@/lib/music/lyrics-refine.server';
import { transcriptionRefusalResponse } from '@/lib/music/lyrics-transcription.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
// Elenco dello store + diritti.json (cancello) + modello (≤ 90 s) + allineamento.
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
  const parsed = RefineLyricsRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (field === 'language') {
      return failure('invalid_request', 400, {
        errors: { language: 'Lingua non valida: scegli una lingua dall’elenco o «Automatica».' },
      });
    }
    if (field === 'lrc') {
      const tooBig = parsed.error.issues.some(
        (issue) => issue.path[0] === 'lrc' && issue.code === 'too_big',
      );
      return failure('invalid_request', 400, {
        errors: {
          lrc: tooBig
            ? 'La bozza supera 64 KB: accorciala prima di rifinirla.'
            : 'La bozza è vuota: trascrivi il brano prima di rifinirla.',
        },
      });
    }
    return failure('invalid_request', 400, { errors: { pathname: 'Richiesta non valida.' } });
  }

  try {
    const outcome = await refineFeaturedTrackLyrics({
      pathname: parsed.data.pathname,
      lrc: parsed.data.lrc,
      language: parsed.data.language,
      durationSeconds: parsed.data.durationSeconds,
      identity: `user:${access.userId}`,
      signal: request.signal,
    });
    if (!outcome.ok) return transcriptionRefusalResponse(outcome.refusal);
    return NextResponse.json(RefineLyricsResponseSchema.parse(outcome.result), {
      headers: privateHeaders,
    });
  } catch (error) {
    // Solo il tipo di errore nei log: niente percorsi, testo o chiavi.
    // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore.
    console.error(
      '[admin/featured-rights/transcribe/refine] rifinitura non riuscita:',
      error instanceof Error ? error.name : typeof error,
    );
    return failure('refine_failed', 500, {
      message: 'La rifinitura non è riuscita. Riprova tra poco.',
    });
  }
}
