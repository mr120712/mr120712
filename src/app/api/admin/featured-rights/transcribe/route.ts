// @polsia:user-owned — POST /api/admin/featured-rights/transcribe: bozza LRC del testo di un brano in
// evidenza con OpenAI Whisper, dalla pagina admin «Diritti e testi». SOLO per i brani dichiarati
// in diritti.json con "testo": true (permesso ricontrollato adesso, mai dalla cache): per ogni
// altro brano la risposta è sempre lo stesso 404, senza chiamare OpenAI né consumare limiti.
// Solo admin con email verificata, stessa origine; la bozza torna solo a chi l'ha chiesta e non
// va mai nella cache HTTP. Limiti 'lyrics.transcribe' (per admin) e 'lyrics.transcribe.global',
// contati solo quando la chiamata a OpenAI parte davvero.
// Ogni bozza pagata si conserva CIFRATA sul server e si riusa per la stessa versione del file
// (fromCache: true, cachedAt): niente lettura dell'audio, niente OpenAI, nessun limite consumato.
// La cache si consulta solo DOPO permesso, formato e dimensione. `regenerate: true` (dopo la
// conferma dell'admin) la ignora, rifà la trascrizione e la sostituisce.
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isAuthorizedAdmin } from '@/lib/business/admin-account-policy';
import {
  TranscribeRequestSchema,
  TranscribeResponseSchema,
} from '@/lib/contracts/lyrics-transcription';
import {
  transcribeFeaturedTrack,
  transcriptionRefusalResponse,
} from '@/lib/music/lyrics-transcription.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
// Elenco dello store + diritti.json + lettura dell'audio (≤ 25 MB) + Whisper (≤ 100 s).
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
  const parsed = TranscribeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const languageIssue = parsed.error.issues.some((issue) => issue.path[0] === 'language');
    return failure('invalid_request', 400, {
      errors: languageIssue
        ? { language: 'Lingua non valida: scegli una lingua dall’elenco o «Automatica».' }
        : { pathname: 'Richiesta non valida.' },
    });
  }

  try {
    const outcome = await transcribeFeaturedTrack({
      pathname: parsed.data.pathname,
      language: parsed.data.language,
      identity: `user:${access.userId}`,
      signal: request.signal,
      regenerate: parsed.data.regenerate === true,
    });
    if (!outcome.ok) return transcriptionRefusalResponse(outcome.refusal);
    return NextResponse.json(TranscribeResponseSchema.parse(outcome.result), {
      headers: privateHeaders,
    });
  } catch (error) {
    // Solo il tipo di errore nei log: niente percorsi, testo o chiavi.
    // biome-ignore lint/suspicious/noConsole: log del server col solo nome dell'errore.
    console.error(
      '[admin/featured-rights/transcribe] trascrizione non riuscita:',
      error instanceof Error ? error.name : typeof error,
    );
    return failure('transcription_failed', 500, {
      message: 'La trascrizione non è riuscita. Riprova tra poco.',
    });
  }
}
