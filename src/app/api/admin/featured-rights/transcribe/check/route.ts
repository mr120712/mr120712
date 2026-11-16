// @polsia:user-owned — POST /api/admin/featured-rights/transcribe/check: «Verifica chiave OpenAI»
// dalla pagina admin «Diritti e testi». Invia a Whisper un secondo di silenzio generato sul server
// (nessun brano dello store, costo di circa un centesimo di centesimo) con la stessa richiesta della
// trascrizione e risponde se la chiave funziona (200), se manca su Vercel (503
// transcription_not_configured) o perché no (openai_invalid_key, openai_no_credit,
// openai_rate_limited, openai_unavailable, openai_no_response: gli stessi codici della trascrizione,
// mai la chiave né il testo di OpenAI). Solo admin con email verificata, stessa origine, limite
// 'lyrics.transcribe.check' per admin (consumato solo con la chiave presente); risposta privata,
// mai in cache.
import 'server-only';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { consumeRateLimit, rateLimitResponse } from '@/lib/business/rate-limit.server';
import { TranscriptionCheckResponseSchema } from '@/lib/contracts/lyrics-transcription';
import { transcriptionRefusalResponse } from '@/lib/music/lyrics-transcription.server';
import { openAiApiKey, probeMessage, probeWhisper } from '@/lib/music/whisper.server';
import { sameOrigin } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';
/** La prova a OpenAI dura al massimo 20 secondi. */
export const maxDuration = 30;

const privateHeaders = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };

function failure(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status, headers: privateHeaders });
}

type AdminAccess = { allowed: true; userId: string } | { allowed: false; response: Response };

async function requireAdmin(request: Request): Promise<AdminAccess> {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return { allowed: false, response: failure('unauthorized', 401) };
    if (session.user.role !== 'admin' || session.user.emailVerified !== true) {
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

  const apiKey = openAiApiKey();
  if (!apiKey) return transcriptionRefusalResponse({ kind: 'not_configured' });

  const decision = await consumeRateLimit('lyrics.transcribe.check', `user:${access.userId}`);
  if (!decision.allowed) {
    const response = rateLimitResponse('lyrics.transcribe.check', decision);
    response.headers.set('Vary', 'Cookie');
    return response;
  }

  const probe = await probeWhisper({ apiKey, signal: request.signal });
  if (!probe.ok) {
    // Solo il codice nei log: niente chiave, niente testo di OpenAI.
    // biome-ignore lint/suspicious/noConsole: log del server con il solo codice dell'esito.
    console.warn(`[admin/featured-rights/transcribe/check] chiave OpenAI: ${probe.error}`);
    return transcriptionRefusalResponse({
      kind: 'whisper',
      error: probe.error,
      message: probeMessage(probe.message),
    });
  }
  return NextResponse.json(
    TranscriptionCheckResponseSchema.parse({
      ok: true,
      model: probe.model,
      elapsedMs: probe.elapsedMs,
      checkedAt: new Date().toISOString(),
    }),
    { headers: privateHeaders },
  );
}
